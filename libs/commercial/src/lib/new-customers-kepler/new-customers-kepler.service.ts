import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantContextService, TenantKnexService, branchKeySql } from '@megadulces/platform-core';
import type {
  KeplerCustomerLookup,
  LinkKeplerResponse,
  NewCustomerOrder,
  NewCustomerRow,
  NewCustomersInboxResponse,
  NewCustomersSummary,
  SimilarCustomersResponse,
} from '@megadulces/contracts';
import {
  buscarParecidos,
  codigoKepler,
  decidirLiga,
  domicilioLegible,
  normalizarClave,
  normalizarNombre,
  tokensSignificativos,
  type DecisionLiga,
  type HechosLiga,
} from './new-customers-kepler.engine';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Mismo alcance que el surtido de preventa: la bandeja es de quien surte la sucursal. */
const AREA = 'warehouse/new-customers';
/** Tope de la bandeja. Si se topa, la respuesta lo dice (`truncated`), no se esconde. */
const MAX_BANDEJA = 500;
/** Estados de un pedido que todavía no se entrega ni se cancela. */
const PENDIENTES = `('pending_approval', 'confirmed')`;

/**
 * Sucursal (almacén) de un cliente de la Suite, de lo más firme a lo menos:
 *  1. ya ligado a Kepler → el almacén de esa sucursal;
 *  2. su ruta de venta → la sucursal que surte esa ruta (`commercial.route_warehouses`);
 *  3. su pedido más reciente → el almacén de ese pedido.
 * Sin ninguna de las tres, NULL: no se sabe y se declara.
 */
export const SUCURSAL_CLIENTE_SQL = (c = 'c'): string => `COALESCE(
    (SELECT w0.id FROM commercial.warehouses w0
      WHERE ${c}.erp_source_branch IS NOT NULL AND w0.deleted_at IS NULL
        AND (${branchKeySql('w0')}) = ${c}.erp_source_branch
      ORDER BY (w0.code ~ '^[0-9]{2}$') DESC LIMIT 1),
    (SELECT rw.warehouse_id FROM trade.catalogs r
       JOIN commercial.route_warehouses rw ON rw.route_id = r.id AND rw.tenant_id = r.tenant_id
      WHERE ${c}.sales_route IS NOT NULL AND r.catalog_id = 'rutas' AND r.deleted_at IS NULL
        AND upper(r.value) = upper(${c}.sales_route)
      LIMIT 1),
    (SELECT o0.warehouse_id FROM commercial.orders o0
      WHERE o0.customer_id = ${c}.id AND o0.warehouse_id IS NOT NULL
      ORDER BY o0.created_at DESC LIMIT 1))`;

type FilaBandeja = {
  id: string; name: string; phone: string | null; notes: string | null; shipping_address: unknown;
  sales_route: string | null; created_at: Date | string; created_by_name: string | null;
  warehouse_id: string | null; warehouse_name: string | null; branch: string | null;
  orders: Array<Record<string, unknown>> | null;
};

type FilaCliente = {
  id: string; name: string; code: string; erp_customer_code: string | null; erp_source_branch: string | null;
  warehouse_id: string | null; branch: string | null;
};

type FilaKepler = {
  nombre: string | null; direccion: string | null; ciudad: string | null; estado: string | null;
  codigo_postal: string | null; limite_credito: string | number | null; plazo_dias: string | number | null;
  es_interno: boolean;
};

/**
 * `[MCP.3.8]` Cliente nuevo: alta en la Suite y liga con Kepler.
 *
 *  · Vendedor: antes de crear, «¿Es este?» con los clientes de su sucursal de nombre parecido.
 *  · Surtidor / caja: la bandeja de clientes nuevos sin clave de Kepler de su sucursal; teclean la
 *    clave que le dieron en Kepler, se busca en el ODS (`analytics.v_customer_master`, que deriva
 *    de `kepler_ods.kdud` por (sucursal, clave)) y al ligar la MISMA fila toma los datos de Kepler.
 *
 * Cero importers y cero copias: Kepler se LEE del ODS; la liga son dos columnas que ya existían
 * (`erp_source_branch`, `erp_customer_code`, `[VK.3]`) con su índice único.
 */
@Injectable()
export class NewCustomersKeplerService {
  private readonly logger = new Logger(NewCustomersKeplerService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
  ) {}

  // ───────────────────────────── Vendedor: «¿Es este?» ─────────────────────────────

