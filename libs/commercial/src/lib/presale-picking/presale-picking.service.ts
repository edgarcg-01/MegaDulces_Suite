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
  PresalePickSubstitution,
  PresaleReviewResult,
  PresaleSellerOrder,
  PresaleSellerStatusResponse,
  PresaleOtherUnitsResponse,
  PresaleOrderRow,
  PresaleSubstituteCandidate,
  PresaleSubstituteResponse,
} from '@megadulces/contracts';
import { esNombreDePromocion } from '@megadulces/contracts';
import { estadoDeProductos } from '../commercial-inventory/stock-state';
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
import {
  ordenarSugerencias,
  palabrasClave,
  puntuarSustituto,
  topeEnUnidad,
  unidadesDeEscalera,
  unidadesMasChicas,
  unidadSugerida,
} from './presale-substitute.engine';
import { PEDIDO_EN_RUTA_SQL, SURTIDO_DE_RUTA } from './presale-route.engine';
import { MOTIVOS_SURTIDO, MOTIVO_OBLIGATORIO_EN_SERVIDOR } from '@megadulces/contracts';
import { MotivoInvalido, armarJustificantes, conMotivosEnReporte, exigirMotivosDeRenglones, motivosPorRenglon } from '../commercial-orders/justificantes.engine';
import { historiaDeCambios } from '../commercial-orders/justificantes.lectura';

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

/** `[MCP.10]` Lo que se lee además para la copia de un renglón que se borra al surtir. */
type FilaCopia = {
  qty_factor_source: string | null; discount_percent: string | number; unit_price: string | number;
  tax_rate: string | number; source_warehouse_id: string | null; line_number: string | number | null; notes: string | null;
};

