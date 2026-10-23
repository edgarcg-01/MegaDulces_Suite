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
import { ScopeService, TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type {
  PresalePickDetail,
  PresalePickFinishRequest,
  PresalePickFinishResponse,
  PresalePickInboxResponse,
  PresalePickInboxRow,
  PresalePickLine,
  PresalePickReport,
  PresalePickState,
  PresaleSellerOrder,
  PresaleSellerStatusResponse,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import { CommercialOrdersService } from '../commercial-orders/commercial-orders.service';
import { PresaleControlService } from '../presale-control/presale-control.service';
import { AlertsService } from '../commercial-alerts/alerts.service';
import { CommercialPushService } from '../commercial-push/commercial-push.service';
import {
  CierreInvalido,
  type PlanCierre,
  armarReporte,
  cantidadMostrada,
  detectarCobro,
  pestanaDe,
  planearCierre,
  sumarDias,
} from './presale-picking.engine';
import { PEDIDO_EN_RUTA_SQL } from './presale-route.engine';

/**
 * `[MCP.3.13]` Pedido agrupado, en SQL sobre `o` = `commercial.orders`: folio del principal, partes
 * vivas y la etiqueta corta de las sucursales de las OTRAS partes. Suelto (`group_id` NULL) → NULL,
 * NULL y `{}`. Las partes canceladas no cuentan: ya no se surten en ningún lado.
 */
const GRUPO_SELECT_SQL = [
  `(SELECT m.code FROM commercial.orders m WHERE m.tenant_id = o.tenant_id AND m.id = o.group_id) AS group_code`,
  `CASE WHEN o.group_id IS NULL THEN NULL ELSE (SELECT count(*) FROM commercial.orders g
     WHERE g.tenant_id = o.tenant_id AND g.group_id = o.group_id AND g.deleted_at IS NULL AND g.status <> 'cancelled')::int END AS group_parts`,
  `CASE WHEN o.group_id IS NULL THEN ARRAY[]::text[] ELSE ARRAY(
     SELECT DISTINCT coalesce(nullif(btrim(gw.short_label), ''), gw.name)
       FROM commercial.orders g
       JOIN commercial.warehouses gw ON gw.id = g.warehouse_id AND gw.tenant_id = g.tenant_id
      WHERE g.tenant_id = o.tenant_id AND g.group_id = o.group_id AND g.deleted_at IS NULL
        AND g.status <> 'cancelled' AND g.warehouse_id <> o.warehouse_id
      ORDER BY 1) END AS group_other_warehouses`,
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ventana de la bandeja: lo atrasado de más de 30 días ya no es surtido, es limpieza de la mesa. */
const DIAS_ATRAS = 30;
/** Un pedido cerrado sigue en la bandeja de su día para que el surtidor vea lo que ya hizo. */
const DIAS_CERRADOS = 1;
/** Detectar el cobro consulta el ODS por pedido: sólo para los más recientes de la vendedora. */
const MAX_DETECCIONES = 12;
const AREA = 'warehouse/presale-picking';

/** Lo que se lee de `commercial.order_lines` (los numeric de Postgres llegan como string). */
type FilaRenglon = {
  id: string; product_id: string; quantity: string | number; qty_unit: string | null;
  qty_factor: string | number | null; line_total?: string | number; sku?: string | null; barcode?: string | null; product_name: string | null;
};

/** Una fila de `commercial.presale_picks`. */
type FilaPick = {
  id: string; order_id: string; started_by: string; started_by_name: string; started_at: Date | string;
  finished_by: string | null; finished_by_name: string | null; finished_at: Date | string | null;
  outcome: 'completo' | 'con_faltantes' | null; report: PresalePickReport | null; seller_seen_at: Date | string | null;
};

/**
 * `[MCP.3]` + `[MCP.8]` Surtido de preventa pedido por pedido y avance para la vendedora.
 *
 * El pedido y sus renglones viven en `commercial.orders`/`order_lines`; aquí sólo se guarda el
 * hecho propio del surtido (`commercial.presale_picks`). Ajustar el pedido lo hace
 * `CommercialOrdersService.recortarTrasSurtido` en la MISMA transacción del cierre.
 */
@Injectable()
export class PresalePickingService {
  private readonly logger = new Logger(PresalePickingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly orders: CommercialOrdersService,
    private readonly presale: PresaleControlService,
    private readonly alerts: AlertsService,
    private readonly push: CommercialPushService,
  ) {}

  // ───────────────────────────── Surtidor ─────────────────────────────

  async inbox(query: Record<string, unknown> = {}): Promise<PresalePickInboxResponse> {
    const hoy = relojMx(new Date()).fecha;
    const vacio: PresalePickInboxResponse = { today: hoy, counts: { hoy: 0, manana: 0, proximos: 0 }, data: [], scope: 'ninguno' };
    const almacenes = await this.scope.warehouseIds(query, AREA);
    if (almacenes !== null && almacenes.length === 0) return vacio;

    return this.tk.run(async (trx) => {
      const filas = await this.leer(trx, { almacenes, desde: sumarDias(hoy, -DIAS_ATRAS) });
      const data = filas.map((f) => this.aRenglon(f, hoy));
      const counts = { hoy: 0, manana: 0, proximos: 0 };
      // El contador de la pestaña es lo que FALTA por surtir, no lo que ya se cerró.
      for (const r of data) if (r.state === 'nuevo' || r.state === 'surtiendo') counts[r.bucket]++;
      return { today: hoy, counts, data, scope: almacenes === null ? 'todos' : 'propios' };
    });
  }

  async detail(orderId: string, query: Record<string, unknown> = {}): Promise<PresalePickDetail> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id inválido');
    const hoy = relojMx(new Date()).fecha;
    const almacenes = await this.scope.warehouseIds(query, AREA);
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, almacenes);
      // [MCP.3.1] La columna es `nombre`, no `name`: con `p.name` abrir un pedido daba 500 en prod
      // (`column p.name does not exist`) y nadie pudo surtir una preventa. Los specs no lo veían
      // porque simulan la base.
      const lineas = await trx('commercial.order_lines as l')
        .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
        .where('l.order_id', orderId)
        .orderBy('l.created_at', 'asc')
        .select('l.id', 'l.product_id', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'p.sku', 'p.barcode', 'p.nombre as product_name');
      const lines: PresalePickLine[] = (lineas as FilaRenglon[]).map((l) => {
        const m = cantidadMostrada({ quantity: Number(l.quantity), qty_unit: l.qty_unit, qty_factor: l.qty_factor == null ? null : Number(l.qty_factor) });
        return {
          line_id: l.id, product_id: l.product_id, sku: l.sku ?? null, barcode: l.barcode ?? null, product_name: l.product_name ?? 'Producto',
          qty: m.qty, unit: m.unit, factor: m.factor,
          // Cerrado: lo que quedó en el pedido ES lo que hubo (lo demás se quitó).
          picked: fila['finished_at'] ? m.qty : null,
        };
      });
      return { order: this.aRenglon(fila, hoy), lines };
    });
  }

  /** Registra quién empieza a surtir y a qué hora. Idempotente para la misma persona. */
  async start(orderId: string, query: Record<string, unknown> = {}): Promise<PresalePickInboxRow> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id inválido');
    const { userId, nombre } = await this.quien();
    const hoy = relojMx(new Date()).fecha;
    const almacenes = await this.scope.warehouseIds(query, AREA);
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, almacenes);
      if (fila['en_ola']) throw new ConflictException('Este pedido ya va en un recorrido de la consola de surtido.');
      await trx.raw(
        `INSERT INTO commercial.presale_picks (tenant_id, order_id, warehouse_id, started_by, started_by_name)
         VALUES (public.current_tenant_id(), ?, ?, ?, ?)
         ON CONFLICT (tenant_id, order_id) DO NOTHING`,
        [orderId, String(fila['warehouse_id']), userId, nombre],
      );
      const pick = await trx('commercial.presale_picks').where({ order_id: orderId }).first();
      if (pick.started_by !== userId && !pick.finished_at) {
        throw new ConflictException(`Ya lo está surtiendo ${pick.started_by_name} desde ${horaMx(pick.started_at)}.`);
      }
      // Empezar a surtir es el acuse del aviso de la sucursal.
      await trx('commercial.order_notifications')
        .where({ order_id: orderId })
        .whereNull('seen_at')
        .update({ seen_at: trx.fn.now(), seen_by: userId });
      const [nueva] = await this.leer(trx, { almacenes: null, orderId });
      const parte = parteDe(fila);
      this.avisarVendedora(
        fila,
        parte ? `${parte}: ya lo están surtiendo` : 'Tu pedido ya lo están surtiendo',
        `${fila['customer_name'] ?? fila['code']} · ${nombre} empezó a las ${horaMx(pick.started_at)}`,
      );
      return this.aRenglon(nueva, hoy);
    });
  }

  async finish(orderId: string, dto: PresalePickFinishRequest, query: Record<string, unknown> = {}): Promise<PresalePickFinishResponse> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id inválido');
    const { userId, nombre } = await this.quien();
    const almacenes = await this.scope.warehouseIds(query, AREA);
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, almacenes);
      const pick = await trx('commercial.presale_picks').where({ order_id: orderId }).forUpdate().first();
      if (!pick) throw new ConflictException('Primero toca «Empezar a surtir».');
      if (pick.finished_at) throw new ConflictException('Este pedido ya se terminó de surtir.');
      if (pick.started_by !== userId) {
        throw new ForbiddenException(`Lo está surtiendo ${pick.started_by_name}: sólo esa persona lo puede cerrar.`);
      }
      const { outcome, report } = await this.cerrarPedido(trx, fila, pick.id, dto?.lines ?? [], { userId, nombre });
      const cliente = (fila['customer_name'] as string) ?? (fila['code'] as string);
      // [MCP.3.13] Cada parte de un pedido agrupado avisa por separado: el título dice cuál.
      const parte = parteDe(fila);
      if (report) {
        const n = report.removed.length + report.adjusted.length;
        const falto = `faltó ${n} ${n === 1 ? 'producto' : 'productos'}`;
        this.avisarVendedora(fila, parte ? `${parte}: ${falto}` : `Reporte de surtido: ${falto}`, `${cliente} · nuevo total ${report.total_after.toFixed(2)}`);
      } else {
        this.avisarVendedora(fila, parte ? `${parte}: surtido completo` : 'Tu pedido se surtió completo', `${cliente} · listo para cobrar`);
      }
      return { order_id: orderId, outcome, report };
    });
  }

  /**
   * El cierre de UN pedido, dentro de la transacción del llamador: planea con lo marcado, quita del
   * pedido lo que no hubo y guarda el reporte en su `presale_picks`. Lo comparten el surtido por
   * pedido (`finish`) y el de la ruta (`PresaleRouteService.routeFinish`), para que un pedido se
   * cierre igual venga por donde venga. No valida quién ni avisa: eso es de cada llamador.
   *
   * `fila` = una fila de `leer` (usa `id` y `total`). Un marcado inválido es un 400.
   */
  async cerrarPedido(
    trx: Knex.Transaction,
    fila: Record<string, unknown>,
    pickId: string,
    marcados: Array<{ line_id: string; picked: number }>,
    quien: { userId: string; nombre: string },
  ): Promise<{ outcome: PlanCierre['outcome']; report: PresalePickReport | null; plan: PlanCierre }> {
    const orderId = fila['id'] as string;
    const lineas = await trx('commercial.order_lines as l')
      .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
      .where('l.order_id', orderId)
      .select('l.id', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'l.line_total', 'p.nombre as product_name');
    let plan: PlanCierre;
    try {
      plan = planearCierre(
        (lineas as FilaRenglon[]).map((l) => ({
          line_id: l.id, product_name: l.product_name ?? 'Producto', quantity: Number(l.quantity),
          qty_unit: l.qty_unit, qty_factor: l.qty_factor == null ? null : Number(l.qty_factor), line_total: Number(l.line_total),
        })),
        marcados,
      );
    } catch (e) {
      if (e instanceof CierreInvalido) throw new BadRequestException(e.message);
      throw e;
    }
    let totales = { total_before: Number(fila['total']), total_after: Number(fila['total']) };
    if (plan.outcome === 'con_faltantes') {
      totales = await this.orders.recortarTrasSurtido(trx, orderId, plan, `surtido: ${quien.nombre} quitó lo que no hubo`);
    }
    const report = armarReporte(plan, totales.total_before, totales.total_after);
    await trx('commercial.presale_picks').where({ id: pickId }).update({
      finished_by: quien.userId,
      finished_by_name: quien.nombre,
      finished_at: trx.fn.now(),
      outcome: plan.outcome,
      report: report ? JSON.stringify(report) : null,
      updated_at: trx.fn.now(),
    });
    return { outcome: plan.outcome, report, plan };
  }

  // ───────────────────────────── Vendedora ─────────────────────────────

  /** Los pedidos de preventa que levantó la persona en sesión, con su avance. */
  async sellerStatus(): Promise<PresaleSellerStatusResponse> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    const hoy = relojMx(new Date()).fecha;
    return this.tk.run(async (trx) => {
      const pedidos = await this.presale.pedidosParaGuias(trx, { almacenes: null, autorId: userId });
      const recientes = pedidos
        .filter((p) => p.status === 'confirmed' || p.requested_delivery_date >= sumarDias(hoy, -2))
        .sort((a, b) => (a.requested_delivery_date === b.requested_delivery_date
          ? (a.created_at < b.created_at ? 1 : -1)
          : a.requested_delivery_date < b.requested_delivery_date ? -1 : 1));
      const ids = recientes.map((p) => p.id);
      const picks = ids.length ? await trx('commercial.presale_picks').whereIn('order_id', ids) : [];
      const pickDe = new Map<string, FilaPick>((picks as FilaPick[]).map((p) => [p.order_id, p]));
      const confirmados = ids.length
        ? await trx('commercial.orders').whereIn('id', ids).select('id', 'confirmed_at')
        : [];
      const confirmadoDe = new Map<string, Date | string | null>(
        (confirmados as Array<{ id: string; confirmed_at: Date | string | null }>).map((o) => [o.id, o.confirmed_at]),
      );

      let detecciones = 0;
      const data: PresaleSellerOrder[] = [];
      for (const p of recientes) {
        const pk = pickDe.get(p.id);
        let charge: PresaleSellerOrder['charge'] = null;
        if (p.link) {
          charge = { source: 'liga', folio_digital: p.link.folio_digital, fecha: p.link.fecha, total: p.link.total, shared_products: p.lines, order_products: p.lines };
        } else if (pk?.finished_at && p.status === 'confirmed' && (p.possible_documents ?? 0) > 0 && detecciones < MAX_DETECCIONES) {
          detecciones++;
          try {
            const { candidates } = await this.presale.candidatosParaCampo(trx as Knex.Transaction, p.id);
            const c = detectarCobro(candidates, p.lines, fechaMx(pk.finished_at));
            if (c) charge = { source: 'detectado', folio_digital: c.folio_digital, fecha: c.fecha, total: c.total, shared_products: c.shared_products, order_products: c.order_products };
          } catch (e) {
            this.logger.warn(`[MCP.8] no se pudo buscar el cobro de ${p.code}: ${(e as Error).message}`);
          }
        }
        data.push({
          order_id: p.id,
          code: p.code,
          customer_name: p.customer_name,
          requested_delivery_date: p.requested_delivery_date,
          total: p.total,
          lines: p.lines,
          status: p.status,
          scheduled_at: iso(confirmadoDe.get(p.id)),
          warehouse_name: p.warehouse_name,
          started: pk ? { user_id: pk.started_by, name: pk.started_by_name, at: iso(pk.started_at) as string } : null,
          finished: pk?.finished_at
            ? { user_id: pk.finished_by ?? '', name: pk.finished_by_name ?? '', at: iso(pk.finished_at) as string, outcome: pk.outcome ?? 'completo' }
            : null,
          report: pk?.report ?? null,
          charge,
          delivered_at: p.delivery?.delivered_at ?? null,
          report_unseen: !!pk?.finished_at && !pk.seller_seen_at,
        });
      }
      return { today: hoy, data, unseen_reports: data.filter((d) => d.report_unseen).length };
    });
  }

  /** Para el globito de la barra: cuántos reportes de surtido no ha visto. Una consulta, sin ODS. */
  async sellerUnseen(): Promise<{ unseen_reports: number }> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    return this.tk.run(async (trx) => {
      const r = await trx('commercial.presale_picks as pp')
        .join('commercial.orders as o', 'o.id', 'pp.order_id')
        .where('o.user_id', userId)
        .whereNotNull('pp.finished_at')
        .whereNull('pp.seller_seen_at')
        .count({ n: '*' })
        .first();
      return { unseen_reports: Number(r?.n) || 0 };
    });
  }

  /** La vendedora vio sus reportes de surtido. */
  async sellerSeen(): Promise<{ updated: number }> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    return this.tk.run(async (trx) => {
      const updated = await trx('commercial.presale_picks as pp')
        .whereNotNull('pp.finished_at')
        .whereNull('pp.seller_seen_at')
        .whereExists(function () {
          this.select(trx.raw('1')).from('commercial.orders as o').whereRaw('o.id = pp.order_id').andWhere('o.user_id', userId);
        })
        .update({ seller_seen_at: trx.fn.now(), updated_at: trx.fn.now() });
      return { updated: Number(updated) || 0 };
    });
  }

  // ───────────────────────────── Interno ─────────────────────────────

  /** Quién firma (persona en sesión) con su nombre de la ficha. También lo usa la ruta. */
  async quien(): Promise<{ userId: string; nombre: string }> {
    const ctx = this.tenantCtx.get();
    const userId = ctx?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión: surtir necesita a alguien que firme.');
    const u = await this.tk.run((trx) => trx('identity.users').where({ id: userId }).first('nombre', 'username'));
    const nombre = String(u?.nombre ?? '').trim() || String(u?.username ?? '').trim() || 'Surtidor';
    return { userId, nombre };
  }

  private async pedidoEnAlcance(trx: Knex.Transaction, orderId: string, almacenes: string[] | null): Promise<Record<string, unknown>> {
    if (almacenes !== null && almacenes.length === 0) throw new ForbiddenException('Tu usuario no tiene una sucursal asignada.');
    const [fila] = await this.leer(trx, { almacenes, orderId });
    if (!fila) throw new NotFoundException('Pedido de preventa no encontrado en tu sucursal.');
    return fila;
  }

  /**
   * Los pedidos de preventa por surtir. `[MCP.3.6]` Lo que es de una ruta del vendedor
   * (`seller_route_days`) NO sale suelto: se surte como el pedido global de la ruta. Sólo la ruta
   * lo lee con `incluirRutas` para cerrar sus pedidos.
   */
  async leer(
    trx: Knex.Transaction,
    f: { almacenes: string[] | null; desde?: string; orderId?: string; incluirRutas?: boolean },
  ): Promise<Array<Record<string, unknown>>> {
    const qb = trx('commercial.orders as o')
      .join('commercial.warehouses as w', function () {
        this.on('w.id', '=', 'o.warehouse_id').andOn('w.tenant_id', '=', 'o.tenant_id');
      })
      .leftJoin('commercial.customers as c', function () {
        this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
      })
      .leftJoin('identity.users as u', 'u.id', 'o.user_id')
      .leftJoin('commercial.presale_picks as pp', function () {
        this.on('pp.order_id', '=', 'o.id').andOn('pp.tenant_id', '=', 'o.tenant_id');
      })
      .where('o.status', 'confirmed')
      .whereNotNull('o.requested_delivery_date')
      .where('o.delivery_type', 'route');
    if (f.almacenes !== null) qb.whereIn('o.warehouse_id', f.almacenes);
    if (f.orderId) qb.where('o.id', f.orderId);
    // Lo confirmado sin ruta, o después de finalizarla, sigue llegando suelto como siempre.
    if (!f.incluirRutas) {
      qb.whereRaw(`NOT EXISTS (SELECT 1 FROM commercial.seller_route_days rd WHERE ${PEDIDO_EN_RUTA_SQL})`);
    }
    if (f.desde) {
      qb.where('o.requested_delivery_date', '>=', f.desde)
        .where(function () {
          this.whereNull('pp.finished_at').orWhereRaw(`pp.finished_at >= now() - interval '${DIAS_CERRADOS} day'`);
        });
    }
    return qb
      .select(
        'o.id', 'o.code', 'o.total', 'o.warehouse_id', 'o.confirmed_at', 'o.user_id',
        trx.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS requested_delivery_date`),
        'w.name as warehouse_name', 'c.name as customer_name',
        trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS seller_name`),
        'u.username as seller_username',
        'pp.started_by', 'pp.started_by_name', 'pp.started_at',
        'pp.finished_by', 'pp.finished_by_name', 'pp.finished_at', 'pp.outcome', 'pp.report',
        trx.raw('(SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS lines'),
        trx.raw(`EXISTS (SELECT 1 FROM commercial.wave_orders wo WHERE wo.order_id = o.id AND wo.stage <> 'listo_embarque') AS en_ola`),
        trx.raw(`EXISTS (SELECT 1 FROM commercial.order_notifications n WHERE n.order_id = o.id AND n.seen_at IS NULL) AS unseen`),
        'o.group_id',
        ...GRUPO_SELECT_SQL.map((s) => trx.raw(s)),
      )
      // D5 de la Fase MCP: se surte por orden de llegada; la fecha de entrega separa la pestaña.
      .orderByRaw('o.requested_delivery_date ASC, o.confirmed_at ASC NULLS LAST, o.code ASC')
      .limit(300);
  }

  private aRenglon(f: Record<string, unknown>, hoy: string): PresalePickInboxRow {
    const { bucket, days_late } = pestanaDe(f['requested_delivery_date'] as string, hoy);
    let state: PresalePickState = 'nuevo';
    if (f['finished_at']) state = f['outcome'] === 'con_faltantes' ? 'con_faltantes' : 'completo';
    else if (f['started_at']) state = 'surtiendo';
    else if (f['en_ola']) state = 'en_recorrido';
    return {
      order_id: f['id'] as string,
      code: f['code'] as string,
      customer_name: (f['customer_name'] as string) ?? null,
      seller_name: (f['seller_name'] as string) ?? null,
      warehouse_id: f['warehouse_id'] as string,
      warehouse_name: (f['warehouse_name'] as string) ?? null,
      requested_delivery_date: f['requested_delivery_date'] as string,
      bucket,
      days_late,
      arrived_at: iso(f['confirmed_at']) as string,
      lines: Number(f['lines']) || 0,
      total: Number(f['total']) || 0,
      state,
      started: f['started_at'] ? { user_id: f['started_by'] as string, name: f['started_by_name'] as string, at: iso(f['started_at']) as string } : null,
      finished: f['finished_at'] ? { user_id: f['finished_by'] as string, name: f['finished_by_name'] as string, at: iso(f['finished_at']) as string } : null,
      unseen: !!f['unseen'],
      // [MCP.3.13] Pedido agrupado; suelto = null / [].
      group_code: (f['group_code'] as string | null | undefined) ?? null,
      group_parts: f['group_parts'] == null ? null : Number(f['group_parts']),
      group_other_warehouses: Array.isArray(f['group_other_warehouses']) ? (f['group_other_warehouses'] as unknown[]).map(String) : [],
    };
  }

  /** Aviso a la vendedora en vivo y al celular. Nunca tumba el surtido: lo que se pierde es el aviso. */
  private avisarVendedora(fila: Record<string, unknown>, titulo: string, mensaje: string): void {
    const tenantId = this.tenantCtx.get()?.tenantId;
    const username = fila['seller_username'] as string | undefined;
    const userId = fila['user_id'] as string | undefined;
    const route = '/vendor/mis-pedidos';
    try {
      if (tenantId && username) {
        this.alerts.emitTo(tenantId, username, {
          type: 'presale_pick',
          severity: 'info',
          title: titulo,
          message: mensaje,
          data: { order_id: fila['id'], code: fila['code'], route },
        });
      }
    } catch (e) {
      this.logger.warn(`[MCP.8] aviso en vivo a la vendedora falló: ${(e as Error).message}`);
    }
    if (userId) {
      void Promise.resolve()
        .then(() => this.push.sendToUser(userId, { title: titulo, body: mensaje, url: route }))
        .catch((e) => this.logger.warn(`[MCP.8] push a la vendedora falló: ${(e as Error).message}`));
    }
  }
}

/**
 * `[MCP.3.13]` «Tu pedido P-10482 · parte de Padre Hidalgo» si el pedido es parte de un grupo con
 * otras sucursales; `null` si es suelto (o todas sus partes son de la misma sucursal).
 */
function parteDe(fila: Record<string, unknown>): string | null {
  const otras = fila['group_other_warehouses'];
  if (!fila['group_code'] || !Array.isArray(otras) || !otras.length) return null;
  const sucursal = String(fila['warehouse_name'] ?? '').trim() || 'tu sucursal';
  return `Tu pedido ${fila['group_code']} · parte de ${sucursal}`;
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** `HH:MM` en hora de México. */
function horaMx(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** `YYYY-MM-DD` en hora de México. */
function fechaMx(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return relojMx(d).fecha;
}