  async similar(nameRaw: unknown): Promise<SimilarCustomersResponse> {
    const name = String(nameRaw ?? '').trim();
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión.');
    const tokens = tokensSignificativos(name);
    return this.tk.run(async (trx) => {
      const suc = await this.sucursalDelVendedor(trx, me);
      const base: SimilarCustomersResponse = {
        scope: suc ? 'sucursal' : 'todas',
        warehouse_name: suc?.name ?? null,
        matches: [],
      };
      // Sin una palabra que distinga (p. ej. sólo «Abarrotes») no hay con qué comparar.
      if (!normalizarNombre(name) || !tokens.length) return base;

      // Prefiltro barato en la base (un trozo de cada palabra); la decisión la toma el motor.
      const likes = tokens.map((t) => `%${t.slice(0, 4)}%`);
      const filtroNombre = likes.map(() => `public.f_unaccent(lower(c.name)) LIKE ?`).join(' OR ');
      const params: Array<string | null> = [...likes];
      let filtroSucursal = '';
      if (suc) {
        filtroSucursal = `AND ((${SUCURSAL_CLIENTE_SQL('c')}) = ? OR c.erp_source_branch = ?)`;
        params.push(suc.id, suc.branch);
      }
      const { rows } = await trx.raw(
        `/* mcp38:parecidos */
         SELECT c.id, c.name, c.phone, c.notes, c.shipping_address, c.sales_route,
                (c.erp_customer_code IS NOT NULL) AS kepler
           FROM commercial.customers c
          WHERE c.deleted_at IS NULL AND (${filtroNombre}) ${filtroSucursal}
          LIMIT 300`,
        params,
      );
      const parecidos = buscarParecidos(name, rows as Array<Record<string, unknown> & { name: string }>);
      base.matches = parecidos.map((r) => ({
        id: String(r['id']),
        name: r.name,
        address: domicilioLegible(r['shipping_address'], r['notes'] as string | null),
        phone: (r['phone'] as string | null) ?? null,
        sales_route: (r['sales_route'] as string | null) ?? null,
        kepler: !!r['kepler'],
        score: r.score,
      }));
      return base;
    });
  }

  /**
   * Sucursal del vendedor: la de la ruta que trabaja hoy (escogida por el supervisor → agenda de
   * hoy → cualquiera de su agenda → su ruta de ficha) vía `route_warehouses`; si su ruta no tiene
   * sucursal, la de su ficha (`warehouse_code`). La misma cadena que `myStockSources`.
   */
  private async sucursalDelVendedor(
    trx: Knex.Transaction,
    me: string,
  ): Promise<{ id: string; name: string; branch: string | null } | null> {
    const { rows } = await trx.raw(
      `/* mcp38:sucursal-vendedor */
       WITH u AS (SELECT route_id, warehouse_code FROM identity.users WHERE id = ?),
       r AS (
         SELECT COALESCE(
           (SELECT p.route_id FROM commercial.vendor_route_day_picks p
             WHERE p.user_id = ? AND p.deleted_at IS NULL
               AND p.work_date = (now() AT TIME ZONE 'America/Mexico_City')::date LIMIT 1),
           (SELECT da.route_id FROM public.daily_assignments da WHERE da.user_id = ?
             ORDER BY (da.day_of_week = EXTRACT(ISODOW FROM (now() AT TIME ZONE 'America/Mexico_City'))::int) DESC
             LIMIT 1),
           (SELECT route_id FROM u)) AS route_id
       ),
       rw AS (SELECT rw.warehouse_id FROM commercial.route_warehouses rw WHERE rw.route_id = (SELECT route_id FROM r) LIMIT 1)
       SELECT w.id, w.name, (${branchKeySql('w')}) AS branch
         FROM commercial.warehouses w
        WHERE w.deleted_at IS NULL
          AND (w.id = (SELECT warehouse_id FROM rw)
               OR (NOT EXISTS (SELECT 1 FROM rw)
                   AND w.kepler_code = (SELECT warehouse_code FROM u) AND w.kind = 'central' AND w.active))
        LIMIT 1`,
      [me, me, me],
    );
    const w = rows?.[0];
    return w ? { id: String(w.id), name: String(w.name), branch: w.branch ?? null } : null;
  }

  // ───────────────────────────── Surtidor / caja: la bandeja ─────────────────────────────