/** Una fila de `commercial.presale_picks`. */
type FilaPick = {
  id: string; order_id: string; started_by: string; started_by_name: string; started_at: Date | string;
  finished_by: string | null; finished_by_name: string | null; finished_at: Date | string | null;
  outcome: 'completo' | 'con_faltantes' | null; report: PresalePickReport | null; seller_seen_at: Date | string | null;
  // [MCP.10.1] La revisión en caja (mig 20261029125146).
  reviewed_by?: string | null; reviewed_by_name?: string | null; reviewed_at?: Date | string | null; review?: PresaleReviewResult | null;
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
      const reporte = (fila['report'] as PresalePickReport | null) ?? null;
      const revisado = !!fila['reviewed_at'];
      // [MCP.13] Los renglones que el surtidor puso en lugar de otro.
      const enLugarDe = new Map((reporte?.substituted ?? []).map((x) => [x.line_id, { product_name: x.for_product_name, sku: x.for_sku }]));
      const lines: PresalePickLine[] = (lineas as FilaRenglon[]).map((l) => {
        const m = cantidadMostrada({ quantity: Number(l.quantity), qty_unit: l.qty_unit, qty_factor: l.qty_factor == null ? null : Number(l.qty_factor) });
        // [MCP.10.1] Cerrado: lo que quedó en el pedido es lo que hubo... SALVO que la caja lo haya cambiado.
        // Lo que surtió el surtidor sale del reporte; si no aparece ahí, surtió lo que dice el pedido.
        const surtido = fila['finished_at'] ? surtidoPorElSurtidor({ line_id: l.id, product_id: l.product_id, product_name: l.product_name ?? 'Producto', unit: m.unit }, reporte, m.qty) : null;
        return {
          line_id: l.id, product_id: l.product_id, sku: l.sku ?? null, barcode: l.barcode ?? null, product_name: l.product_name ?? 'Producto',
          qty: m.qty, unit: m.unit, factor: m.factor,
          picked: surtido,
          ...(revisado ? { final: m.qty } : {}),
          ...(enLugarDe.has(l.id) ? { substitutes: enLugarDe.get(l.id) } : {}),
        };
      });
      // [MCP.18] Por qué cambió: lo que corrigió la vendedora, lo que quitó el surtido y lo que quitó la caja.
      const revision = revisado ? ((await trx('commercial.presale_picks').where({ order_id: orderId }).first('review'))?.review ?? null) : null;
      const justifications = armarJustificantes({
        historia: (await historiaDeCambios(trx, [orderId])).get(orderId) ?? [],
        reporte,
        surtio: fila['finished_at'] ? { name: (fila['finished_by_name'] as string) ?? null, at: fila['finished_at'] as string } : null,
        revision,
        reviso: revisado ? { name: (fila['reviewed_by_name'] as string) ?? null, at: fila['reviewed_at'] as string } : null,
      });
      return { order: this.aRenglon(fila, hoy), lines, justifications };
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
        // [MCP.13] Si el surtidor cambió algo por otro producto, la vendedora lo sabe desde el aviso.
        // [MCP.17] Lo surtido en otra unidad del mismo producto no es «por otro»: se dice aparte.
        const u = (report.substituted ?? []).filter((s) => s.same_product).length;
        const c = (report.substituted?.length ?? 0) - u;
        const falto = `faltó ${n} ${n === 1 ? 'producto' : 'productos'}`
          + (c ? ` · ${c} ${c === 1 ? 'cambiado' : 'cambiados'} por otro` : '')
          + (u ? ` · ${u} en otra unidad` : '');
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
    marcados: PresalePickFinishRequest['lines'],
    quien: { userId: string; nombre: string },
    /** `[MCP.18]` D4. El surtido por ruta (apagado) no pide motivo en su pantalla: pasa `false`. */
    opts: { exigirMotivos?: boolean } = {},
  ): Promise<{ outcome: PlanCierre['outcome']; report: PresalePickReport | null; plan: PlanCierre }> {
    const orderId = fila['id'] as string;
    const lineas = await trx('commercial.order_lines as l')
      .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
      .where('l.order_id', orderId)
      .select(
        'l.id', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'l.line_total', 'p.nombre as product_name',
        // [MCP.10] Para la copia del renglón que se borre (la caja puede reponerlo).
        'l.product_id', 'l.qty_factor_source', 'l.discount_percent', 'l.unit_price', 'l.tax_rate',
        'l.source_warehouse_id', 'l.line_number', 'l.notes', 'p.sku',
      );
    // [MCP.18] El motivo de cada faltante, validado ANTES de escribir nada (uno inválido es un 400).
    let motivos: ReturnType<typeof motivosPorRenglon>;
    try {
      motivos = motivosPorRenglon(marcados as unknown as Array<Record<string, unknown>>, MOTIVOS_SURTIDO, 'line_id');
    } catch (e) {
      if (e instanceof MotivoInvalido) throw new BadRequestException(e.message);
      throw e;
    }
    let plan: PlanCierre;
    try {
      plan = planearCierre(
        (lineas as Array<FilaRenglon & FilaCopia>).map((l) => ({
          line_id: l.id, product_id: l.product_id, product_name: l.product_name ?? 'Producto', quantity: Number(l.quantity),
          qty_unit: l.qty_unit, qty_factor: l.qty_factor == null ? null : Number(l.qty_factor), line_total: Number(l.line_total),
          restore: {
            product_id: l.product_id, quantity: Number(l.quantity), qty_unit: l.qty_unit,
            qty_factor: l.qty_factor == null ? null : Number(l.qty_factor), qty_factor_source: l.qty_factor_source ?? null,
            discount_percent: Number(l.discount_percent) || 0, unit_price: Number(l.unit_price) || 0, tax_rate: Number(l.tax_rate) || 0,
            source_warehouse_id: l.source_warehouse_id ?? null, line_number: l.line_number == null ? null : Number(l.line_number),
            notes: l.notes ?? null,
          },
        })),
        marcados,
      );
    } catch (e) {
      if (e instanceof CierreInvalido) throw new BadRequestException(e.message);
      throw e;
    }
    // [MCP.18] D4: cada renglón quitado o recortado trae su porqué, o no se escribe nada.
    if (MOTIVO_OBLIGATORIO_EN_SERVIDOR && opts.exigirMotivos !== false) {
      try {
        exigirMotivosDeRenglones([...plan.removed, ...plan.adjusted].map((l) => ({ id: String(l.line_id ?? ''), product_name: l.product_name })), motivos);
      } catch (e) {
        if (e instanceof MotivoInvalido) throw new BadRequestException(e.message);
        throw e;
      }
    }
    let totales = { total_before: Number(fila['total']), total_after: Number(fila['total']) };
    // [MCP.13] Lo que el surtidor puso en lugar de lo que faltó entra ANTES de recortar: así el
    // pedido nunca queda sin renglones aunque el original se borre, y el total se recalcula una vez.
    const sustituidos = plan.sustituir.length
      ? await this.ponerSustitutos(trx, orderId, String(fila['warehouse_id']), plan, lineas as Array<{ id: string; product_id: string; sku?: string | null; quantity: string; qty_unit: string | null }>)
      : [];
    if (plan.outcome === 'con_faltantes') {
      const r = await this.orders.recortarTrasSurtido(
        trx, orderId, plan,
        `surtido: ${quien.nombre} quitó lo que no hubo${sustituidos.length ? ` y cambió ${sustituidos.length} por otro producto` : ''}`,
      );
      totales = { total_before: Number(fila['total']), total_after: r.total_after };
    }
    // [MCP.18] Cada renglón quitado o recortado lleva su motivo; sin motivo = «sin motivo registrado».
    const report = conMotivosEnReporte(armarReporte(plan, totales.total_before, totales.total_after, sustituidos), motivos);
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

  /**
   * `[MCP.13]` Valida y agrega al pedido lo que el surtidor puso en lugar de lo que faltó. Cada
   * sustituto tiene que: existir y estar activo, no ser una promoción, no venir ya en el pedido,
   * tener en la escalera de Kepler de la sucursal la unidad que se eligió, y no estar agotado.
   */
  private async ponerSustitutos(
    trx: Knex.Transaction,
    orderId: string,
    warehouseId: string,
    plan: PlanCierre,
    originales: Array<{ id: string; product_id: string; sku?: string | null; quantity?: string | number | null; qty_unit?: string | null }>,
  ): Promise<PresalePickSubstitution[]> {
    const ids = [...new Set(plan.sustituir.map((x) => x.product_id))];
    if (ids.length !== plan.sustituir.length) {
      throw new BadRequestException('Pusiste el mismo producto en lugar de dos renglones: elige uno distinto para cada uno.');
    }
    const prods = (await trx('catalog.products')
      .whereIn('id', ids).whereNull('deleted_at').where('activo', true)
      .select('id', 'sku', 'nombre')) as Array<{ id: string; sku: string | null; nombre: string | null }>;
    const porId = new Map(prods.map((p) => [p.id, p]));
    const yaEnPedido = new Set(originales.map((o) => o.product_id));
    const originalDe = new Map(originales.map((o) => [o.id, o]));
    const escaleras = await this.orders.escalerasDeAlmacen(trx, warehouseId, prods.map((p) => String(p.sku ?? '').trim()).filter(Boolean));
    const estado = await this.existenciaEn(trx, warehouseId, ids);
    const items: Array<{ product_id: string; quantity: number; qty_unit: string; qty_factor: number; for_product_name: string; notes?: string }> = [];
    const mismos = new Set<string>();
    for (const x of plan.sustituir) {
      const p = porId.get(x.product_id);
      if (!p) throw new BadRequestException(`El producto que pusiste en lugar de «${x.for_product_name}» no existe o está dado de baja.`);
      if (esNombreDePromocion(p.nombre)) throw new BadRequestException(`«${p.nombre}» es una promoción: no se usa para cambiar un producto.`);
      // [MCP.17] El MISMO producto del renglón, en otra unidad: la caja no estaba completa y van paquetes.
      const orig = originalDe.get(x.for_line_id);
      const mismo = !!orig && orig.product_id === p.id;
      if (!mismo && yaEnPedido.has(p.id)) throw new BadRequestException(`«${p.nombre}» ya viene en este pedido: elige otro producto.`);
      const unidad = unidadesDeEscalera(escaleras.get(String(p.sku ?? '').trim())).find((u) => u.unit === x.unit);
      if (!unidad) throw new BadRequestException(`«${p.nombre}» no se vende en ${x.unit} en esta sucursal.`);
      if (mismo) {
        // No más de lo que faltó: lo pedido menos lo surtido en la unidad del renglón, en piezas base.
        const quedo = plan.recortar.find((r) => r.line_id === x.for_line_id)?.quantity ?? 0;
        const tope = topeEnUnidad(Number(orig.quantity) - quedo, unidad);
        if (x.quantity > tope + 1e-9) {
          throw new BadRequestException(`«${p.nombre}»: de lo que faltó caben ${tope} ${unidad.unit}; pusiste ${x.quantity}.`);
        }
        // Sin revisar la existencia de Kepler: el surtidor lo tiene en la mano, y ese dato llega con atraso.
        mismos.add(x.for_line_id);
        items.push({
          product_id: p.id, quantity: x.quantity, qty_unit: unidad.unit, qty_factor: unidad.factor, for_product_name: x.for_product_name,
          notes: `En ${unidad.unit}: no hubo ${String(orig.qty_unit ?? '').trim() || 'la presentación pedida'} completa al surtir`,
        });
        continue;
      }
      const st = estado?.(warehouseId, p.id).state;
      if (st === 'agotado' || st === 'no_se_maneja') {
        throw new BadRequestException(`«${p.nombre}» ${st === 'agotado' ? 'está agotado' : 'no se maneja'} en esta sucursal: elige otro.`);
      }
      items.push({ product_id: p.id, quantity: x.quantity, qty_unit: unidad.unit, qty_factor: unidad.factor, for_product_name: x.for_product_name });
    }
    const puestos = await this.orders.agregarSustitutos(trx, orderId, items);
    const skuOriginal = new Map(originales.map((o) => [o.id, o.sku ?? null]));
    return plan.sustituir.map((x, i) => {
      const p = porId.get(x.product_id) as { id: string; sku: string | null; nombre: string | null };
      return {
        line_id: puestos[i].line_id,
        for_line_id: x.for_line_id,
        for_product_name: x.for_product_name,
        for_sku: skuOriginal.get(x.for_line_id) ?? null,
        product_id: p.id,
        product_name: p.nombre ?? 'Producto',
        sku: p.sku ?? null,
        quantity: x.quantity,
        unit: items[i].qty_unit,
        line_total: puestos[i].line_total,
        ...(mismos.has(x.for_line_id) ? { same_product: true } : {}),
      };
    });
  }

  /** `[MCP.13]` La existencia en una sucursal; `null` si no se pudo leer (no bloquea: se declara). */
  private async existenciaEn(
    trx: Knex.Transaction,
    warehouseId: string,
    productIds: string[],
  ): Promise<((w: string, p: string) => { state: PresaleSubstituteCandidate['stock_state']; qty: number | null }) | null> {
    if (!productIds.length) return null;
    try {
      const wh = await trx('commercial.warehouses').where({ id: warehouseId }).first('code');
      return (await estadoDeProductos(trx, [{ id: warehouseId, code: (wh?.code as string) ?? null }], productIds)).estado;
    } catch (e) {
      this.logger.warn(`[MCP.13] no se pudo leer la existencia: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * `[MCP.17]` Las presentaciones más chicas del MISMO producto de un renglón, con su precio en la sucursal
   * del pedido: pidieron 1 CJA, no hubo caja completa y el surtidor pone 8 PAQ. Sólo lectura; lo que se
   * elija viaja en `finish` como `substitute` con el mismo `product_id`.
   */
  async otherUnits(orderId: string, lineId: string, query: Record<string, unknown> = {}): Promise<PresaleOtherUnitsResponse> {
    if (!UUID_RE.test(orderId) || !UUID_RE.test(lineId)) throw new BadRequestException('id inválido');
    const almacenes = await this.scope.warehouseIds(query, AREA);
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, almacenes);
      const r = (await trx('commercial.order_lines as l')
        .join('catalog.products as p', 'p.id', 'l.product_id')
        .where({ 'l.order_id': orderId, 'l.id': lineId })
        .first('l.product_id', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'p.nombre', 'p.sku')) as
        | { product_id: string; quantity: string; qty_unit: string | null; qty_factor: string | null; nombre: string | null; sku: string | null }
        | undefined;
      if (!r) throw new NotFoundException('Ese renglón no es de este pedido.');
      const m = cantidadMostrada({ quantity: Number(r.quantity), qty_unit: r.qty_unit, qty_factor: r.qty_factor == null ? null : Number(r.qty_factor) });
      const sku = String(r.sku ?? '').trim();
      const escaleras = sku ? await this.orders.escalerasDeAlmacen(trx, String(fila['warehouse_id']), [sku]) : null;
      return {
        for_line_id: lineId,
        product_id: r.product_id,
        product_name: r.nombre ?? 'Producto',
        ordered: m.qty,
        unit: m.unit,
        factor: m.factor,
        units: unidadesMasChicas(unidadesDeEscalera(escaleras?.get(sku)), m.factor, m.unit),
      };
    });
  }

  /**
   * `[MCP.13]` Qué poner en lugar de lo que faltó de un renglón. Sin `q`: lo que comparte palabras
   * del nombre o el proveedor, con precio en la sucursal y sin estar agotado. Con `q`: lo que busque
   * el surtidor (nombre, SKU o código de barras), con las mismas condiciones. Máximo 12.
   */
  async substitutes(orderId: string, lineId: string, q: string, query: Record<string, unknown> = {}): Promise<PresaleSubstituteResponse> {
    if (!UUID_RE.test(orderId) || !UUID_RE.test(lineId)) throw new BadRequestException('id inválido');
    const almacenes = await this.scope.warehouseIds(query, AREA);
    return this.tk.run(async (trx) => {
      const fila = await this.pedidoEnAlcance(trx, orderId, almacenes);
      const warehouseId = String(fila['warehouse_id']);
      const renglon = (await trx('commercial.order_lines as l')
        .join('catalog.products as p', 'p.id', 'l.product_id')
        .where({ 'l.order_id': orderId, 'l.id': lineId })
        .first('l.product_id', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'p.nombre', 'p.supplier_id')) as
        | { product_id: string; quantity: string; qty_unit: string | null; qty_factor: string | null; nombre: string | null; supplier_id: string | null }
        | undefined;
      if (!renglon) throw new NotFoundException('Ese renglón no es de este pedido.');
      const m = cantidadMostrada({ quantity: Number(renglon.quantity), qty_unit: renglon.qty_unit, qty_factor: renglon.qty_factor == null ? null : Number(renglon.qty_factor) });
      const original = { product_id: renglon.product_id, nombre: renglon.nombre ?? '', supplier_id: renglon.supplier_id };
      const vacio: PresaleSubstituteResponse = { for_line_id: lineId, for_product_name: original.nombre, missing: m.qty, unit: m.unit, data: [] };
      const yaEnPedido = (await trx('commercial.order_lines').where({ order_id: orderId }).pluck('product_id')) as string[];
      const busca = String(q ?? '').trim().slice(0, 60);

      type Fila = { id: string; sku: string; nombre: string; supplier_id: string | null };
      const base = trx('catalog.products as p')
        .whereNull('p.deleted_at').where('p.activo', true)
        .whereNotIn('p.id', yaEnPedido)
        .whereNotNull('p.sku');
      let filas: Fila[];
      if (busca) {
        filas = await base
          .where((w) => { w.whereILike('p.nombre', `%${busca}%`).orWhere('p.sku', busca).orWhere('p.barcode', busca); })
          .orderByRaw('p.sales_units_90d DESC NULLS LAST').limit(60)
          .select('p.id', 'p.sku', 'p.nombre', 'p.supplier_id');
      } else {
        // Candidatos: hasta 150, primero los que comparten más palabras del nombre.
        const palabras = palabrasClave(original.nombre).map((w) => `%${w}%`);
        if (!palabras.length && !original.supplier_id) return vacio;
        filas = await base
          .where((w) => {
            if (palabras.length) w.orWhereRaw('p.nombre ILIKE ANY(?::text[])', [palabras]);
            if (original.supplier_id) w.orWhere('p.supplier_id', original.supplier_id);
          })
          .orderByRaw(
            palabras.length
              ? '(SELECT count(*) FROM unnest(?::text[]) t WHERE p.nombre ILIKE t) DESC, p.sales_units_90d DESC NULLS LAST'
              : 'p.sales_units_90d DESC NULLS LAST',
            palabras.length ? [palabras] : [],
          )
          .limit(150)
          .select('p.id', 'p.sku', 'p.nombre', 'p.supplier_id');
      }
      const puntuados: Array<{ p: Fila; score: number; match: PresaleSubstituteCandidate['match'] }> = [];
      for (const p of filas) {
        if (esNombreDePromocion(p.nombre)) continue;
        if (busca) { puntuados.push({ p, score: 0, match: 'busqueda' }); continue; }
        const s = puntuarSustituto(original, { product_id: p.id, nombre: p.nombre, supplier_id: p.supplier_id });
        if (s) puntuados.push({ p, ...s });
      }
      if (!puntuados.length) return vacio;

      const escaleras = await this.orders.escalerasDeAlmacen(trx, warehouseId, puntuados.map((x) => String(x.p.sku).trim()));
      const conPrecio = puntuados
        .map((x) => ({ ...x, units: unidadesDeEscalera(escaleras.get(String(x.p.sku).trim())).filter((u) => u.price != null) }))
        .filter((x) => x.units.length > 0);
      const estado = await this.existenciaEn(trx, warehouseId, conPrecio.map((x) => x.p.id));
      const filasSugeridas = conPrecio
        .map((x) => {
          const e = estado?.(warehouseId, x.p.id);
          const stockState = e?.state ?? 'sin_dato';
          const stockQty = e && e.state !== 'sin_dato' ? e.qty : null;
          const sugerida = unidadSugerida(x.units, m.unit);
          const candidate: PresaleSubstituteCandidate = {
            product_id: x.p.id, sku: x.p.sku, product_name: x.p.nombre,
            // La unidad del original va primero: es la que el surtidor busca en el anaquel.
            units: sugerida ? [sugerida, ...x.units.filter((u) => u !== sugerida)] : x.units,
            stock_qty: stockQty, stock_state: stockState, match: x.match,
          };
          return { score: x.score, stock_qty: stockQty, candidate };
        })
        // Agotado o no manejado no se ofrece; sin dato sí (la pantalla lo declara).
        .filter((x) => x.candidate.stock_state === 'con_existencia' || x.candidate.stock_state === 'sin_dato');
      return { ...vacio, data: ordenarSugerencias(filasSugeridas).slice(0, 12).map((x) => x.candidate) };
    });
  }

  // ───────────────────────────── Vendedora ─────────────────────────────

  /** Los pedidos de preventa que levantó la persona en sesión, con su avance. */
  async sellerStatus(fecha?: string): Promise<PresaleSellerStatusResponse> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    const hoy = relojMx(new Date()).fecha;
    // [MCP.20] Con día: lo levantado ESE día. Sin día (apps de antes): agendados de cualquier día +
    // recientes. Medido en prod el 2026-11-11: sin día, una vendedora tenía 145 pedidos en la lista
    // (72 de hace más de 7 días, el más viejo del 26-ago), porque casi ninguno llega a «entregado».
    const dia = fechaDelDia(fecha, hoy);
    return this.tk.run(async (trx) => {
      const pedidos = await this.presale.pedidosParaGuias(trx, { almacenes: null, autorId: userId });
      const recientes = pedidos
        .filter((p) => (dia
          ? fechaMx(p.created_at) === dia
          : p.status === 'confirmed' || p.requested_delivery_date >= sumarDias(hoy, -2)))
        .sort((a, b) => (a.requested_delivery_date === b.requested_delivery_date
          ? (a.created_at < b.created_at ? 1 : -1)
          : a.requested_delivery_date < b.requested_delivery_date ? -1 : 1));
      const data = await this.armarAvance(trx, recientes);
      if (!dia) return { today: hoy, data, unseen_reports: data.filter((d) => d.report_unseen).length };
      const sinVer = await trx('commercial.presale_picks as pp')
        .join('commercial.orders as o', 'o.id', 'pp.order_id')
        .where('o.user_id', userId)
        .whereNotNull('pp.finished_at')
        .whereNull('pp.seller_seen_at')
        .distinct(trx.raw(`to_char(o.created_at AT TIME ZONE 'America/Mexico_City', 'YYYY-MM-DD') AS dia`));
      const unseen_days = (sinVer as Array<{ dia: string }>).map((r) => r.dia).sort().reverse();
      return { today: hoy, date: dia, data, unseen_reports: data.filter((d) => d.report_unseen).length, unseen_days };
    });
  }

  /**
   * `[MCP.19]` El avance de unos pedidos (los que se levantaron en un día), con el MISMO armado que
   * «Mis pedidos»: así el recuento del día y la lista dicen lo mismo de cada pedido. No marca nada como
   * visto. Quien llama ya decidió que puede verlos.
   */
  async avanceDe(orderIds: readonly string[]): Promise<PresaleSellerOrder[]> {
    if (!orderIds.length) return [];
    return this.tk.run(async (trx) => {
      const pedidos = await this.presale.pedidosParaGuias(trx, { almacenes: null, orderIds: [...orderIds] });
      return this.armarAvance(trx, pedidos);
    });
  }

  /** `[MCP.8]` Cada pedido con su surtido, revisión, cobro, entrega y justificantes. */
  private async armarAvance(trx: Knex.Transaction, recientes: PresaleOrderRow[]): Promise<PresaleSellerOrder[]> {
    const ids = recientes.map((p) => p.id);
    const picks = ids.length ? await trx('commercial.presale_picks').whereIn('order_id', ids) : [];
    const pickDe = new Map<string, FilaPick>((picks as FilaPick[]).map((p) => [p.order_id, p]));
    // [MCP.18] Los «Corregir» y cancelaciones de todos sus pedidos, en una consulta.
    const historias = await historiaDeCambios(trx, ids);
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
        customer_id: p.customer_id ?? null,
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
        review: pk?.reviewed_at ? (pk.review ?? null) : null,
        reviewed: pk?.reviewed_at ? { user_id: pk.reviewed_by ?? '', name: pk.reviewed_by_name ?? '', at: iso(pk.reviewed_at) as string } : null,
        charge,
        delivered_at: p.delivery?.delivered_at ?? null,
        report_unseen: !!pk?.finished_at && !pk.seller_seen_at,
        // [MCP.18] Por qué cambió su pedido: quién, cuándo y el motivo (o «sin motivo registrado»).
        justifications: armarJustificantes({
          historia: historias.get(p.id) ?? [],
          reporte: pk?.report ?? null,
          surtio: pk?.finished_at ? { name: pk.finished_by_name ?? null, at: pk.finished_at } : null,
          revision: pk?.reviewed_at ? (pk.review ?? null) : null,
          reviso: pk?.reviewed_at ? { name: pk.reviewed_by_name ?? null, at: pk.reviewed_at } : null,
        }),
      });
    }
    return data;
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

  /**
   * La vendedora vio sus reportes de surtido. `[MCP.20]` Con `orderIds`, sólo los de esos pedidos (los
   * del día que tiene en pantalla): los de otro día siguen «nuevos» hasta que los vea.
   */
  async sellerSeen(orderIds?: readonly string[]): Promise<{ updated: number }> {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    if (orderIds !== undefined && orderIds !== null) {
      if (!Array.isArray(orderIds) || orderIds.length > 500 || orderIds.some((x) => typeof x !== 'string' || !UUID_RE.test(x))) {
        throw new BadRequestException('order_ids tiene que ser una lista de pedidos (máx. 500).');
      }
      if (!orderIds.length) return { updated: 0 };
    }
    return this.tk.run(async (trx) => {
      const updated = await trx('commercial.presale_picks as pp')
        .whereNotNull('pp.finished_at')
        .whereNull('pp.seller_seen_at')
        .modify((q) => { if (orderIds?.length) q.whereIn('pp.order_id', [...orderIds]); })
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
    // [MCP.3.15] Con el surtido pedido por pedido, lo levantado en una ruta abierta también llega suelto.
    if (!f.incluirRutas && SURTIDO_DE_RUTA) {
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
        'o.id', 'o.code', 'o.total', 'o.warehouse_id', 'o.confirmed_at', 'o.user_id', 'o.notes',
        trx.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS requested_delivery_date`),
        'w.name as warehouse_name', 'c.name as customer_name',
        trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS seller_name`),
        'u.username as seller_username',
        'pp.started_by', 'pp.started_by_name', 'pp.started_at',
        'pp.finished_by', 'pp.finished_by_name', 'pp.finished_at', 'pp.outcome', 'pp.report',
        'pp.reviewed_by', 'pp.reviewed_by_name', 'pp.reviewed_at',
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
      // [MCP.10.1] Revisado en caja: el surtidor ve que el pedido ya no es como él lo dejó.
      reviewed: f['reviewed_at'] ? { user_id: f['reviewed_by'] as string, name: f['reviewed_by_name'] as string, at: iso(f['reviewed_at']) as string } : null,
      // [MCP.3.13] Pedido agrupado; suelto = null / [].
      group_code: (f['group_code'] as string | null | undefined) ?? null,
      group_parts: f['group_parts'] == null ? null : Number(f['group_parts']),
      group_other_warehouses: Array.isArray(f['group_other_warehouses']) ? (f['group_other_warehouses'] as unknown[]).map(String) : [],
      // [MCP.3.15] Lo que el vendedor dictó o escribió para el surtidor; vacío = sin indicaciones.
      instructions: typeof f['notes'] === 'string' && f['notes'].trim() ? f['notes'].trim() : null,
    };
  }

  /**
   * Aviso a la vendedora en vivo y al celular. Nunca tumba el surtido: lo que se pierde es el aviso.
   * `[MCP.10]` También lo usa la revisión en caja. `fila` necesita `id`, `code`, `user_id` y `seller_username`.
   */
  avisarVendedora(fila: Record<string, unknown>, titulo: string, mensaje: string): void {
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

/**
 * `[MCP.10.1]` Lo que surtió el surtidor de un renglón del pedido cerrado, en la unidad mostrada.
 *  · recortado al surtir → `adjusted.picked` (por `line_id`; reportes viejos, por nombre y unidad únicos);
 *  · repuesto por la caja (el surtido lo había borrado) → 0: el renglón nuevo tiene otro `line_id`, se
 *    reconoce por el `product_id` de su copia en `removed`;
 *  · si no está en el reporte, surtió todo: lo que hoy dice el pedido.
 */
export function surtidoPorElSurtidor(
  l: { line_id: string; product_id: string; product_name: string; unit: string },
  reporte: PresalePickReport | null,
  hoy: number,
): number {
  if (!reporte) return hoy;
  const exacto = reporte.adjusted.find((r) => r.line_id === l.line_id);
  if (exacto) return exacto.picked;
  if (reporte.removed.some((r) => r.restore?.product_id === l.product_id)) return 0;
  const porNombre = reporte.adjusted.filter((r) => !r.line_id && r.product_name === l.product_name && r.unit === l.unit);
  return porNombre.length === 1 ? porNombre[0].picked : hoy;
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

/** `[MCP.20]` El día pedido (`YYYY-MM-DD`), validado; `null` = sin día. Un día que no existe o futuro es 400. */
function fechaDelDia(v: string | undefined, hoy: string): string | null {
  const f = String(v ?? '').trim();
  if (!f) return null;
  const valido = /^\d{4}-\d{2}-\d{2}$/.test(f) && !Number.isNaN(Date.parse(`${f}T00:00:00Z`))
    && new Date(`${f}T00:00:00Z`).toISOString().slice(0, 10) === f;
  if (!valido) throw new BadRequestException('El día tiene que ser AAAA-MM-DD.');
  if (f > hoy) throw new BadRequestException('Ese día todavía no llega.');
  return f;
}

/** `YYYY-MM-DD` en hora de México. */
function fechaMx(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return relojMx(d).fecha;
}
