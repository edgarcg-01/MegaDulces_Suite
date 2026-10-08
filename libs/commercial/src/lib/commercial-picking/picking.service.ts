import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Knex } from 'knex';
import type {
  KeplerPickPoolResponse,
  KeplerPickPoolRow,
  KeplerWavesAutoResponse,
  PickerTakeNextResponse,
  PickerWave,
  PickerWaveLine,
  PickingWaveCreated,
} from '@megadulces/contracts';
import { TenantKnexService } from '@megadulces/platform-core';
import { TenantContextService, ScopeService } from '@megadulces/platform-core';
import { repartirOla, resumenPorPedido } from './allocation';
import {
  ATORADOS_KEPLER_SQL,
  CABECERAS_POR_LLAVE_SQL,
  LINEAS_KEPLER_DE_OLA_SQL,
  POOL_KEPLER_SQL,
  UMBRAL_TANDA,
  documentoKepler,
  keplerOrderId,
  normalizarLlave,
  planearOlas,
  unidadesMezcladas,
  type PedidoKeplerLlave,
} from './kepler-origen';
import { congelarPorPedido, presentacionDeProducto, type PedidoCongelado } from './congelar';
import {
  ROUTE_KINDS,
  type RouteKind,
  orderRouteSql,
  routeKindFilterSql,
  routeKindMotivoSql,
} from '../shared/route-kind.sql';

/**
 * `[VEC.8]` Agrupa las filas del pool por (sucursal, ruta). **Función pura** a propósito: es
 * lo que permite probarla con entradas armadas, incluida la que de verdad importa — la misma
 * ruta en dos sucursales, que tiene que dar DOS grupos y no uno.
 */