  async inbox(query: Record<string, unknown> = {}): Promise<NewCustomersInboxResponse> {
    const almacenes = await this.scope.warehouseIds(query, AREA);
    if (almacenes !== null && almacenes.length === 0) return { scope: 'ninguno', data: [], truncated: false };
    return this.tk.run(async (trx) => {
      const filas = await this.leerBandeja(trx, almacenes);
      const truncated = filas.length > MAX_BANDEJA;
      return {
        scope: almacenes === null ? 'todos' : 'propios',
        data: filas.slice(0, MAX_BANDEJA).map((f) => this.aRenglon(f)),
        truncated,
      };
    });
  }

  /** Para el aviso de Surtir: cuántos clientes faltan por ligar y qué pedidos son suyos. */
  async summary(query: Record<string, unknown> = {}): Promise<NewCustomersSummary> {
    const r = await this.inbox(query);
    return {
      scope: r.scope,
      customers: r.data.length,
      order_ids: r.data.flatMap((c) => c.orders.map((o) => o.order_id)),
    };
  }

  private async leerBandeja(trx: Knex.Transaction, almacenes: string[] | null): Promise<FilaBandeja[]> {
    const filtro = almacenes === null ? '' : 'WHERE b.warehouse_id = ANY(?)';
    const { rows } = await trx.raw(
      `/* mcp38:bandeja */
       WITH base AS (
         SELECT c.id, c.name, c.phone, c.notes, c.shipping_address, c.sales_route, c.created_at, c.created_by,
                (${SUCURSAL_CLIENTE_SQL('c')}) AS warehouse_id
           FROM commercial.customers c
          WHERE c.deleted_at IS NULL AND c.erp_customer_code IS NULL AND c.code LIKE 'V-%'
       )
       SELECT b.id, b.name, b.phone, b.notes, b.shipping_address, b.sales_route, b.created_at, b.warehouse_id,
              w.name AS warehouse_name, (${branchKeySql('w')}) AS branch,
              coalesce(nullif(btrim(u.nombre), ''), u.username) AS created_by_name,
              (SELECT json_agg(json_build_object(
                        'order_id', o.id, 'code', o.code, 'status', o.status, 'total', o.total,
                        'requested_delivery_date', to_char(o.requested_delivery_date, 'YYYY-MM-DD'))
                      ORDER BY o.created_at)
                 FROM commercial.orders o
                WHERE o.customer_id = b.id AND o.status IN ${PENDIENTES}) AS orders
         FROM base b
         LEFT JOIN commercial.warehouses w ON w.id = b.warehouse_id
         LEFT JOIN identity.users u ON u.id = b.created_by
         ${filtro}
        ORDER BY EXISTS (SELECT 1 FROM commercial.orders o2 WHERE o2.customer_id = b.id AND o2.status IN ${PENDIENTES}) DESC,
                 b.created_at DESC
        LIMIT ${MAX_BANDEJA + 1}`,
      almacenes === null ? [] : [almacenes],
    );
    return rows as FilaBandeja[];
  }

  private aRenglon(f: FilaBandeja): NewCustomerRow {
    const orders: NewCustomerOrder[] = (f.orders ?? []).map((o) => ({
      order_id: String(o['order_id']),
      code: String(o['code'] ?? ''),
      status: String(o['status'] ?? ''),
      // numeric de Postgres llega como string: se convierte antes de que alguien lo formatee.
      total: Number(o['total']) || 0,
      requested_delivery_date: (o['requested_delivery_date'] as string | null) ?? null,
    }));
    return {
      id: f.id,
      name: f.name,
      phone: f.phone ?? null,
      address: domicilioLegible(f.shipping_address, f.notes),
      sales_route: f.sales_route ?? null,
      warehouse_id: f.warehouse_id ?? null,
      warehouse_name: f.warehouse_name ?? null,
      branch: f.branch ?? null,
      created_at: f.created_at instanceof Date ? f.created_at.toISOString() : String(f.created_at),
      created_by_name: f.created_by_name ?? null,
      orders,
    };
  }

  // ───────────────────────────── Buscar la clave y ligar ─────────────────────────────

  /** Lo que Kepler tiene con esa clave en la sucursal del cliente (para confirmar antes de ligar). */
  async lookup(customerId: string, codeRaw: unknown, query: Record<string, unknown> = {}): Promise<KeplerCustomerLookup> {
    if (!UUID_RE.test(customerId)) throw new BadRequestException('id inválido');
    const almacenes = await this.scope.warehouseIds(query, AREA);
    return this.tk.run(async (trx) => {
      const { hechos, kepler } = await this.juntarHechos(trx, customerId, codeRaw, almacenes, false);
      const d = decidirLiga(hechos);
      // Lo que sí se contesta como dato (no como error): que no exista, que sea interna o que ya
      // esté ligada a otro. Lo demás (cliente ajeno, ya ligado, clave mal escrita) es error.
      if (!d.ok && !['clave_inexistente', 'cuenta_interna', 'duplicado'].includes(d.motivo)) this.lanzar(d);
      return {
        branch: hechos.branch as string,
        code: hechos.clave as string,
        found: !!kepler,
        name: kepler?.nombre ?? null,
        address: kepler ? [kepler.direccion, kepler.ciudad].filter(Boolean).join(', ') || null : null,
        internal: !!kepler?.es_interno,
        linked_to: hechos.yaLigadoA,
      };
    });
  }

  /**
   * Liga el cliente con su clave de Kepler. La MISMA fila toma nombre, crédito, plazo y domicilio
   * de Kepler (como lo hace la sincronización de rutas `[VK.2]`); sus pedidos y visitas no se
   * mueven porque cuelgan del mismo `id`. El código pasa a `K<sucursal>-<clave>` si está libre.
   */
  async link(customerId: string, codeRaw: unknown, query: Record<string, unknown> = {}): Promise<LinkKeplerResponse> {
    if (!UUID_RE.test(customerId)) throw new BadRequestException('id inválido');
    const me = this.tenantCtx.get()?.userId;
    if (!me) throw new UnauthorizedException('Sin usuario en la sesión: ligar necesita a alguien que firme.');
    const almacenes = await this.scope.warehouseIds(query, AREA);
    if (almacenes !== null && almacenes.length === 0) throw new ForbiddenException('Tu usuario no tiene una sucursal asignada.');

    return this.tk.run(async (trx) => {
      const { hechos, kepler, cliente } = await this.juntarHechos(trx, customerId, codeRaw, almacenes, true);
      const d = decidirLiga(hechos);
      if (!d.ok) this.lanzar(d);
      const k = kepler as FilaKepler;
      const branch = hechos.branch as string;
      const clave = hechos.clave as string;
      const domicilio = this.domicilioKepler(k);
      try {
        const { rows } = await trx.raw(
          `/* mcp38:ligar */
           UPDATE commercial.customers c
              SET erp_source_branch = ?,
                  erp_customer_code = ?,
                  name = left(?, 200),
                  credit_limit = COALESCE(?::numeric, 0),
                  payment_terms_days = COALESCE(?::numeric, 0)::int,
                  shipping_address = COALESCE(?::jsonb, c.shipping_address),
                  code = CASE WHEN EXISTS (SELECT 1 FROM commercial.customers x WHERE x.code = ? AND x.id <> c.id)
                              THEN c.code ELSE ? END,
                  updated_at = now(),
                  updated_by = ?
            WHERE c.id = ? AND c.erp_customer_code IS NULL AND c.deleted_at IS NULL
            RETURNING c.id, c.name, c.code`,
          [
            branch, clave, k.nombre ?? cliente!.name,
            k.limite_credito ?? null, k.plazo_dias ?? null,
            domicilio ? JSON.stringify(domicilio) : null,
            codigoKepler(branch, clave), codigoKepler(branch, clave),
            me, customerId,
          ],
        );
        const fila = rows?.[0];
        // Otra persona lo ligó entre la lectura y la escritura.
        if (!fila) throw new ConflictException('Alguien más acaba de ligar este cliente. Recarga la lista.');
        const { rows: ped } = await trx.raw(
          `/* mcp38:pendientes */ SELECT count(*)::int AS n FROM commercial.orders o
            WHERE o.customer_id = ? AND o.status IN ${PENDIENTES}`,
          [customerId],
        );
        this.logger.log(`[MCP.3.8] cliente ${customerId} ligado a Kepler ${branch}/${clave} por ${me}`);
        return {
          id: String(fila.id),
          name: String(fila.name),
          previous_name: cliente!.name,
          code: String(fila.code),
          branch,
          erp_customer_code: clave,
          pending_orders: Number(ped?.[0]?.n) || 0,
        };
      } catch (e: unknown) {
        // El índice único `ux_customers_erp_link` es el árbitro final: dos personas ligando la misma
        // clave a dos clientes a la vez.
        if ((e as { code?: string })?.code === '23505') {
          throw new ConflictException(`La clave ${clave} ya está ligada a otro cliente. Puede ser un cliente duplicado.`);
        }
        throw e;
      }
    });
  }