export function agruparPool(
  rows: ReadonlyArray<Record<string, unknown>>,
): PoolGrupo[] {
  const m = new Map<string, PoolGrupo>();
  for (const r of rows) {
    // La clave lleva la sucursal PRIMERO: el surtidor camina un almacén, y mezclar dos rutas
    // del mismo almacén es un problema distinto (y menor) que mezclar dos almacenes.
    const k = `${r['warehouse_id'] as string}|${(r['sales_route'] as string) ?? ''}`;
    const g = m.get(k) ?? {
      warehouse_id: r['warehouse_id'] as string,
      warehouse_name: (r['warehouse_name'] as string) ?? null,
      sales_route: (r['sales_route'] as string) ?? null,
      route_kind: (r['route_kind'] as string) ?? null,
      route_kind_motivo: (r['route_kind_motivo'] as string) ?? null,
      pedidos: 0,
      renglones: 0,
      unidades: '0',
      total: '0',
    };
    g.pedidos += 1;
    g.renglones += Number(r['lines'] ?? 0);
    g.unidades = String(Number(g.unidades) + Number(r['units'] ?? 0));
    g.total = String(Number(g.total) + Number(r['total'] ?? 0));
    m.set(k, g);
  }
  // Lo más grande primero: es donde consolidar rinde. Y a igualdad, por nombre de ruta para
  // que el orden sea ESTABLE — una lista que se reordena sola entre recargas se lee como si
  // hubieran cambiado los datos.
  return [...m.values()].sort(
    (a, b) => b.pedidos - a.pedidos || (a.sales_route ?? '').localeCompare(b.sales_route ?? ''),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface PoolQuery {
  warehouse_id?: string;
  delivery_date?: string;
  limit?: number;
  /**
   * `[VEC.3]` Tipos de ruta a incluir (`vecinal`, `camion`, …). Vacío o ausente = **todos**,
   * que es el comportamiento que el pool ya tenía — este filtro no cambia nada si no se pide.
   */
  route_kind?: readonly string[];
  /**
   * `[VEC.8]` UNA ruta concreta (`'1V004 JUAN ANGEL LOPEZ'`). Es el valor de
   * `trade.catalogs.value`, que coincide exacto con `customers.sales_route`.
   *
   * ⚠️ **Sola no alcanza para armar una ola**: la misma ruta existe en dos sucursales (medido:
   * `RUTA 23` está en Padre Hidalgo y en La Piedad Abastos). Siempre con `warehouse_id`.
   */
  sales_route?: string;
}

/**
 * `[VEC.8]` Un grupo del pool: los pedidos de UNA ruta en UNA sucursal.
 *
 * El grano es **(sucursal, ruta)** y no sólo la ruta, porque la misma ruta aparece en dos
 * sucursales. Armar "la ola de RUTA 23" sin acotar el almacén juntaría mercancía de dos
 * bodegas — un recorrido imposible, que `createWave` rechaza con 409, pero recién después de
 * que la persona ya creyó que iba a funcionar.
 */
export interface PoolGrupo {
  warehouse_id: string;
  warehouse_name: string | null;
  sales_route: string | null;
  route_kind: string | null;
  route_kind_motivo: string | null;
  pedidos: number;
  renglones: number;
  unidades: string;
  total: string;
}

export interface CreateWaveDto {
  warehouse_id: string;
  delivery_date?: string;
  /** Pedidos de la Suite (`commercial.orders`). Puede ir vacío si van pedidos de Kepler. */
  order_ids?: string[];
  /**
   * `[GP.2]` Pedidos de Kepler (`U-D-40`) por su llave. No llevan UUID propio: el `order_id` se
   * deriva de la llave (ver `keplerOrderId`).
   */
  kepler_orders?: Array<{ sucursal: string; serie: number; folio: string }>;
  assigned_to?: string;
  notes?: string;
  /** `[GP.3]` TELEMARK / SUCURSAL si todos sus pedidos son de ese origen. Filtra "tomar siguiente". */
  origen?: string | null;
  /** `[GP.3]` 'auto' = la armó el sistema; sólo ésas se cancelan solas si no arrancan. */
  armada_por?: 'consola' | 'auto';
}

/** `[GP.2]` Filtros del pool de pedidos de Kepler. */
export interface PoolKeplerQuery {
  warehouse_id: string;
  /** `TELEMARK` o `SUCURSAL` (Kepler `c27`). Ausente = los dos. */
  origen?: string;
  /** Ventana hacia atrás, en días, contada desde hoy (MX). Default 7, máximo 60. */
  days?: number;
}

/** Fila normalizada de un pedido para la ola, venga de la Suite o de Kepler. */
interface LineaDePedido {
  source: 'suite' | 'kepler';
  order_id: string;
  order_code: string;
  product_id: string | null;
  product_name: string | null;
  sku: string | null;
  quantity: number;
  qty_unit: string | null;
  qty_presentacion: number | null;
  unidad_presentacion: string | null;
  delivery_date: string | null;
  confirmed_at: string | null;
}

/** Cabecera normalizada de un pedido de la ola. */
interface CabeceraDePedido {
  wave_order_id: string;
  order_id: string;
  source: 'suite' | 'kepler';
  stage: string;
  code: string;
  customer_name: string | null;
  total: number | null;
  /** Sólo Kepler: el estatus vigente en Kepler (para notar que alguien lo avanzó por fuera). */
  kepler_estatus?: string | null;
}

const ORIGENES_KEPLER = ['TELEMARK', 'SUCURSAL'] as const;

// ─── [GP.2] Filas crudas de las consultas a Kepler (pg devuelve numeric como texto) ────────

interface PoolKeplerSqlRow {
  sucursal: string;
  serie: number | string;
  folio: string;
  fecha: string;
  hora: string | null;
  origen: string | null;
  estatus: string | null;
  cliente_code: string | null;
  destino_nombre: string | null;
  importe: string | null;
  renglones: number | string;
  unidades: number | string;
  sin_catalogo: number | string;
}

interface CabeceraKeplerSqlRow {
  sucursal: string;
  serie: number;
  folio: string;
  fecha: string | null;
  estatus: string | null;
  origen: string | null;
  /** [GP.3c] Destino del pedido (Kepler kdm1.c10): con él se casa la hora de salida. */
  cliente_code: string | null;
  destino_nombre: string | null;
  importe: string | null;
}

interface LineaKeplerSqlRow {
  order_id: string;
  sucursal: string;
  serie: number | string;
  folio: string;
  renglon: number;
  sku: string;
  descripcion: string | null;
  product_id: string | null;
  product_name: string | null;
  quantity: string;
  qty_unit: string | null;
  qty_presentacion: string | null;
  unidad_presentacion: string | null;
  fecha: string | null;
}

/** Fila de `commercial.wave_orders` con las columnas de [GP.2]. */
interface WaveOrderRow {
  id: string;
  order_id: string;
  stage: string;
  source: 'suite' | 'kepler';
  kepler_sucursal: string | null;
  kepler_serie: number | null;
  kepler_folio: string | null;
}

interface SuiteLineaRow {
  product_id: string;
  product_name: string | null;
  sku: string | null;
  qty_unit: string | null;
  quantity: string;
  order_code: string;
  order_id: string;
  /** `YYYY-MM-DD` (sale de `to_char`, nunca del Date de pg). */
  delivery_date: string | null;
  confirmed_at: string | Date | null;
}

/**
 * SU.2 — El pool de pedidos por surtir y las olas (ADR-067).
 *
 * ⭐ El pool es una LECTURA derivada, no una tabla: un pedido está "por surtir" cuando su estado
 * COMERCIAL dice que el cliente ya se comprometió (`confirmed`) y no está en ninguna ola viva.
 * Materializarlo sería una segunda verdad que habría que mantener sincronizada con
 * `commercial.orders` — y la regla del proyecto es derivar, no copiar.
 *
 * ⛔ **No aparta stock** (decisión de Edgar, 2026-09-17). La existencia que se vea al armar la ola
 * es informativa; el reparto de lo escaso se resuelve sobre lo que el surtidor levantó (SU.6/SU.8).
 * Por eso acá no hay nada que reservar ni que liberar: dos olas pueden pedir el mismo producto y
 * eso se resuelve por excepción, no se previene.
 */
@Injectable()
export class PickingService {
  private readonly logger = new Logger(PickingService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    // [VEC.4] El recorte por sucursal de la bandeja de avisos. Primitivo existente — no se
    // reimplementa el alcance leyendo `users.warehouse_id` a mano.
    private readonly scope: ScopeService,
  ) {}

  /**
   * Pedidos listos para surtir y todavía sin ola.
   *
   * ⚠️ `pendiente_offline` NO se puede medir desde acá y se DECLARA (ADR-056): el vendedor arma
   * pedidos sin señal (Dexie + cola de sync en `apps/vendor`) y esos pedidos **no existen para el
   * servidor** hasta que sincronizan. El pool no puede prometer que muestra todo lo del día; lo
   * que muestra es todo lo que YA LLEGÓ. La pantalla tiene que decirlo — si no, un pedido que
   * nunca sincronizó se ve igual que un pedido que no existe.
   */
  async pool(q: PoolQuery = {}) {
    if (q.warehouse_id && !UUID_RE.test(q.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (q.delivery_date && !DATE_RE.test(q.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 500);

    return this.tk.run(async (trx) => {
      let qb = trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'o.warehouse_id').andOn('w.tenant_id', '=', 'o.tenant_id');
        })
        .where('o.status', 'confirmed')
        // Sin ola viva. `listo_embarque` ya salió del almacén, así que no bloquea.
        .whereNotExists(function () {
          this.select(trx.raw('1'))
            .from('commercial.wave_orders as wo')
            .whereRaw('wo.order_id = o.id')
            .andWhere('wo.stage', '<>', 'listo_embarque');
        });

      if (q.warehouse_id) qb = qb.where('o.warehouse_id', q.warehouse_id);
      if (q.delivery_date) qb = qb.where('o.requested_delivery_date', q.delivery_date);
      // [VEC.3] Filtro por tipo de ruta. Los tipos se validan contra la taxonomía ANTES de
      // llegar al SQL: un tipo inventado tiene que ser un 400, no un pool vacío que se lee
      // como "hoy no hay nada que surtir".
      if (q.route_kind?.length) {
        const malos = q.route_kind.filter((k) => !ROUTE_KINDS.includes(k as RouteKind));
        if (malos.length) {
          throw new BadRequestException(
            `route_kind inválido: ${malos.join(', ')}. Válidos: ${ROUTE_KINDS.join(', ')}`,
          );
        }
        qb = qb.whereRaw(routeKindFilterSql(q.route_kind, 'c'));
      }
      // [VEC.8] Una ruta concreta. Se compara contra `customers.sales_route`, que es la misma
      // cadena que `trade.catalogs.value` — por eso no hace falta resolver el id.
      if (q.sales_route) qb = qb.where('c.sales_route', q.sales_route);

      const rows = await qb
        .select(
          'o.id',
          'o.code',
          'o.customer_id',
          'c.name as customer_name',
          'o.warehouse_id',
          'w.name as warehouse_name',
          'o.requested_delivery_date',
          'o.total',
          'o.confirmed_at',
          'o.created_at',
          // [VEC.3] De qué ruta viene el pedido y de qué tipo es. Van SIEMPRE, no sólo al
          // filtrar: si el surtidor no ve el tipo, no puede notar que un pedido cayó en la
          // ola equivocada — y el motivo separa "el cliente no tiene ruta" (lo arregla quien
          // captura) de "la ruta no está declarada" (lo arregla Dirección).
          trx.raw(`${orderRouteSql('c', 'value')} AS sales_route`),
          trx.raw(`${orderRouteSql('c', 'route_kind')} AS route_kind`),
          trx.raw(`${routeKindMotivoSql('c')} AS route_kind_motivo`),
          trx.raw('(SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS lines'),
          trx.raw('(SELECT coalesce(sum(ol.quantity),0) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::numeric AS units'),
        )
        // Primero lo que se entrega antes; a igual fecha, lo que se confirmó antes.
        .orderByRaw('o.requested_delivery_date ASC NULLS LAST, o.confirmed_at ASC NULLS LAST, o.code ASC')
        .limit(limit);

      return {
        data: rows,
        count: rows.length,
        capped: rows.length === limit,
        // [VEC.8] Los grupos (sucursal, ruta): "que no se mezcle mercancía" empieza por poder
        // VER cuánto hay de cada ruta antes de caminar.
        //
        // ⚠️ Se agregan sobre LAS MISMAS filas que se devuelven, no con un segundo SELECT.
        // Un `GROUP BY` aparte volvería a aplicar los filtros y el `limit` por su cuenta, y el
        // día que uno de los dos cambie, la pantalla mostraría 7 pedidos en la tabla y 9 en el
        // encabezado del grupo. Derivar del mismo origen hace imposible esa divergencia.
        grupos: agruparPool(rows),
        // ⚠️ Frescura del pool: lo creado sin señal todavía no llegó. No es un contador que
        // podamos calcular — es una ausencia, y se declara como tal.
        pendiente_offline: 'no_medible_desde_el_servidor',
      };
    });
  }

  /**
   * `[GP.2]` Pool de pedidos de KEPLER (`U-D-40`) listos para surtir: estatus vigente
   * `AUTORIZADO`, de la sucursal del almacén, y fuera de cualquier ola.
   *
   * Lectura pura del ODS (ADR-086): el pedido no se copia; la ola sólo guarda su llave.
   *
   * ── Por qué una ventana de días ─────────────────────────────────────────────────────────
   * Medido en prod (2026-10-07): en Kepler quedan pedidos `AUTORIZADO` de julio y agosto que nadie
   * va a surtir. Meterlos al pool los mezclaría con los de hoy. No se esconden: se cuentan aparte
   * en `atorados`, para que alguien los cierre en Kepler.
   *
   * ── Por qué "fuera de cualquier ola" y no sólo "fuera de una ola viva" ─────────────────
   * Un pedido de la Suite sale del pool porque su propio estado cambia. Uno de Kepler NO: sigue
   * `AUTORIZADO` en Kepler hasta que el almacenista captura el resultado (ADR-086, una sola vez al
   * final). Si sólo se excluyeran las olas vivas, un pedido ya surtido y listo para embarque
   * volvería a aparecer como pendiente. Cancelar la ola sí lo regresa (cancelar borra sus filas).
   *
   * Cada fila trae `tamano` (`tanda` hasta 5 renglones, `individual` de 6 en adelante), la regla
   * de surtido de Francisco (`FASE_GP` §5.1).
   */
  async poolKepler(q: PoolKeplerQuery): Promise<KeplerPickPoolResponse> {
    if (!UUID_RE.test(q?.warehouse_id || '')) throw new BadRequestException('warehouse_id inválido');
    const origen = q.origen ? String(q.origen).trim().toUpperCase() : null;
    if (origen && !(ORIGENES_KEPLER as readonly string[]).includes(origen)) {
      throw new BadRequestException(`origen inválido: ${origen}. Válidos: ${ORIGENES_KEPLER.join(', ')}`);
    }
    const days = q.days == null ? 7 : Number(q.days);
    if (!Number.isInteger(days) || days < 0 || days > 60) {
      throw new BadRequestException('days debe ser un entero entre 0 y 60');
    }

    return this.tk.run(async (trx) => {
      const sucursal = await this.sucursalDeAlmacen(trx, q.warehouse_id);
      const { rows: hoyRows } = await trx.raw(
        `SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date - ?::int, 'YYYY-MM-DD') AS desde`,
        [days],
      );
      const desde: string = hoyRows[0].desde;

      const { rows } = await trx.raw(POOL_KEPLER_SQL, [sucursal, desde, origen, origen]);
      const conId = (rows as PoolKeplerSqlRow[]).map((r) => {
        const llave: PedidoKeplerLlave = { sucursal: r.sucursal, serie: Number(r.serie), folio: r.folio };
        return { ...r, llave, id: keplerOrderId(llave) };
      });

      const ids = conId.map((r) => r.id);
      const enOla = ids.length
        ? new Set(
            (await trx('commercial.wave_orders').whereIn('order_id', ids).select('order_id')).map(
              (x: { order_id: string }) => x.order_id,
            ),
          )
        : new Set<string>();

      const data = conId
        .filter((r) => !enOla.has(r.id))
        .map((r): KeplerPickPoolRow => ({
          id: r.id,
          source: 'kepler' as const,
          sucursal: r.sucursal,
          serie: Number(r.serie),
          folio: r.folio,
          code: documentoKepler(r.llave),
          fecha: r.fecha,
          hora: r.hora,
          origen: r.origen,
          estatus: r.estatus,
          cliente_code: r.cliente_code,
          customer_name: r.destino_nombre,
          total: r.importe == null ? null : Number(r.importe),
          lines: Number(r.renglones) || 0,
          units: Number(r.unidades) || 0,
          tamano: (Number(r.renglones) || 0) <= UMBRAL_TANDA ? ('tanda' as const) : ('individual' as const),
          // Un renglón cuya clave no existe en el catálogo no puede entrar a una ola. Se dice
          // por pedido para que se vea ANTES de intentar armarla.
          sin_catalogo: Number(r.sin_catalogo) || 0,
        }));

      const { rows: at } = await trx.raw(ATORADOS_KEPLER_SQL, [sucursal, desde, origen, origen]);
      return {
        data,
        count: data.length,
        sucursal,
        desde,
        umbral_tanda: UMBRAL_TANDA,
        /** Siguen `AUTORIZADO` en Kepler con fecha anterior a `desde`: fuera del pool, no escondidos. */
        atorados: { count: Number(at[0]?.n) || 0, desde: at[0]?.desde ?? null },
      };
    });
  }

  /**
   * `[GP.2]` Arma las olas de los pedidos de Kepler pendientes con la regla de Francisco
   * (`FASE_GP` §5.1): los de 1–5 renglones en UNA tanda, y una ola por cada pedido más grande.
   *
   * Mismo criterio que `crearOlaAuto`: un botón, no un cron (quien camina el almacén decide
   * cuándo cierra el corte), nunca toca una ola existente y no crea olas vacías.
   *
   * ⚠️ Los pedidos con algún renglón fuera del catálogo NO entran: se devuelven en
   * `bloqueados` con su motivo. Armar la ola sin ellos sería mandar el pedido incompleto sin que
   * nadie lo decidiera.
   *
   * ⚠️ Cada ola se crea en su propia transacción. Si una choca (otra sesión se llevó el pedido),
   * esa falla con su motivo y las demás siguen: se prefiere armar lo que se puede y decir qué no.
   */
  async crearOlasKepler(dto: {
    warehouse_id: string;
    origen?: string;
    days?: number;
  }): Promise<KeplerWavesAutoResponse> {
    const pool = await this.poolKepler(dto);
    const bloqueados = pool.data
      .filter((p) => p.sin_catalogo > 0)
      .map((p) => ({ code: p.code, motivo: `${p.sin_catalogo} renglón(es) con clave fuera del catálogo` }));
    const elegibles = pool.data.filter((p) => p.sin_catalogo === 0);
    // [GP.3c] El umbral de la tanda es del almacén (lo ajusta el coordinador); sin ajuste, 5.
    const umbral = await this.umbralTanda(dto.warehouse_id);
    const plan = planearOlas(elegibles.map((p) => ({ id: p.id, renglones: p.lines })), umbral);
    const porId = new Map(elegibles.map((p) => [p.id, p]));
    const llaves = (ids: string[]) =>
      ids.map((id) => {
        const p = porId.get(id)!;
        return { sucursal: p.sucursal, serie: p.serie, folio: p.folio };
      });

    const creadas: PickingWaveCreated[] = [];
    const fallidas: Array<{ pedidos: string[]; motivo: string }> = [];
    // [GP.3] El origen de la ola: el de sus pedidos si todos coinciden; si mezcla, null. Con
    // filtro de origen todos coinciden por construcción del pool.
    const origenDe = (ids: string[]): string | null => {
      const os = new Set(ids.map((id) => porId.get(id)?.origen ?? null));
      return os.size === 1 ? [...os][0] : null;
    };
    const armar = async (ids: string[], notes: string): Promise<boolean> => {
      try {
        const w = await this.createWave({
          warehouse_id: dto.warehouse_id,
          kepler_orders: llaves(ids),
          notes,
          origen: origenDe(ids),
          armada_por: 'auto',
        });
        creadas.push({
          id: w.id,
          code: w.code,
          warehouse_id: w.warehouse_id,
          status: w.status,
          notes: w.notes ?? null,
          orders_count: w.orders_count,
        });
        return true;
      } catch (e) {
        fallidas.push({ pedidos: ids.map((id) => porId.get(id)!.code), motivo: (e as Error).message });
        return false;
      }
    };

    if (plan.tanda.length) {
      const ok = await armar(
        plan.tanda,
        `Tanda Kepler — ${plan.tanda.length} pedido(s) de 1 a ${umbral} renglones`,
      );
      // Un solo pedido problemático (p. ej. una clave pedida en dos unidades entre dos pedidos) no
      // debe frenar a todos los demás: si la tanda no se pudo armar, se intenta cada uno solo. El
      // motivo de la tanda queda en `fallidas`, y cada pedido que tampoco entre solo, también.
      if (!ok && plan.tanda.length > 1) {
        for (const id of plan.tanda) await armar([id], `Pedido Kepler ${porId.get(id)!.code} — tanda no armada`);
      }
    }
    for (const id of plan.individuales) {
      const p = porId.get(id)!;
      await armar([id], `Pedido Kepler ${p.code} — ${p.lines} renglones`);
    }

    this.logger.log(
      `[GP.2] Olas Kepler suc ${pool.sucursal}: ${creadas.length} creada(s), ${fallidas.length} fallida(s), ` +
        `${bloqueados.length} bloqueado(s)`,
    );
    return {
      creadas,
      fallidas,
      bloqueados,
      /** Pedidos autorizados sin renglones: no hay nada que caminar. */
      vacios: plan.vacios.map((id) => porId.get(id)!.code),
      atorados: pool.atorados,
    };
  }

  /**
   * `[GP.3]` "Tomar el siguiente" (decisión de Francisco, 2026-10-07, `FASE_GP` §8): el surtidor
   * pide trabajo y el sistema le da la ola libre más vieja de su almacén. No elige cuál: así nadie
   * se queda con los pedidos fáciles. La consola queda para lo que pide criterio (partir un pedido
   * grande, urgentes, reasignar).
   *
   *  1. **Si ya trae una ola** (abierta o en surtido) se le devuelve ésa: una a la vez, y cerrar
   *     la app no le hace perder su trabajo.
   *  2. **Si no**, se le asigna la ola libre más vieja del almacén, con `FOR UPDATE SKIP LOCKED`:
   *     si dos surtidores aprietan a la vez, cada uno se lleva una distinta y ninguno espera.
   *  3. **Si no hay olas libres**, se arman desde el pool de Kepler con la regla de tandas
   *     (`crearOlasKepler`) y se vuelve a intentar. Así no hace falta que alguien reparta.
   *  4. Al asignarla se ARRANCA (se congela lo pedido). Si ya no se puede arrancar (el pedido o el
   *     catálogo cambiaron desde que se armó):
   *       · una ola que armó el SISTEMA (`armada_por='auto'`) se cancela con su motivo —los pedidos
   *         vuelven al pool, donde la validación los separa—;
   *       · una que armó la CONSOLA no se tira sin que alguien lo decida: se LIBERA (vuelve sin
   *         dueño, con el motivo en sus notas) y se le avisa al surtidor en `atoradas`.
   *     En los dos casos se intenta la siguiente.
   *
   * ⚠️ "¿Ya trae una?" y "asígnale una libre" van en UNA transacción con un candado por persona
   * (`pg_advisory_xact_lock`): sin él, dos peticiones del mismo surtidor (dos pestañas, un
   * reintento de la red) veían "no trae ninguna" a la vez y se llevaban DOS olas (lo encontró la
   * revisión de GP.3). Con el candado la segunda espera y ve la que ya tiene.
   */
  async tomarSiguiente(dto: { warehouse_id: string; origen?: string }): Promise<PickerTakeNextResponse> {
    if (!UUID_RE.test(dto?.warehouse_id || '')) throw new BadRequestException('warehouse_id inválido');
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('sin usuario en contexto: tomar trabajo necesita a quién asignarlo');
    const origen = dto.origen ? String(dto.origen).trim().toUpperCase() : null;
    if (origen && !(ORIGENES_KEPLER as readonly string[]).includes(origen)) {
      throw new BadRequestException(`origen inválido: ${origen}. Válidos: ${ORIGENES_KEPLER.join(', ')}`);
    }

    const excluir: string[] = [];
    const atoradas: Array<{ code: string; motivo: string }> = [];
    let armado: KeplerWavesAutoResponse | null = null;
    for (let intento = 0; intento < 6; intento++) {
      const t = await this.asignarOla(dto.warehouse_id, userId, origen, excluir);
      if (!t) {
        if (armado) break; // ya se armó una vez y no quedó nada libre
        armado = await this.crearOlasKepler({ warehouse_id: dto.warehouse_id, origen: origen ?? undefined });
        continue;
      }
      try {
        await this.startPicking(t.id);
        return { estado: 'asignada', ya_era_tuya: t.ya_era_tuya, ola: await this.olaParaSurtidor(t.id), atoradas };
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
        const motivo = (e as Error).message;
        excluir.push(t.id);
        if (t.armada_por === 'auto') {
          await this.cancelWave(t.id, `[GP.3] no se pudo arrancar al tomarla: ${motivo}`);
        } else {
          await this.liberarOla(t.id, `[GP.3] no se pudo arrancar al tomarla: ${motivo}`);
          atoradas.push({ code: t.code, motivo });
        }
        this.logger.warn(`[GP.3] ola ${t.code} (${t.armada_por}) no arrancó al tomarla: ${motivo}`);
      }
    }
    return {
      estado: 'sin_trabajo',
      motivo: atoradas.length
        ? 'Hay olas de la consola que no se pudieron arrancar; no queda otra libre en este almacén.'
        : 'No hay pedidos autorizados por surtir en este almacén.',
      armado,
      atoradas,
    };
  }

  /**
   * `[GP.3]` En UNA transacción con candado por persona: la ola que el usuario ya trae, o si no,
   * la libre más vieja del almacén (y del origen pedido), reclamada con `SKIP LOCKED` para que
   * dos surtidores nunca se lleven la misma. `excluir` = olas que en esta misma petición no
   * arrancaron. Devuelve null si no hay ninguna.
   */
  private async asignarOla(
    warehouseId: string,
    userId: string,
    origen: string | null,
    excluir: readonly string[],
  ): Promise<{ id: string; code: string; armada_por: string; ya_era_tuya: boolean } | null> {
    return this.tk.run(async (trx) => {
      await trx.raw(`SELECT pg_advisory_xact_lock(hashtext(?))`, [`gp3-surtidor:${userId}`]);
      const mia: { id: string; code: string; armada_por: string } | undefined = await trx('commercial.picking_waves')
        .where({ assigned_to: userId })
        .whereIn('status', ['abierta', 'en_surtido'])
        .whereNotIn('id', excluir)
        .orderBy('created_at')
        .first('id', 'code', 'armada_por');
      if (mia) return { ...mia, ya_era_tuya: true };

      const { rows } = await trx.raw(
        `UPDATE commercial.picking_waves
            SET assigned_to = ?, updated_at = now(), updated_by = ?
          WHERE id = (SELECT pw.id FROM commercial.picking_waves pw
                       WHERE pw.warehouse_id = ? AND pw.assigned_to IS NULL
                         -- [GP.3c] 'en_surtido' sin dueño = la consola la LIBERÓ a medio surtir
                         -- (el surtidor se fue): la retoma otro, con lo ya marcado.
                         AND pw.status IN ('abierta', 'en_surtido')
                         AND (?::text IS NULL OR pw.origen = ?::text)
                         AND NOT (pw.id = ANY(?::uuid[]))
                       -- [GP.3c] La fila: urgente → la salida más próxima de sus destinos (la
                       -- captura el coordinador) → lo más viejo. Sin hora de salida va al final
                       -- de los que sí la tienen, no se pierde.
                       ORDER BY pw.prioridad DESC,
                                (SELECT min(d.hora_salida)
                                   FROM commercial.wave_orders wo
                                   JOIN commercial.picking_departures d
                                     ON d.warehouse_id = pw.warehouse_id
                                    AND d.fecha = (now() AT TIME ZONE 'America/Mexico_City')::date
                                    AND d.destino_code = wo.destino_code
                                  WHERE wo.wave_id = pw.id) ASC NULLS LAST,
                                pw.created_at, pw.id
                       LIMIT 1
                       FOR UPDATE SKIP LOCKED)
        RETURNING id, code, armada_por`,
        [userId, userId, warehouseId, origen, origen, [...excluir]],
      );
      const r = (rows as Array<{ id: string; code: string; armada_por: string }>)[0];
      return r ? { ...r, ya_era_tuya: false } : null;
    });
  }

  /** `[GP.3]` Deja una ola sin dueño y anota por qué, para que la consola la vea y la resuelva. */
  private async liberarOla(waveId: string, motivo: string): Promise<void> {
    const userId = this.tenantCtx.get()?.userId || null;
    await this.tk.run((trx) =>
      trx('commercial.picking_waves')
        .where({ id: waveId })
        .whereIn('status', ['abierta'])
        .update({
          assigned_to: null,
          notes: trx.raw(`concat_ws(' · ', notes, ?::text)`, [motivo]),
          updated_at: trx.fn.now(),
          updated_by: userId,
        }),
    );
  }

  /** `[GP.3]` Las olas que trae el surtidor (abiertas o en surtido), con sus renglones. */
  async misOlas(): Promise<PickerWave[]> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) return [];
    const ids: Array<{ id: string }> = await this.tk.run((trx) =>
      trx('commercial.picking_waves')
        .where({ assigned_to: userId })
        .whereIn('status', ['abierta', 'en_surtido'])
        .orderBy('created_at')
        .select('id'),
    );
    const out: PickerWave[] = [];
    for (const { id } of ids) out.push(await this.olaParaSurtidor(id));
    return out;
  }

  /** `[GP.3]` Una ola con la forma que usa la pantalla del surtidor. */
  private async olaParaSurtidor(waveId: string): Promise<PickerWave> {
    return this.tk.run(async (trx) => {
      const w: {
        id: string;
        code: string;
        warehouse_id: string;
        status: string;
        notes: string | null;
        started_at: Date | null;
      } = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .first('id', 'code', 'warehouse_id', 'status', 'notes', 'started_at');
      if (!w) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      const cab = await this.cabecerasDe(trx, waveId);
      const lineas: Array<Record<string, unknown>> = await this.lineasDe(trx, waveId);
      const n = (v: unknown): number | null => (v == null ? null : Number(v));
      const exist = await this.existenciaDe(trx, w.warehouse_id, lineas.map((l) => String(l['product_id'])));
      return {
        id: w.id,
        code: w.code,
        warehouse_id: w.warehouse_id,
        status: w.status,
        notes: w.notes,
        started_at: w.started_at ? new Date(w.started_at).toISOString() : null,
        pedidos: [...cab.values()].map((c) => c.code).sort(),
        existencia_al: exist.al,
        lines: lineas.map(
          (l): PickerWaveLine => ({
            existencia: exist.porProducto.get(String(l['product_id']))?.qty ?? null,
            existencia_unidad: exist.porProducto.get(String(l['product_id']))?.unidad ?? null,
            id: String(l['id']),
            product_id: String(l['product_id']),
            product_name: (l['product_name'] as string | null) ?? null,
            sku: (l['sku'] as string | null) ?? null,
            barcode: (l['barcode'] as string | null) ?? null,
            qty_requested: Number(l['qty_requested']),
            qty_unit: (l['qty_unit'] as string | null) ?? null,
            unidad_mixta: Boolean(l['unidad_mixta']),
            qty_presentacion: n(l['qty_presentacion']),
            unidad_presentacion: (l['unidad_presentacion'] as string | null) ?? null,
            qty_picked: n(l['qty_picked']),
            status: l['status'] as PickerWaveLine['status'],
            bin_code: (l['bin_code'] as string | null) ?? null,
            note: (l['note'] as string | null) ?? null,
          }),
        ),
      };
    });
  }

  /**
   * `[GP.3c]` Existencia en el sistema de cada producto en el almacén de la ola, con su unidad base
   * y de cuándo es el dato. Fuente canónica `analytics.v_erp_stock_on_hand` (la misma de
   * `/almacen/inventory/existencia`, en la unidad BASE de Kepler) filtrada por almacén y productos
   * —sin filtro la vista tarda más de un minuto—; la unidad base sale de `kdii.c11` de la sucursal.
   *
   * ⚠️ Medido en prod (2026-10-08, 42,957 renglones `U-D-40` de 30 días): la unidad del pedido es
   * la base del producto en el 99.65%. En el 0.35% restante (PAQ pedido / KG en existencia) la
   * pantalla NO compara: muestra la existencia con su propia unidad.
   * ⚠️ El dato llega con atraso (`kdil` iba 42 min atrás al medir): se devuelve `al` para decirlo.
   */
  private async existenciaDe(
    trx: Knex.Transaction,
    warehouseId: string,
    productIds: readonly string[],
  ): Promise<{ al: string | null; porProducto: Map<string, { qty: number | null; unidad: string | null }> }> {
    const porProducto = new Map<string, { qty: number | null; unidad: string | null }>();
    if (!productIds.length) return { al: null, porProducto };
    const { rows } = await trx.raw(
      `SELECT p.id AS product_id,
              s.qty_stock_units AS qty,
              upper(NULLIF(btrim(i.c11::text), '')) AS unidad
         FROM catalog.products p
         JOIN commercial.warehouses w ON w.id = ?
         LEFT JOIN analytics.v_erp_stock_on_hand s ON s.warehouse_id = w.id AND s.product_id = p.id
         LEFT JOIN LATERAL (
           SELECT k.c11 FROM kepler_ods.kdii k
            WHERE k.sucursal = w.code AND btrim(k.c1) = p.sku
            LIMIT 1
         ) i ON true
        WHERE p.id = ANY(?::uuid[])`,
      [warehouseId, [...productIds]],
    );
    for (const r of rows as Array<{ product_id: string; qty: string | null; unidad: string | null }>) {
      porProducto.set(r.product_id, { qty: r.qty == null ? null : Number(r.qty), unidad: r.unidad });
    }
    const { rows: f } = await trx.raw(
      `SELECT dato_al FROM analytics.v_feed_freshness WHERE feed = 'kdil' LIMIT 1`,
    );
    const al = (f as Array<{ dato_al: Date | null }>)[0]?.dato_al;
    return { al: al ? new Date(al).toISOString() : null, porProducto };
  }

  /** `[GP.3c]` El umbral de la tanda del almacén (`commercial.picking_settings`); sin ajuste, 5. */
  async umbralTanda(warehouseId: string): Promise<number> {
    const r: { umbral_tanda: number } | undefined = await this.tk.run((trx) =>
      trx('commercial.picking_settings').where({ warehouse_id: warehouseId }).first('umbral_tanda'),
    );
    return r?.umbral_tanda ? Number(r.umbral_tanda) : UMBRAL_TANDA;
  }

  /**
   * `[GP.2]` La sucursal Kepler de un almacén de la Suite: su `code` de dos dígitos
   * (`'01'` = Padre Hidalgo). Los almacenes de ruta (`RUTA-21`, `01-002`) no surten pedidos
   * `U-D-40` y se rechazan con un mensaje, no con un pool vacío.
   */
  private async sucursalDeAlmacen(trx: Knex.Transaction, warehouseId: string): Promise<string> {
    const w: { code: string | null; name: string } | undefined = await trx('commercial.warehouses')
      .where({ id: warehouseId })
      .first('code', 'name');
    if (!w) throw new NotFoundException(`Almacén ${warehouseId} no encontrado`);
    const code = String(w.code ?? '').trim();
    if (!/^\d{2}$/.test(code)) {
      throw new BadRequestException(
        `El almacén ${w.name} (${code}) no es una sucursal Kepler: los pedidos U-D-40 se surten de una sucursal (código de 2 dígitos).`,
      );
    }
    return code;
  }

  /**
   * `[VEC.4]` La bandeja de la sucursal: pedidos que le avisaron que tiene que armar.
   *
   * ── En qué se diferencia del pool ───────────────────────────────────────────────────
   * El pool es una **lectura derivada del estado** ("qué está listo para surtir ahora"). Esta
   * bandeja es el **registro de un hecho con acuse** ("a esta sucursal se le avisó, y alguien
   * lo vio o no"). Un pedido ya surtido sale del pool pero su aviso queda — así se puede
   * responder *"¿nos avisaron?"* días después, que es justo lo que hoy no se puede.
   *
   * ⚠️ El recorte por sucursal sale de `ScopeService`, **no** de `identity.users.warehouse_id`.
   * Medido 2026-10-06: sólo **1 de los 6 `almacenista`** tiene esa columna; filtrar por ella
   * dejaría ciegas a 5 de las 6 personas que arman, y la función se vería entregada sirviendo
   * cero. `ScopeService` devuelve `null` (= sin recorte) para quien no tiene alcance declarado:
   * se prefiere un aviso de más, que se nota, a uno de menos, que no.
   */
  async avisos(query: Record<string, unknown> | undefined, soloPendientes = false) {
    const almacenes = await this.scope.warehouseIds(query, 'reparto/surtido/avisos');
    // `[]` = el alcance existe y no incluye ningún almacén vivo → no hay nada que mostrar.
    // Es DISTINTO de `null` (sin recorte). Confundirlos sería mostrarle todo a quien no debe.
    if (almacenes !== null && almacenes.length === 0) {
      return { data: [], count: 0, alcance: 'ninguno' as const, pendientes: 0 };
    }

    return this.tk.run(async (trx) => {
      let qb = trx('commercial.order_notifications as n')
        .join('commercial.orders as o', function () {
          this.on('o.id', '=', 'n.order_id').andOn('o.tenant_id', '=', 'n.tenant_id');
        })
        .leftJoin('commercial.customers as c', function () {
          this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
        })
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'n.warehouse_id').andOn('w.tenant_id', '=', 'n.tenant_id');
        });

      if (almacenes !== null) qb = qb.whereIn('n.warehouse_id', almacenes);
      if (soloPendientes) qb = qb.whereNull('n.seen_at');

      const rows = await qb
        .select(
          'n.id',
          'n.order_id',
          'n.warehouse_id',
          'w.name as warehouse_name',
          'n.created_at',
          'n.seen_at',
          'o.code',
          'o.status',
          'o.total',
          'o.requested_delivery_date',
          'c.name as customer_name',
          // Mismo primitivo que el pool: el tipo de ruta y el motivo de su ausencia.
          trx.raw(`${orderRouteSql('c', 'value')} AS sales_route`),
          trx.raw(`${orderRouteSql('c', 'route_kind')} AS route_kind`),
          trx.raw(`${routeKindMotivoSql('c')} AS route_kind_motivo`),
          // ⭐ Que el pedido YA esté en una ola es lo que convierte la bandeja en algo
          // accionable: sin esto el almacén no distingue "falta armarlo" de "ya lo armé".
          trx.raw(`EXISTS (SELECT 1 FROM commercial.wave_orders wo
                            WHERE wo.order_id = n.order_id AND wo.tenant_id = n.tenant_id) AS en_ola`),
        )
        // Lo no visto primero; dentro de eso, lo más viejo arriba — un aviso de hace tres días
        // es más urgente que el de hace diez minutos, y el orden tiene que decirlo.
        .orderByRaw('n.seen_at IS NOT NULL, n.created_at ASC')
        .limit(300);

      const pendientes = rows.filter((r: { seen_at: Date | null }) => !r.seen_at).length;
      return {
        data: rows,
        count: rows.length,
        pendientes,
        alcance: almacenes === null ? ('todos' as const) : ('recortado' as const),
      };
    });
  }

  /**
   * `[VEC.4]` Acuse: alguien de la sucursal vio el aviso.
   *
   * ⚠️ `seen_at` y `seen_by` van JUNTOS (lo exige el CHECK de la tabla) y **sólo la primera
   * vez**: el `WHERE seen_at IS NULL` conserva quién lo vio primero. Sobrescribirlo con cada
   * clic convertiría el acuse en "el último que pasó por acá", que no sirve para auditar nada.
   */
  async marcarVisto(id: string) {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const userId = this.tenantCtx.get()?.userId || null;
    if (!userId) throw new BadRequestException('sin usuario en contexto: el acuse necesita autor');

    return this.tk.run(async (trx) => {
      const [fila] = await trx('commercial.order_notifications')
        .where({ id })
        .whereNull('seen_at')
        .update({ seen_at: trx.fn.now(), seen_by: userId })
        .returning('*');
      if (fila) return fila;

      // No actualizó: o no existe, o ya estaba visto. Son dos cosas distintas y el que
      // llama merece saber cuál — un 404 sobre un aviso ya acusado confunde al operador.
      const previa = await trx('commercial.order_notifications').where({ id }).first();
      if (!previa) throw new NotFoundException(`Aviso ${id} no encontrado`);
      return previa; // ya estaba visto: idempotente, no es un error
    });
  }

  /**
   * `[VEC.10]` Lo que NO se va a poder surtir, y de qué sucursal traerlo.
   *
   * ── Qué resuelve ────────────────────────────────────────────────────────────────────
   * Hoy el faltante se descubre **en el anaquel**, con el recorrido ya empezado. Medido en
   * prod: **13 renglones de 11 pedidos** (41% de los que esperan) no tienen existencia
   * suficiente en su sucursal. Esto los saca a la luz ANTES de caminar, y dice dónde sí están.
   *
   * ── Qué significa "la más cercana" ──────────────────────────────────────────────────
   * Distancia en línea recta (haversine) **desde la sucursal que surte el pedido**, no desde
   * el vendedor. Lo definió Edgar y además es lo único medible: cada ruta tiene su sucursal
   * base asignada, mientras que la posición del vendedor depende de un GPS que hoy casi no
   * reporta (medido: 1,094 pings de 6 personas en 3 meses, el último hace 81 días).
   *
   * ⚠️ Es línea recta, no carretera. Para decidir "¿voy a 8ESQ o a Padre Hidalgo?" (0.8 vs
   * 2.3 km) alcanza y sobra; para 110 km contra 115 km no decide nada — y por eso la pantalla
   * muestra el número en vez de un veredicto.
   *
   * ⚠️ **CEDIS no tiene coordenada** (declarado en la migración `20261006150000`). No se lo
   * excluye en silencio: sale al final de la lista marcado `sin_coordenada`, porque tener
   * mercancía y no saber a qué distancia está es distinto de no tenerla.
   */
  async faltantes(q: PoolQuery = {}) {
    if (q.warehouse_id && !UUID_RE.test(q.warehouse_id))
      throw new BadRequestException('warehouse_id inválido');
    if (q.delivery_date && !DATE_RE.test(q.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    if (q.route_kind?.length) {
      const malos = q.route_kind.filter((k) => !ROUTE_KINDS.includes(k as RouteKind));
      if (malos.length) {
        throw new BadRequestException(`route_kind inválido: ${malos.join(', ')}`);
      }
    }

    return this.tk.run(async (trx) => {
      // Haversine en SQL. Se escribe UNA vez y se reusa en el SELECT y en el ORDER BY: con
      // dos copias, el día que alguien toque una, la lista se ordenaría por un número
      // distinto del que muestra — y nadie lo notaría.
      const KM = `(6371 * 2 * asin(sqrt(
        power(sin(radians(w2.latitude - b.lat1) / 2), 2) +
        cos(radians(b.lat1)) * cos(radians(w2.latitude)) *
        power(sin(radians(w2.longitude - b.lng1) / 2), 2))))`;

      const { rows } = await trx.raw(
        `WITH base AS (
           SELECT o.id AS order_id, o.code, o.warehouse_id,
                  w1.name AS warehouse_name, w1.latitude AS lat1, w1.longitude AS lng1,
                  c.name AS customer_name, c.sales_route,
                  ${orderRouteSql('c', 'route_kind')} AS route_kind,
                  ol.product_id, ol.quantity AS pedida,
                  COALESCE(s.quantity, 0) AS hay,
                  (ol.quantity - COALESCE(s.quantity, 0)) AS falta
             FROM commercial.orders o
             JOIN commercial.order_lines ol ON ol.order_id = o.id
             JOIN commercial.warehouses w1 ON w1.id = o.warehouse_id AND w1.tenant_id = o.tenant_id
             LEFT JOIN commercial.customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
             LEFT JOIN commercial.stock s
                    ON s.warehouse_id = o.warehouse_id AND s.product_id = ol.product_id
            WHERE o.status = 'confirmed'
              AND NOT EXISTS (SELECT 1 FROM commercial.wave_orders wo
                               WHERE wo.order_id = o.id AND wo.stage <> 'listo_embarque')
              -- El corazón: lo pedido no cabe en lo que hay.
              AND COALESCE(s.quantity, 0) < ol.quantity
              AND (?::uuid IS NULL OR o.warehouse_id = ?::uuid)
              AND (?::date IS NULL OR o.requested_delivery_date = ?::date)
              AND (?::text IS NULL OR c.sales_route = ?::text)
         )
         SELECT b.order_id, b.code, b.warehouse_id, b.warehouse_name,
                b.customer_name, b.sales_route, b.route_kind,
                b.product_id, p.sku, p.description AS product_name,
                b.pedida::numeric, b.hay::numeric, b.falta::numeric,
                -- (b.lat1 IS NULL) viaja a la pantalla: si la sucursal del PEDIDO no tiene
                -- coordenada, ninguna distancia se puede calcular y hay que decirlo.
                (b.lat1 IS NULL OR b.lng1 IS NULL) AS origen_sin_coordenada,
                COALESCE(sug.lista, '[]'::json) AS sugerencias
           FROM base b
           LEFT JOIN catalog.products p ON p.id = b.product_id
           LEFT JOIN LATERAL (
             SELECT json_agg(x ORDER BY x.km IS NULL, x.km) AS lista FROM (
               SELECT w2.id AS warehouse_id, w2.name,
                      s2.quantity::numeric AS disponible,
                      CASE WHEN w2.latitude IS NULL OR w2.longitude IS NULL
                                OR b.lat1 IS NULL OR b.lng1 IS NULL
                           THEN NULL ELSE round(${KM}::numeric, 1) END AS km,
                      (w2.latitude IS NULL OR w2.longitude IS NULL) AS sin_coordenada
                 FROM commercial.stock s2
                 JOIN commercial.warehouses w2
                      ON w2.id = s2.warehouse_id AND w2.tenant_id = s2.tenant_id
                WHERE s2.product_id = b.product_id
                  AND s2.warehouse_id <> b.warehouse_id
                  -- Sólo sirve si alcanza para TODO el faltante. Media solución obliga a
                  -- dos viajes, y el surtidor no puede decidir eso desde una pantalla.
                  AND s2.quantity >= b.falta
                  AND w2.active AND w2.deleted_at IS NULL
                  -- Los camiones de ruta tienen existencia pero NO son una sucursal a la que
                  -- se pueda ir a buscar: andan en la calle.
                  AND w2.kind = 'central'
                -- ⚠️ Se ordena por la EXPRESION, no por el alias km: dentro de una
                -- expresion (ORDER BY km IS NULL) Postgres resuelve km como columna de
                -- ENTRADA y falla con "column km does not exist" -- el alias de salida solo
                -- vale cuando va solo. Y se reusa la MISMA constante en vez de copiar la
                -- fórmula: con dos copias, la lista se ordenaría por un número distinto del
                -- que muestra el día que alguien toque una.
                -- (ojo: no se nombra la constante acá adentro — esto es un template literal
                --  y la interpolación ocurre TAMBIÉN dentro de un comentario SQL, pegando
                --  una fórmula multilínea que rompe el parser. Pasó al escribir esto.)
                -- NULLS LAST sale gratis: sin coordenada la aritmética ya da NULL, y el que
                -- no se puede medir se ofrece igual, pero al final.
                ORDER BY ${KM} NULLS LAST
                LIMIT 3
             ) x
           ) sug ON true
          ORDER BY b.warehouse_name, b.sales_route NULLS LAST, b.code`,
        [
          q.warehouse_id ?? null, q.warehouse_id ?? null,
          q.delivery_date ?? null, q.delivery_date ?? null,
          q.sales_route ?? null, q.sales_route ?? null,
        ],
      );

      const filtradas = q.route_kind?.length
        ? rows.filter((r: { route_kind: string | null }) =>
            q.route_kind?.includes(r.route_kind as string))
        : rows;

      // Separar los dos "no hay sugerencia" es el punto: uno se resuelve con un traslado y
      // el otro con una COMPRA. Si se ven igual, alguien sale a buscar lo que no existe.
      const sinSalida = filtradas.filter(
        (r: { sugerencias: unknown[] }) => !r.sugerencias?.length,
      ).length;

      return {
        data: filtradas,
        count: filtradas.length,
        /** Renglones que ninguna sucursal puede cubrir: no es un traslado, es una compra. */
        sin_alternativa: sinSalida,
        /** ⚠️ Lo capturado sin señal no llegó: este conteo es de lo que YA está en el servidor. */
        pendiente_offline: 'no_medible_desde_el_servidor',
      };
    });
  }

  /** Detalle de una ola: cabecera, sus pedidos y el consolidado por SKU. */
  async byId(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);

      const orders = [...(await this.cabecerasDe(trx, waveId)).values()].sort((a, b) =>
        a.code.localeCompare(b.code),
      );
      return { ...wave, orders, consolidated: await this.consolidado(trx, waveId) };
    });
  }

  /**
   * `[GP.2]` Cabeceras de los pedidos de una ola, vengan de la Suite o de Kepler, con una sola
   * forma. Lo usan el detalle y la hoja de reparto para no repetir la bifurcación.
   *
   * ⚠️ Un pedido Kepler cuya cabecera ya no aparece en el ODS se devuelve igual, con
   * `customer_name` y `total` en null: desaparecer de la ola sería peor que mostrarse sin datos.
   */
  private async cabecerasDe(trx: Knex.Transaction, waveId: string): Promise<Map<string, CabeceraDePedido>> {
    const wos: WaveOrderRow[] = await trx('commercial.wave_orders').where({ wave_id: waveId });
    const out = new Map<string, CabeceraDePedido>();

    const suite = wos.filter((w) => w.source !== 'kepler');
    if (suite.length) {
      const rows: Array<{ id: string; code: string; total: string | null; customer_name: string | null }> =
        await trx('commercial.orders as o')
          .leftJoin('commercial.customers as c', function (this: Knex.JoinClause) {
            this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
          })
          .whereIn(
            'o.id',
            suite.map((w) => w.order_id),
          )
          .select('o.id', 'o.code', 'o.total', 'c.name as customer_name');
      const porId = new Map(rows.map((r) => [r.id, r]));
      for (const w of suite) {
        const o = porId.get(w.order_id);
        out.set(w.order_id, {
          wave_order_id: w.id,
          order_id: w.order_id,
          source: 'suite',
          stage: w.stage,
          code: o?.code ?? w.order_id,
          customer_name: o?.customer_name ?? null,
          total: o?.total == null ? null : Number(o.total),
        });
      }
    }

    const kep = wos.filter((w) => w.source === 'kepler');
    if (kep.length) {
      const llaves = kep.map((w) => ({
        sucursal: w.kepler_sucursal,
        serie: Number(w.kepler_serie),
        folio: w.kepler_folio,
      }));
      const { rows } = await trx.raw(CABECERAS_POR_LLAVE_SQL, [JSON.stringify(llaves)]);
      const porLlave = new Map(
        (rows as CabeceraKeplerSqlRow[]).map((r) => [`${r.sucursal}/${Number(r.serie)}/${r.folio}`, r]),
      );
      for (const w of kep) {
        const h = porLlave.get(`${w.kepler_sucursal}/${Number(w.kepler_serie)}/${w.kepler_folio}`);
        out.set(w.order_id, {
          wave_order_id: w.id,
          order_id: w.order_id,
          source: 'kepler',
          stage: w.stage,
          code: documentoKepler({ serie: Number(w.kepler_serie), folio: String(w.kepler_folio) }),
          customer_name: h?.destino_nombre ?? null,
          total: h?.importe == null ? null : Number(h.importe),
          kepler_estatus: h?.estatus ?? null,
        });
      }
    }
    return out;
  }

  /**
   * `[GP.2]` Los renglones de TODOS los pedidos de la ola con una sola forma, vengan de la Suite
   * (`commercial.order_lines`) o de Kepler (`kdm2`, leído del ODS). De aquí salen el consolidado
   * y el reparto: si cada uno leyera por su lado, el día que uno cambie repartirían algo distinto
   * de lo que se surtió.
   *
   * Para Kepler, `quantity` va en la unidad BASE (`c9`/`c11`) y la presentación (`c56`/`c55`,
   * lo que dice la hoja) viaja aparte para mostrarse. Ver `LINEAS_KEPLER_DE_OLA_SQL`.
   */
  private async lineasDePedidos(trx: Knex.Transaction, waveId: string): Promise<LineaDePedido[]> {
    const suite: SuiteLineaRow[] = await trx('commercial.wave_orders as wo')
      .join('commercial.order_lines as ol', function (this: Knex.JoinClause) {
        this.on('ol.order_id', '=', 'wo.order_id').andOn('ol.tenant_id', '=', 'wo.tenant_id');
      })
      .leftJoin('catalog.products as p', function (this: Knex.JoinClause) {
        this.on('p.id', '=', 'ol.product_id').andOn('p.tenant_id', '=', 'ol.tenant_id');
      })
      .join('commercial.orders as o', function (this: Knex.JoinClause) {
        this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
      })
      .where('wo.wave_id', waveId)
      .whereNot('wo.source', 'kepler')
      .select(
        'ol.product_id',
        // ⚠️ `nombre`, no `name`: el catálogo conserva el español legacy (mismo nombre que usa
        // `commercial-orders` al leer sus líneas). Es la clase de columna que NO se adivina.
        'p.nombre as product_name',
        'p.sku',
        'ol.qty_unit',
        'ol.quantity',
        'o.code as order_code',
        'wo.order_id',
        // [GP.3] `to_char`: pg devuelve el `date` como objeto Date y el `String(...).slice(0,10)`
        // de abajo daba "Thu Oct 08" — el reparto ordenaba la prioridad de entrega por día de la
        // semana (Fri < Mon < Thu). Defecto que venía de SU.6; mismo caso que LC.16.
        trx.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS delivery_date`),
        'o.confirmed_at',
      );

    const { rows: kep } = await trx.raw(LINEAS_KEPLER_DE_OLA_SQL, [waveId]);

    const filas: LineaDePedido[] = [
      ...suite.map((r) => ({
        source: 'suite' as const,
        order_id: r.order_id,
        order_code: r.order_code,
        product_id: r.product_id,
        product_name: r.product_name,
        sku: r.sku,
        quantity: Number(r.quantity),
        qty_unit: r.qty_unit || null,
        qty_presentacion: null,
        unidad_presentacion: null,
        delivery_date: r.delivery_date ? String(r.delivery_date) : null,
        confirmed_at: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null,
      })),
      ...(kep as LineaKeplerSqlRow[]).map((r) => ({
        source: 'kepler' as const,
        order_id: r.order_id,
        order_code: documentoKepler({ serie: Number(r.serie), folio: r.folio }),
        product_id: r.product_id,
        product_name: r.product_name ?? r.descripcion,
        sku: r.sku,
        quantity: Number(r.quantity),
        qty_unit: r.qty_unit,
        qty_presentacion: r.qty_presentacion == null ? null : Number(r.qty_presentacion),
        unidad_presentacion: r.unidad_presentacion,
        // Kepler no tiene fecha de entrega comprometida: el desempate del reparto cae a la
        // fecha del pedido (más viejo primero) y luego al folio. Se declara null, no se inventa.
        delivery_date: null,
        confirmed_at: r.fecha ?? null,
      })),
    ];
    return filas.sort(
      (a, b) =>
        (a.product_name ?? '').localeCompare(b.product_name ?? '') || a.order_code.localeCompare(b.order_code),
    );
  }

  /**
   * `[GP.2]` Renglones de Kepler cuya clave no está en el catálogo. No pueden entrar a una ola
   * (`wave_lines.product_id` es NOT NULL). Se listan con su clave para que se pueda corregir.
   */
  private sinCatalogo(lineas: readonly LineaDePedido[]): string[] {
    return lineas.filter((l) => !l.product_id).map((l) => `${l.order_code} clave ${l.sku}`);
  }

  /**
   * `[GP.2]` Productos cuya cantidad pedida hoy (leída en vivo) ya no es la que se congeló en
   * `wave_lines` al arrancar. Sólo aplica a olas con pedidos de Kepler; en las de la Suite el
   * pedido confirmado no cambia y se devuelve `[]` sin consultar.
   */
  private async cambiosDesdeArranque(trx: Knex.Transaction, waveId: string): Promise<string[]> {
    const hayKepler = await trx('commercial.wave_orders').where({ wave_id: waveId, source: 'kepler' }).first('id');
    if (!hayKepler) return [];
    const congeladas: Array<{ product_id: string; qty_requested: string }> = await trx('commercial.wave_lines')
      .where({ wave_id: waveId })
      .select('product_id', 'qty_requested');
    const vivo = new Map(
      (await this.consolidado(trx, waveId)).map((c) => [c.product_id as string, { qty: c.total_base, sku: c.sku }]),
    );
    const out: string[] = [];
    for (const c of congeladas) {
      const v = vivo.get(c.product_id);
      const antes = Math.round(Number(c.qty_requested) * 1000);
      if (!v) out.push(`producto ${c.product_id} ya no está en el pedido`);
      else if (Math.round(v.qty * 1000) !== antes) out.push(`clave ${v.sku}: ${antes / 1000} → ${v.qty}`);
      vivo.delete(c.product_id);
    }
    for (const v of vivo.values()) out.push(`clave ${v.sku} agregada (${v.qty})`);
    return out;
  }

  /**
   * `[GP.2]` Lo que impide surtir una ola con pedidos de Kepler, o `[]` si nada.
   *
   *  · **Clave fuera del catálogo**: no hay `product_id` que guardar.
   *  · **El mismo producto en unidades distintas** (medido en prod: 248 pares sucursal×clave con
   *    más de una unidad en `kdm2.c11`, p. ej. PAQ y PZA). El motor suma por producto: juntar
   *    paquetes con piezas da un número que no se puede surtir ni repartir. Con pedidos de la Suite
   *    la cantidad ya viene en la unidad base y eso no pasa; con Kepler sí, así que se frena.
   */
  private bloqueosKepler(lineas: readonly LineaDePedido[]): string[] {
    return [...this.sinCatalogo(lineas).map((x) => `${x} fuera del catálogo`), ...unidadesMezcladas(lineas)];
  }

  /**
   * §11 del documento — el consolidado por SKU que recorre el surtidor.
   *
   * ⭐ Va SIEMPRE con la unidad al lado, y el desglose por pedido debajo. Dos razones, las dos
   * medidas:
   *
   *  1. Un número sin unidad es el defecto de ADR-055, que ya costó $866,805 de sobre-pedido. El
   *     catálogo no tiene una unidad uniforme: la base es PAQ en 6,586 SKUs, PZA en 1,906, KG en
   *     232, y 69% de los productos tienen más de una presentación. "Carlos V = 23" no le dice
   *     nada a quien tiene que agarrarlo del anaquel.
   *  2. El desglose por pedido es lo que hace posible la desconsolidación (SU.6). Si se pierde al
   *     consolidar, hay que reconstruirlo adivinando.
   *
   * ⚠️ `qty_unit` sale del sello que puso la captura (VU.2/VU.4). Cuando la línea no lo trae, la
   * cantidad está en unidad base y se declara `sin_unidad_declarada` — nunca se asume "pieza".
   */
  private async consolidado(trx: Knex.Transaction, waveId: string, yaLeidas?: LineaDePedido[]) {
    // [GP.2] Suite y Kepler con la misma forma. Los renglones Kepler sin producto en el catálogo
    // NO se consolidan (no hay `product_id` que agrupar ni que guardar): `createWave` y
    // `startPicking` los rechazan con su clave antes de llegar acá.
    // [GP.3] `startPicking` le pasa las líneas que ya leyó, para que lo consolidado y lo congelado
    // por pedido salgan de la MISMA lectura (dos lecturas a Kepler podrían diferir entre sí).
    const rows = (yaLeidas ?? (await this.lineasDePedidos(trx, waveId))).filter((r) => r.product_id);

    const porSku = new Map<string, any>();
    for (const r of rows as any[]) {
      let g = porSku.get(r.product_id);
      if (!g) {
        g = {
          product_id: r.product_id,
          product_name: r.product_name,
          sku: r.sku,
          total_base: 0,
          // ⚠️ Si dos pedidos capturaron el MISMO producto en unidades distintas, el total en la
          // unidad de captura no existe: se declara mixto y el surtidor cuenta en unidad base.
          unidades_capturadas: new Set<string>(),
          por_pedido: [] as any[],
        };
        porSku.set(r.product_id, g);
      }
      g.total_base += Number(r.quantity);
      // ⚠️ La ausencia se guarda como `null`, NO como el texto "sin_unidad_declarada". Un
      // centinela de texto se ve igual que una unidad real y termina viajando a la base como si
      // lo fuera (pasó: reventó el varchar(16) de `wave_lines.qty_unit`, y de haber cabido habría
      // quedado una "unidad" inventada en la tabla). ADR-056: la ausencia se declara, no se nombra.
      g.unidades_capturadas.add(r.qty_unit || null);
      g.por_pedido.push({
        order_id: r.order_id,
        order_code: r.order_code,
        quantity: Number(r.quantity),
        // [GP.2] Lo que dice la hoja de Kepler (3 BTO). Sólo para mostrar; null en pedidos de la Suite.
        presentacion:
          r.qty_presentacion == null ? null : { cantidad: r.qty_presentacion, unidad: r.unidad_presentacion },
      });
    }
    // [GP.2] Kepler trae KG con decimales: sumar en coma flotante da 0.30000000000000004. Se
    // redondea a milésimas, la precisión de `wave_lines.qty_requested` (numeric(14,3)).
    for (const g of porSku.values()) g.total_base = Math.round(g.total_base * 1000) / 1000;

    return Array.from(porSku.values()).map((g) => {
      const us = Array.from(g.unidades_capturadas) as (string | null)[];
      return {
        product_id: g.product_id,
        product_name: g.product_name,
        sku: g.sku,
        total_base: g.total_base,
        // Una sola unidad de captura Y que exista → se puede nombrar. Varias, o ninguna, → null:
        // no se inventa un total común ni se bautiza la ausencia.
        qty_unit: us.length === 1 && us[0] != null ? us[0] : null,
        unidad_mixta: us.length > 1,
        // Para mostrar: acá SÍ se rotula la ausencia, porque es texto de pantalla y no un dato
        // que se guarde. La distinción importa — lo que se persiste es el null de arriba.
        unidades_capturadas: us.map((u) => u ?? 'sin declarar'),
        por_pedido: g.por_pedido,
      };
    });
  }

  /** Lista de olas (bandeja del jefe de almacén). */
  async list(status?: string) {
    return this.tk.run(async (trx) => {
      let qb = trx('commercial.picking_waves as pw')
        .leftJoin('commercial.warehouses as w', function () {
          this.on('w.id', '=', 'pw.warehouse_id').andOn('w.tenant_id', '=', 'pw.tenant_id');
        });
      if (status) qb = qb.where('pw.status', status);
      return qb
        .select(
          'pw.*',
          'w.name as warehouse_name',
          trx.raw('(SELECT count(*) FROM commercial.wave_orders wo WHERE wo.wave_id = pw.id)::int AS orders_count'),
        )
        .orderBy('pw.created_at', 'desc')
        .limit(100);
    });
  }

  /**
   * Arma una ola con los pedidos dados.
   *
   * ⚠️ Un pedido que ya está en otra ola viva **no se roba en silencio**: se rechaza la operación
   * entera y se dice cuáles. El índice único parcial `ux_wo_order_viva` lo garantiza también en la
   * base, pero un 23505 crudo no le dice al jefe de almacén cuál pedido fue.
   */
  async createWave(dto: CreateWaveDto) {
    if (!UUID_RE.test(dto?.warehouse_id || '')) throw new BadRequestException('warehouse_id inválido');
    const ids = Array.from(new Set((dto?.order_ids || []).filter((x) => UUID_RE.test(x))));
    // [GP.2] Pedidos de Kepler por llave. Una llave mala es un 400 con la posición, no un pedido
    // que desaparece en silencio de la ola.
    const kCrudos = dto?.kepler_orders || [];
    const kepler: PedidoKeplerLlave[] = [];
    kCrudos.forEach((x, i) => {
      const k = normalizarLlave(x);
      if (!k) throw new BadRequestException(`kepler_orders[${i}] inválido: se espera { sucursal: '01', serie, folio }`);
      if (!kepler.some((y) => keplerOrderId(y) === keplerOrderId(k))) kepler.push(k);
    });
    if (!ids.length && !kepler.length) throw new BadRequestException('order_ids y kepler_orders vacíos');
    if (dto.delivery_date && !DATE_RE.test(dto.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');
    if (dto.assigned_to && !UUID_RE.test(dto.assigned_to))
      throw new BadRequestException('assigned_to inválido');

    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      if (ids.length) {
        const orders: Array<{ id: string; code: string; status: string; warehouse_id: string }> = await trx(
          'commercial.orders',
        )
          .whereIn('id', ids)
          .select('id', 'code', 'status', 'warehouse_id');
        if (orders.length !== ids.length) {
          const vistos = new Set(orders.map((o) => o.id));
          throw new NotFoundException(`Pedidos no encontrados: ${ids.filter((i) => !vistos.has(i)).join(', ')}`);
        }

        const noConfirmados = orders.filter((o) => o.status !== 'confirmed');
        if (noConfirmados.length)
          throw new ConflictException(
            `Solo entran pedidos confirmados. Fuera: ${noConfirmados.map((o) => `${o.code} (${o.status})`).join(', ')}`,
          );

        // Una ola recorre UN almacén: mezclar dos es un recorrido imposible.
        const otroAlmacen = orders.filter((o) => o.warehouse_id !== dto.warehouse_id);
        if (otroAlmacen.length)
          throw new ConflictException(
            `Estos pedidos se surten de otro almacén: ${otroAlmacen.map((o) => o.code).join(', ')}`,
          );

        const yaEnOla: Array<{ code: string }> = await trx('commercial.wave_orders as wo')
          .join('commercial.orders as o', function (this: Knex.JoinClause) {
            this.on('o.id', '=', 'wo.order_id').andOn('o.tenant_id', '=', 'wo.tenant_id');
          })
          .whereIn('wo.order_id', ids)
          .andWhere('wo.stage', '<>', 'listo_embarque')
          .select('o.code');
        if (yaEnOla.length)
          throw new ConflictException(`Ya están en otra ola: ${yaEnOla.map((r) => r.code).join(', ')}`);
      }

      // [GP.3c] validarKepler devuelve la cabecera de cada pedido: de ahí sale su destino.
      const cabsKepler = kepler.length ? await this.validarKepler(trx, dto.warehouse_id, kepler) : [];
      const destinoDe = (k: PedidoKeplerLlave) =>
        cabsKepler.find((c) => c.sucursal === k.sucursal && Number(c.serie) === k.serie && c.folio === k.folio);

      const code = await this.nextCode(trx);
      const [wave] = await trx('commercial.picking_waves')
        .insert({
          code,
          warehouse_id: dto.warehouse_id,
          delivery_date: dto.delivery_date || null,
          assigned_to: dto.assigned_to || null,
          notes: dto.notes || null,
          origen: dto.origen && (ORIGENES_KEPLER as readonly string[]).includes(dto.origen) ? dto.origen : null,
          armada_por: dto.armada_por === 'auto' ? 'auto' : 'consola',
          created_by: userId,
          updated_by: userId,
        })
        .returning('*');

      try {
        await trx('commercial.wave_orders').insert([
          ...ids.map((order_id) => ({ wave_id: wave.id, order_id, added_by: userId })),
          // [GP.2] El order_id de Kepler se DERIVA de la llave; el CHECK
          // `wave_orders_kepler_id_derivado` rechaza el INSERT si no coincide.
          ...kepler.map((k) => ({
            wave_id: wave.id,
            order_id: keplerOrderId(k),
            source: 'kepler',
            kepler_sucursal: k.sucursal,
            kepler_serie: k.serie,
            kepler_folio: k.folio,
            destino_code: destinoDe(k)?.cliente_code ?? null,
            destino_nombre: destinoDe(k)?.destino_nombre?.slice(0, 120) ?? null,
            added_by: userId,
          })),
        ]);
      } catch (e) {
        // [GP.2] Dos sesiones armando la ola del mismo pedido a la vez: la segunda choca con
        // `ux_wo_order_viva`. Es un 409 con mensaje, no un 500 con el texto de Postgres.
        if ((e as { code?: string }).code === '23505')
          throw new ConflictException('Otro usuario acaba de meter alguno de estos pedidos a una ola. Recargá el pool.');
        throw e;
      }

      // [GP.2] Con los pedidos de Kepler ya dentro de la ola (en esta misma transacción), se leen
      // sus renglones con la MISMA consulta que usarán el consolidado y el reparto. Si algo impide
      // surtir, se aborta todo: la ola no queda creada a medias.
      if (kepler.length) {
        const bloqueos = this.bloqueosKepler(await this.lineasDePedidos(trx, wave.id));
        if (bloqueos.length) throw new ConflictException(`No se puede armar la ola: ${bloqueos.join('; ')}`);
      }

      const total = ids.length + kepler.length;
      this.logger.log(`Ola ${code} creada con ${total} pedido(s) (${kepler.length} de Kepler)`);
      return { ...wave, orders_count: total };
    });
  }

  /**
   * `[GP.2]` Lo que tiene que cumplir un pedido de Kepler para entrar a una ola. Todo en la misma
   * transacción que el INSERT, y con mensajes que nombran el folio:
   *
   *   1. Es de la sucursal del almacén de la ola (una ola recorre UN almacén).
   *   2. Existe y su estatus VIGENTE en Kepler es `AUTORIZADO`. Uno que ya avanzó (SURTIDO,
   *      CHECADO…) lo está trabajando alguien por fuera de la Suite.
   *   3. No está en NINGUNA ola (ni siquiera ya lista para embarque: en Kepler sigue AUTORIZADO
   *      hasta que se capture, y sin esto se podría surtir dos veces).
   *   4. Tiene renglones, y todas sus claves existen en el catálogo (`wave_lines.product_id` es
   *      NOT NULL).
   */
  private async validarKepler(
    trx: Knex.Transaction,
    warehouseId: string,
    kepler: readonly PedidoKeplerLlave[],
  ): Promise<CabeceraKeplerSqlRow[]> {
    const sucursal = await this.sucursalDeAlmacen(trx, warehouseId);
    const otra = kepler.filter((k) => k.sucursal !== sucursal);
    if (otra.length)
      throw new ConflictException(
        `Estos pedidos son de otra sucursal (la ola es de la ${sucursal}): ${otra
          .map((k) => `${k.sucursal} ${documentoKepler(k)}`)
          .join(', ')}`,
      );

    const { rows } = await trx.raw(CABECERAS_POR_LLAVE_SQL, [JSON.stringify(kepler)]);
    const cabs = rows as CabeceraKeplerSqlRow[];
    const noExisten = cabs.filter((r) => r.estatus == null);
    if (noExisten.length)
      throw new NotFoundException(
        `Pedidos no encontrados en Kepler, o sin estatus: ${noExisten.map((r) => documentoKepler({ serie: r.serie, folio: r.folio })).join(', ')}`,
      );
    const noAutorizados = cabs.filter((r) => r.estatus !== 'AUTORIZADO');
    if (noAutorizados.length)
      throw new ConflictException(
        `Solo entran pedidos AUTORIZADO en Kepler. Fuera: ${noAutorizados
          .map((r) => `${documentoKepler({ serie: r.serie, folio: r.folio })} (${r.estatus})`)
          .join(', ')}`,
      );

    const yaEnOla: Array<{ kepler_serie: number; kepler_folio: string }> = await trx('commercial.wave_orders')
      .whereIn('order_id', kepler.map(keplerOrderId))
      .select('kepler_serie', 'kepler_folio');
    if (yaEnOla.length)
      throw new ConflictException(
        `Ya están en una ola: ${yaEnOla
          .map((r) => documentoKepler({ serie: Number(r.kepler_serie), folio: r.kepler_folio }))
          .join(', ')}`,
      );

    // Renglones y catálogo, con la MISMA consulta que usa el pool: si difieren, la ola pasaría
    // la validación y fallaría al arrancar. La ventana arranca en el pedido más viejo de la lista.
    const desde = cabs.map((r) => r.fecha as string).sort()[0];
    const { rows: pool } = await trx.raw(POOL_KEPLER_SQL, [sucursal, desde, null, null]);
    const porLlave = new Map((pool as PoolKeplerSqlRow[]).map((p) => [`${Number(p.serie)}/${p.folio}`, p]));
    const problemas: string[] = [];
    for (const k of kepler) {
      const p = porLlave.get(`${k.serie}/${k.folio}`);
      if (!p || Number(p.renglones) === 0) problemas.push(`${documentoKepler(k)} sin renglones`);
      else if (Number(p.sin_catalogo) > 0)
        problemas.push(`${documentoKepler(k)}: ${p.sin_catalogo} renglón(es) con clave fuera del catálogo`);
    }
    if (problemas.length) throw new ConflictException(`No se pueden surtir: ${problemas.join('; ')}`);
    return cabs;
  }

  /**
   * `[VEC.5]` Arma la ola de un tipo de ruta en un clic: **el "pedido global"**.
   *
   * ── Por qué un botón y NO un cron ───────────────────────────────────────────────────
   * El pedido decía "en cuanto agende el pedido … se genera un pedido global". Tomarlo al pie
   * de la letra —crear/ampliar la ola en el instante de cada `place()`— tiene dos problemas
   * que lo vuelven peor que el trabajo manual:
   *
   *   1. El primer pedido del día crearía una ola **de un solo renglón**, y consolidar por SKU
   *      sobre un pedido no consolida nada: el valor de la ola es juntar.
   *   2. Peor: un pedido que entra a las 11:40 se sumaría a una ola que alguien **ya está
   *      caminando** con su lista impresa. Mercancía que aparece a mitad del recorrido es
   *      exactamente cómo se arma mal un pedido.
   *
   * Entonces el aviso (`[VEC.4]`) es **inmediato** y el armado es **a demanda**: la sucursal
   * ve que tiene 15 pedidos vecinales y arma su ola cuando decide cerrar el corte. Quien
   * decide cuándo se cierra es quien va a caminar el almacén.
   *
   * ⚠️ **Nunca toca una ola existente.** Crea una nueva con lo que todavía no está en ninguna
   * (el pool ya excluye lo que está en ola viva). Por eso es seguro repetir el clic: la segunda
   * vez no hay elegibles y responde `creada: false` en vez de crear una ola vacía.
   *
   * ⚠️ **No crea olas vacías.** Una ola sin pedidos se ve en la bandeja igual que una real y
   * ensucia el folio; si no hay nada que armar, lo dice.
   */
  async crearOlaAuto(dto: {
    warehouse_id: string;
    delivery_date?: string;
    route_kind?: readonly string[];
    /**
     * `[VEC.8]` Armar la ola de UNA ruta. Es la forma que evita mezclar: una ola = una ruta,
     * así el consolidado por SKU ya sale separado y no hay que desconsolidar a mano.
     */
    sales_route?: string;
    assigned_to?: string;
  }) {
    if (!UUID_RE.test(dto?.warehouse_id || '')) throw new BadRequestException('warehouse_id inválido');
    if (dto.delivery_date && !DATE_RE.test(dto.delivery_date))
      throw new BadRequestException('delivery_date debe ser YYYY-MM-DD');

    // El universo sale del MISMO `pool()` que ve la pantalla. Si armara su propia consulta,
    // el día que una de las dos cambie el almacén armaría algo distinto de lo que vio — y esa
    // divergencia no se nota hasta que falta mercancía.
    const elegibles = await this.pool({
      warehouse_id: dto.warehouse_id,
      delivery_date: dto.delivery_date,
      route_kind: dto.route_kind,
      sales_route: dto.sales_route,
      limit: 500,
    });

    if (!elegibles.data.length) {
      return {
        creada: false,
        motivo: 'sin_pedidos_elegibles',
        detalle:
          'No hay pedidos confirmados fuera de ola para ese almacén/fecha/tipo de ruta. ' +
          'No se crea una ola vacía: ensuciaría el folio y se vería igual que una real.',
        // ⚠️ Lo que el pool NO puede ver se arrastra hasta acá: un pedido tomado sin señal
        // todavía no llegó al servidor. "No hay nada que armar" y "no ha llegado todavía" se
        // leen igual en pantalla si no se dice (ADR-056).
        pendiente_offline: elegibles.pendiente_offline,
      };
    }

    // ⚠️ `pool()` y `createWave()` abren transacciones distintas, así que entre las dos otra
    // sesión puede llevarse un pedido a su ola. NO se arregla fusionándolas: `createWave` ya
    // valida `yaEnOla` y tira 409 nombrando los pedidos. Se prefiere un error ruidoso —que
    // obliga a reintentar y arma la ola correcta— a una ola que se lleva algo que otro almacén
    // ya estaba caminando.
    const wave = await this.createWave({
      warehouse_id: dto.warehouse_id,
      delivery_date: dto.delivery_date,
      order_ids: elegibles.data.map((o: { id: string }) => o.id),
      assigned_to: dto.assigned_to,
      // La nota dice de qué es la ola. Si es de una ruta, se nombra: el surtidor tiene que
      // poder leer en la bandeja para quién es sin abrirla.
      notes: dto.sales_route
        ? `Automática — ruta ${dto.sales_route}`
        : `Automática — ${dto.route_kind?.length ? dto.route_kind.join('/') : 'todos los tipos'}`,
    });

    this.logger.log(
      `[VEC.5] Ola ${wave.code} armada sola: ${elegibles.data.length} pedido(s) ` +
        `(${dto.route_kind?.join('/') || 'todos'}) en ${dto.warehouse_id}`,
    );
    return { creada: true, ...wave, pendiente_offline: elegibles.pendiente_offline };
  }

  /** Asigna (o reasigna) la ola a un surtidor. */
  async assign(waveId: string, assignedTo: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    if (!UUID_RE.test(assignedTo)) throw new BadRequestException('assigned_to inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se surtió');

      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({ assigned_to: assignedTo, updated_at: trx.fn.now(), updated_by: userId })
        .returning('*');
      return upd;
    });
  }

  /**
   * Cancela la ola. Los pedidos vuelven al pool solos: el pool los encuentra porque el índice
   * `ux_wo_order_viva` deja de aplicar cuando se borran sus renglones.
   *
   * ⚠️ Se BORRAN los `wave_orders` en vez de marcarlos: si se conservaran con su `stage`, el
   * índice único parcial seguiría reservando al pedido y no podría entrar a otra ola — el pedido
   * quedaría preso por una ola que ya no existe.
   */
  async cancelWave(waveId: string, reason?: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'surtida') throw new ConflictException('Una ola ya surtida no se cancela');
      if (wave.status === 'cancelada') return wave; // idempotente

      await trx('commercial.wave_orders').where({ wave_id: waveId }).del();
      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({
          status: 'cancelada',
          notes: reason ? `${wave.notes ? wave.notes + ' · ' : ''}Cancelada: ${reason}` : wave.notes,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');
      return upd;
    });
  }

  /**
   * Arranca el surtido: congela el consolidado en `wave_lines` y marca la ola `en_surtido`.
   *
   * ⚠️ El congelado va ACÁ y no al crear la ola: un pedido corregido entre armar y empezar dejaría
   * a la persona buscando una cantidad que ya nadie pidió. Y una vez arrancada no se recalcula —
   * el papel que se está recorriendo no puede cambiar debajo.
   *
   * Idempotente: arrancar dos veces devuelve las líneas ya congeladas sin pisar lo levantado.
   */
  async startPicking(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se surtió');

      const yaHay = await trx('commercial.wave_lines').where({ wave_id: waveId }).first();
      if (!yaHay) {
        // [GP.2] El catálogo y el pedido de Kepler pudieron cambiar entre armar la ola y
        // arrancarla. Un renglón sin producto, o un producto en dos unidades, no se puede congelar
        // sin inventar; saltarlo mandaría el pedido corto sin que nadie lo decidiera. Se frena.
        const lineas = await this.lineasDePedidos(trx, waveId);
        const bloqueos = this.bloqueosKepler(lineas);
        if (bloqueos.length) throw new ConflictException(`No se puede arrancar: ${bloqueos.join('; ')}`);
        const cons = await this.consolidado(trx, waveId, lineas);
        if (!cons.length) throw new ConflictException('La ola no tiene renglones que surtir');

        // [GP.3] Lo que pidió cada pedido, congelado: contra esto se reparte al cerrar. Un pedido
        // de Kepler sigue editable mientras se surte; el surtidor caminó contra ESTO.
        const congelados = congelarPorPedido(lineas);
        if (congelados.length) {
          await trx('commercial.wave_order_lines').insert(
            congelados.map((p) => ({ wave_id: waveId, ...p, created_by: userId })),
          );
        }
        const porProducto = new Map<string, PedidoCongelado[]>();
        for (const p of congelados) {
          porProducto.set(p.product_id, [...(porProducto.get(p.product_id) ?? []), p]);
        }

        // [GP.3] El total del renglón es la SUMA de lo congelado por pedido, no el consolidado:
        // redondeados por separado podían diferir en ±0.001 con KG de más de 3 decimales, y el
        // reparto habría dejado un "faltante" falso. Un producto sin nada congelado (cantidades en
        // cero) no se surte.
        const totalCongelado = (productId: string): number =>
          (porProducto.get(productId) ?? []).reduce((s, p) => s + Math.round(p.qty_requested * 1000), 0) / 1000;
        const renglones = cons.filter((c) => totalCongelado(c.product_id) > 0);
        if (!renglones.length) throw new ConflictException('La ola no tiene renglones que surtir');
        await trx('commercial.wave_lines').insert(
          renglones.map((c) => {
            // [GP.3] Lo que cuenta el surtidor (3 BTO), si todos los pedidos lo piden igual.
            const pres = presentacionDeProducto(porProducto.get(c.product_id) ?? []);
            return {
              wave_id: waveId,
              product_id: c.product_id,
              qty_requested: totalCongelado(c.product_id),
              // La unidad viaja con la cantidad, o se declara ausente. Nunca 'PZA' de relleno.
              qty_unit: c.unidad_mixta ? null : c.qty_unit,
              unidad_mixta: !!c.unidad_mixta,
              qty_presentacion: pres?.cantidad ?? null,
              unidad_presentacion: pres?.unidad ?? null,
            };
          }),
        );
      }

      if (wave.status !== 'en_surtido') {
        await trx('commercial.picking_waves').where({ id: waveId }).update({
          status: 'en_surtido',
          started_at: wave.started_at || trx.fn.now(),
          picked_by: wave.picked_by || userId,
          updated_at: trx.fn.now(),
          updated_by: userId,
        });
      }
      return this.lineasDe(trx, waveId);
    });
  }

  /**
   * Marca un renglón: cuánto se levantó y por qué, si no fue todo.
   *
   * ⭐ **No detiene el surtido** (§14 del documento, y es la regla correcta): un faltante se
   * registra y la persona sigue. Lo que se hace con ese faltante —sustituir, traspasar, avisar al
   * vendedor— es trabajo del motor comercial, asíncrono, y no puede bloquear el recorrido.
   */
  async pickLine(
    waveId: string,
    lineId: string,
    dto: { qty_picked: number; status?: string; note?: string; bin_code?: string },
  ) {
    if (!UUID_RE.test(waveId) || !UUID_RE.test(lineId)) throw new BadRequestException('id inválido');
    const qty = Number(dto?.qty_picked);
    if (!Number.isFinite(qty) || qty < 0) throw new BadRequestException('qty_picked debe ser >= 0');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') throw new ConflictException('La ola ya se cerró');

      const line = await trx('commercial.wave_lines').where({ id: lineId, wave_id: waveId }).first();
      if (!line) throw new NotFoundException(`Renglón ${lineId} no encontrado en esta ola`);
      if (qty > Number(line.qty_requested))
        throw new BadRequestException(
          `No se puede levantar más de lo pedido (${line.qty_requested}). Si sobra mercancía, es un ajuste de inventario, no un surtido.`,
        );

      // El estado se DERIVA de la cantidad salvo que la persona declare una causa (agotado/dañado):
      // "levanté 0" y "levanté 0 porque estaba dañado" son hechos distintos.
      const declarado = String(dto?.status || '').trim();
      let status: string;
      if (declarado && ['agotado', 'danado', 'faltante', 'surtido'].includes(declarado)) {
        status = declarado;
      } else if (qty === 0) {
        status = 'agotado';
      } else if (qty < Number(line.qty_requested)) {
        status = 'faltante';
      } else {
        status = 'surtido';
      }

      const [upd] = await trx('commercial.wave_lines')
        .where({ id: lineId })
        .update({
          qty_picked: qty,
          status,
          note: dto?.note ?? line.note,
          bin_code: dto?.bin_code ?? line.bin_code,
          picked_by: userId,
          picked_at: trx.fn.now(),
        })
        .returning('*');
      return upd;
    });
  }

  /**
   * Cierra el surtido de la ola.
   *
   * ⚠️ Exige que TODOS los renglones se hayan tocado. Un renglón `pendiente` al cerrar no es "no
   * había": es **nadie pasó por ahí**, y esa diferencia es justamente la que se pierde si se deja
   * cerrar con pendientes (quedaría indistinguible de un agotado, y el pedido saldría corto sin
   * que nadie lo supiera).
   */
  async finishPicking(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).forUpdate().first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status === 'cancelada') throw new ConflictException('La ola está cancelada');
      if (wave.status === 'surtida') return wave; // idempotente
      // [GP.3] Sólo se cierra lo que se arrancó. Una ola `abierta` (asignada pero sin arrancar) no
      // tiene renglones, así que "0 pendientes" la dejaba cerrar como surtida sin que nadie
      // surtiera nada (lo encontró la revisión de GP.3).
      if (wave.status !== 'en_surtido')
        throw new ConflictException(`La ola no está en surtido (está '${wave.status}'): arráncala primero.`);
      const hayRenglones = await trx('commercial.wave_lines').where({ wave_id: waveId }).first('id');
      if (!hayRenglones) throw new ConflictException('La ola no tiene renglones: no hay nada que cerrar.');

      const pend = await trx('commercial.wave_lines')
        .where({ wave_id: waveId, status: 'pendiente' })
        .count('* as n')
        .first();
      const sinTocar = Number(pend?.n ?? 0);
      if (sinTocar > 0)
        throw new ConflictException(
          `Faltan ${sinTocar} renglón(es) sin tocar. Marcá cada uno —aunque sea en 0— antes de cerrar: ` +
            'un renglón sin tocar no es lo mismo que uno agotado.',
        );

      // [GP.3] Si el pedido cambió en Kepler después de arrancar, ya NO se frena el cierre (GP.2
      // lo frenaba): el reparto usa lo congelado al arrancar, que es contra lo que el surtidor
      // caminó. El cambio se DECLARA en la respuesta para que el checador y el cuadre (GP.6) lo
      // vean — no se esconde. Sólo una ola sin congelado (anterior a GP.3) sigue frenando.
      const cambios = await this.cambiosDesdeArranque(trx, waveId);
      const tieneCongelado = await trx('commercial.wave_order_lines').where({ wave_id: waveId }).first('id');
      if (cambios.length && !tieneCongelado)
        throw new ConflictException(
          `El pedido cambió en Kepler después de arrancar el surtido: ${cambios.join('; ')}. ` +
            'Cancelá la ola y volvé a armarla con el pedido actual.',
        );

      const [upd] = await trx('commercial.picking_waves')
        .where({ id: waveId })
        .update({
          status: 'surtida',
          finished_at: trx.fn.now(),
          picked_by: wave.picked_by || userId,
          updated_at: trx.fn.now(),
          updated_by: userId,
        })
        .returning('*');

      // SU.6 — repartir lo levantado entre los pedidos, en la MISMA transacción: si el reparto
      // fallara después, la ola quedaría cerrada y nadie sabría a quién le toca qué.
      const reparto = await this.repartirYGuardar(trx, waveId);

      await trx('commercial.wave_orders').where({ wave_id: waveId }).update({
        stage: 'desconsolidado',
        updated_at: trx.fn.now(),
      });
      return { ...upd, reparto, cambios_en_kepler: cambios };
    });
  }

  /**
   * SU.6 — calcula el reparto con la función PURA (`allocation.ts`, probada por unidad) y lo
   * guarda. Acá sólo se leen filas y se escriben: la decisión de a quién se le queda corto el
   * pedido vive en la función, fuera de la base, para que se pueda probar sin ella.
   */
  private async repartirYGuardar(trx: any, waveId: string) {
    const lineas = await trx('commercial.wave_lines').where({ wave_id: waveId });
    if (!lineas.length) return [];

    // Lo que pidió cada pedido de cada producto, con lo que hace falta para ordenarlos.
    // [GP.3] Se reparte contra lo CONGELADO al arrancar (`wave_order_lines`): es contra lo que el
    // surtidor caminó. Sólo una ola arrancada antes de [GP.3] no lo tiene; ésa cae a la lectura
    // en vivo de [GP.2] (medido: en prod no existe ninguna, pero el camino queda para no romper).
    // ⚠️ `to_char` y no `String(fecha).slice(0,10)`: pg devuelve un `date` como objeto Date y
    // `String()` da "Thu Oct 08" — el reparto ordenaría por día de la semana (mismo defecto de LC.16).
    const congelados: PedidoCongelado[] = await trx('commercial.wave_order_lines')
      .where({ wave_id: waveId })
      .select(
        'order_id', 'order_code', 'product_id', 'qty_requested', 'qty_unit', 'qty_presentacion',
        'unidad_presentacion',
        trx.raw(`to_char(delivery_date, 'YYYY-MM-DD') AS delivery_date`),
        'confirmed_at',
      );
    const pedidos = congelados.length
      ? congelados.map((c) => ({
          product_id: c.product_id,
          order_id: c.order_id,
          order_code: c.order_code,
          quantity: Number(c.qty_requested),
          delivery_date: c.delivery_date ?? null,
          confirmed_at: c.confirmed_at ? new Date(c.confirmed_at).toISOString() : null,
        }))
      : (await this.lineasDePedidos(trx, waveId)).filter((r) => r.product_id);

    const porProducto = new Map<string, any[]>();
    for (const r of pedidos) {
      const arr = porProducto.get(r.product_id as string) ?? [];
      // [GP.2] Un pedido de Kepler puede traer el MISMO producto en dos renglones. Se suman: el
      // reparto es por (pedido, producto) y `wave_allocations` tiene UNIQUE sobre eso — dos
      // entradas del mismo pedido harían fallar el cierre de la ola.
      const ya = arr.find((x) => x.order_id === r.order_id);
      if (ya) {
        ya.qty_requested = Math.round((ya.qty_requested + r.quantity) * 1000) / 1000;
        continue;
      }
      arr.push({
        order_id: r.order_id,
        order_code: r.order_code,
        qty_requested: r.quantity,
        delivery_date: r.delivery_date,
        confirmed_at: r.confirmed_at,
      });
      porProducto.set(r.product_id as string, arr);
    }

    const ola = repartirOla(
      (lineas as any[]).map((l) => ({
        product_id: l.product_id,
        qty_picked: l.qty_picked == null ? null : Number(l.qty_picked),
        pedidos: porProducto.get(l.product_id) ?? [],
      })),
    );

    const filas: any[] = [];
    for (const r of ola) {
      for (const a of r.reparto) {
        filas.push({
          wave_id: waveId,
          order_id: a.order_id,
          product_id: r.product_id,
          qty_requested: a.qty_requested,
          qty_allocated: a.qty_allocated,
          rule_applied: a.regla,
        });
      }
    }
    if (filas.length) {
      // Idempotente: cerrar dos veces no duplica ni pisa con otro criterio.
      await trx('commercial.wave_allocations')
        .insert(filas)
        .onConflict(['tenant_id', 'wave_id', 'order_id', 'product_id'])
        .merge(['qty_requested', 'qty_allocated', 'rule_applied']);
    }
    return resumenPorPedido(ola);
  }

  /** Lo que le toca a cada pedido de la ola (la hoja con la que se separa la mercancía). */
  async allocations(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => {
      // [GP.2] La cabecera (folio, cliente, etapa) sale de `cabecerasDe`, que sabe leer Suite y
      // Kepler. Un JOIN a `commercial.orders` dejaba fuera en silencio a los pedidos de Kepler.
      const cab = await this.cabecerasDe(trx, waveId);
      const crudas: Array<{
        order_id: string;
        product_id: string;
        qty_requested: string;
        qty_allocated: string;
        rule_applied: string;
        product_name: string | null;
        sku: string | null;
      }> = await trx('commercial.wave_allocations as wa')
        .leftJoin('catalog.products as p', function (this: Knex.JoinClause) {
          this.on('p.id', '=', 'wa.product_id').andOn('p.tenant_id', '=', 'wa.tenant_id');
        })
        .where('wa.wave_id', waveId)
        .select('wa.*', 'p.nombre as product_name', 'p.sku');
      const filas = crudas
        .map((f) => {
          const h = cab.get(f.order_id);
          return {
            ...f,
            order_code: h?.code ?? f.order_id,
            customer_name: h?.customer_name ?? null,
            stage: h?.stage ?? null,
          };
        })
        .sort(
          (a, b) =>
            a.order_code.localeCompare(b.order_code) || (a.product_name ?? '').localeCompare(b.product_name ?? ''),
        );

      // Agrupado por pedido: así es como se separa físicamente (una caja por cliente).
      const porPedido = new Map<string, any>();
      for (const f of filas as any[]) {
        let g = porPedido.get(f.order_id);
        if (!g) {
          g = {
            order_id: f.order_id,
            order_code: f.order_code,
            customer_name: f.customer_name,
            stage: f.stage,
            completo: true,
            items: [] as any[],
          };
          porPedido.set(f.order_id, g);
        }
        if (Number(f.qty_allocated) < Number(f.qty_requested)) g.completo = false;
        g.items.push({
          product_id: f.product_id,
          product_name: f.product_name,
          sku: f.sku,
          qty_requested: Number(f.qty_requested),
          qty_allocated: Number(f.qty_allocated),
          rule_applied: f.rule_applied,
        });
      }
      return Array.from(porPedido.values());
    });
  }

  /**
   * SU.7 — re-verificación de UN pedido: lo separado contra lo físico.
   *
   * ⚠️ Se llama **re-verificación** y no "chequeo": con una sola persona (decisión de Edgar) no es
   * un control cruzado, y decirle control a algo que no lo es sería peor que no tenerlo. Se guarda
   * `verified_by` aparte de `picked_by` para poder MEDIR en qué proporción coinciden — el día que
   * sean dos personas, el gate se enciende sin migrar nada.
   */
  async verifyOrder(waveId: string, orderId: string) {
    if (!UUID_RE.test(waveId) || !UUID_RE.test(orderId))
      throw new BadRequestException('id inválido');
    const userId = this.tenantCtx.get()?.userId || null;

    return this.tk.run(async (trx) => {
      const wave = await trx('commercial.picking_waves').where({ id: waveId }).first();
      if (!wave) throw new NotFoundException(`Ola ${waveId} no encontrada`);
      if (wave.status !== 'surtida')
        throw new ConflictException(
          `Sólo se verifica una ola ya surtida (está en '${wave.status}'). Terminá el recorrido primero.`,
        );

      const wo = await trx('commercial.wave_orders')
        .where({ wave_id: waveId, order_id: orderId })
        .first();
      if (!wo) throw new NotFoundException('Ese pedido no está en esta ola');
      if (wo.stage === 'listo_embarque') return wo; // idempotente

      const [upd] = await trx('commercial.wave_orders')
        .where({ id: wo.id })
        .update({
          stage: 'listo_embarque',
          verified_by: userId,
          verified_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      return upd;
    });
  }

  /** Renglones de la ola con su avance (lo que ve la persona mientras recorre). */
  private async lineasDe(trx: any, waveId: string) {
    return trx('commercial.wave_lines as wl')
      .leftJoin('catalog.products as p', function (this: any) {
        this.on('p.id', '=', 'wl.product_id').andOn('p.tenant_id', '=', 'wl.tenant_id');
      })
      .where('wl.wave_id', waveId)
      .select('wl.*', 'p.nombre as product_name', 'p.sku', 'p.barcode')
      .orderByRaw(
        // Lo pendiente primero (es lo que falta caminar); dentro, por ubicación y nombre.
        `CASE WHEN wl.status = 'pendiente' THEN 0 ELSE 1 END, wl.bin_code NULLS LAST, p.nombre`,
      );
  }

  /** Renglones de la ola (público, para la pantalla). */
  async lines(waveId: string) {
    if (!UUID_RE.test(waveId)) throw new BadRequestException('waveId inválido');
    return this.tk.run(async (trx) => this.lineasDe(trx, waveId));
  }

  /** Folio `W-YYYY-NNNNN`, con el mismo UPSERT atómico de `commercial.order_sequences`. */
  private async nextCode(trx: any): Promise<string> {
    const tenantId = this.tenantCtx.requireTenantId();
    const year = new Date().getFullYear();
    const [{ current_value }] = await trx
      .raw(
        `INSERT INTO commercial.wave_sequences (tenant_id, year, current_value)
         VALUES (?, ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.wave_sequences.current_value + 1,
               updated_at = now()
         RETURNING current_value`,
        [tenantId, year],
      )
      .then((r: any) => r.rows);
    return `W-${year}-${String(current_value).padStart(5, '0')}`;
  }
}