  private async juntarHechos(
    trx: Knex.Transaction,
    customerId: string,
    codeRaw: unknown,
    almacenes: string[] | null,
    bloquear: boolean,
  ): Promise<{ hechos: HechosLiga; kepler: FilaKepler | null; cliente: FilaCliente | null }> {
    const { rows } = await trx.raw(
      `/* mcp38:cliente */
       SELECT c.id, c.name, c.code, c.erp_customer_code, c.erp_source_branch,
              w.id AS warehouse_id, (${branchKeySql('w')}) AS branch
         FROM commercial.customers c
         LEFT JOIN commercial.warehouses w ON w.id = (${SUCURSAL_CLIENTE_SQL('c')})
        WHERE c.id = ? AND c.deleted_at IS NULL
        ${bloquear ? 'FOR UPDATE OF c' : ''}`,
      [customerId],
    );
    const cliente = (rows?.[0] as FilaCliente | undefined) ?? null;
    const branch = cliente?.branch ?? null;
    const enAlcance = !!cliente && (almacenes === null || (!!cliente.warehouse_id && almacenes.includes(cliente.warehouse_id)));
    const clave = normalizarClave(codeRaw);

    let kepler: FilaKepler | null = null;
    let yaLigadoA: { id: string; name: string } | null = null;
    // Sólo se consulta Kepler si lo anterior pasó: no se le enseña a nadie lo de otra sucursal.
    if (cliente && enAlcance && !cliente.erp_customer_code && branch && clave) {
      const k = await trx.raw(
        `/* mcp38:kepler */
         SELECT m.nombre, m.direccion, m.ciudad, m.estado, m.codigo_postal, m.limite_credito, m.plazo_dias, m.es_interno
           FROM analytics.v_customer_master m
          WHERE m.fuente_sucursal = ? AND m.cliente_code = ?
          LIMIT 1`,
        [branch, clave],
      );
      kepler = (k.rows?.[0] as FilaKepler | undefined) ?? null;
      const l = await trx.raw(
        `/* mcp38:ligado */
         SELECT x.id, x.name FROM commercial.customers x
          WHERE x.erp_source_branch = ? AND x.erp_customer_code = ? AND x.deleted_at IS NULL AND x.id <> ?
          LIMIT 1`,
        [branch, clave, customerId],
      );
      const otro = l.rows?.[0];
      yaLigadoA = otro ? { id: String(otro.id), name: String(otro.name) } : null;
    }
    return {
      cliente,
      kepler,
      hechos: {
        cliente: cliente
          ? { id: cliente.id, name: cliente.name, erp_customer_code: cliente.erp_customer_code, erp_source_branch: cliente.erp_source_branch }
          : null,
        branch,
        enAlcance,
        clave,
        kepler: kepler ? { nombre: kepler.nombre, es_interno: !!kepler.es_interno } : null,
        yaLigadoA,
      },
    };
  }

  /** Domicilio de Kepler en la forma de `AddressJsonb`, declarando su origen. Nada → null. */
  private domicilioKepler(k: FilaKepler): Record<string, string> | null {
    const d: Record<string, string> = {};
    if (k.direccion) d['street'] = k.direccion;
    if (k.ciudad) d['neighborhood'] = k.ciudad;
    if (k.estado) d['state'] = k.estado;
    if (k.codigo_postal && /^[0-9]{5}$/.test(k.codigo_postal)) d['zip'] = k.codigo_postal;
    if (!Object.keys(d).length) return null;
    d['source'] = 'kepler';
    return d;
  }

  private lanzar(d: Exclude<DecisionLiga, { ok: true }>): never {
    switch (d.motivo) {
      case 'no_encontrado':
      case 'fuera_de_alcance':
        // Mismo 404 para los dos: no se confirma que exista un cliente de otra sucursal.
        throw new NotFoundException('No se encontró el cliente en tu sucursal.');
      case 'ya_ligado':
      case 'duplicado':
        throw new ConflictException(d.mensaje);
      default:
        throw new BadRequestException(d.mensaje);
    }
  }
}
