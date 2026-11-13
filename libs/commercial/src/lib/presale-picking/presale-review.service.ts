import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { ScopeService, TenantKnexService } from '@megadulces/platform-core';
import type {
  PresalePickReport,
  PresaleReviewDetail,
  PresaleReviewFinishRequest,
  PresaleReviewFinishResponse,
  PresaleReviewInboxResponse,
  PresaleReviewInboxRow,
  PresaleReviewLine,
  PresaleReviewResult,
  PresaleReviewSearchResponse,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import { CommercialOrdersService } from '../commercial-orders/commercial-orders.service';
import { estadoDeProductos, type EstadoEnSucursal } from '../commercial-inventory/stock-state';
import { PresalePickingService } from './presale-picking.service';
import { RevisionInvalida, armarRenglonesRevision, buscarEnRenglones, codigosDeFicha, planearRevision, type RenglonVivo } from './presale-review.engine';
import { kdiiPorSku } from '../shared/kdii-lectura';
import { DiaInvalido, diaDeConsulta } from './bandeja-dia';
import { MOTIVOS_CAJA, MOTIVO_OBLIGATORIO_EN_SERVIDOR } from '@megadulces/contracts';
import { MotivoInvalido, armarJustificantes, conMotivosEnRevision, exigirMotivosDeRenglones, motivosPorRenglon } from '../commercial-orders/justificantes.engine';
import { historiaDeCambios } from '../commercial-orders/justificantes.lectura';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Tope de filas de la bandeja. Lo sin revisar NO tiene límite de días (decisión de David, 2026-10-29: se
 * queda hasta que alguien lo revise), así que el tope existe sólo como red: si se rebasa, la respuesta
 * lo dice (`pending` sale de un conteo aparte y `truncated`), nunca lo esconde.
 */
const TOPE = 300;
/** `[MCP.10.3]` Coincidencias que devuelve la búsqueda en los otros pedidos; si hay más, se declara. */
const TOPE_BUSQUEDA = 20;
/** Lo revisado sigue en la bandeja un día, para que la cajera vea lo que ya hizo. */
const DIAS_REVISADOS = 1;
const RUTA = 'warehouse/presale-review';

/**
 * `[MCP.10]` Revisión en caja de los pedidos de preventa surtidos.
 *
 * La revisión es el paso siguiente del mismo surtido, así que se guarda en `commercial.presale_picks`
 * (`reviewed_*`, `review`). Ajustar el pedido lo hace `CommercialOrdersService.ajustarTrasRevision`
 * en la MISMA transacción del cierre: o queda la revisión y el pedido corregido, o ninguno.
 */
@Injectable()
export class PresaleReviewService {
  private readonly logger = new Logger(PresaleReviewService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly scope: ScopeService,
    private readonly orders: CommercialOrdersService,
    private readonly picking: PresalePickingService,
  ) {}

  async inbox(query: Record<string, unknown> = {}): Promise<PresaleReviewInboxResponse> {
    const hoy = relojMx(new Date()).fecha;
    // [MCP.24] `?date=` trae lo que se SURTIÓ ese día (hora de México), revisado o no: la caja revisa el
    // mismo día que se surte (medido en prod: 451 de 467 en 30 días), no el día de entrega.
    let dia: string | null;
    try { dia = diaDeConsulta(query['date']); } catch (e) {
      if (e instanceof DiaInvalido) throw new BadRequestException(e.message);
      throw e;
    }
    const conDia = dia ? { date: dia } : {};
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { today: hoy, pending: 0, truncated: false, data: [], scope: 'ninguno', ...conDia };
    return this.tk.run(async (trx) => {
      const filas = await this.leer(trx, dia ? { almacenes, dia } : { almacenes });
      const data = filas.map((f) => this.aRenglon(f));
      const pending = await this.contarPendientes(trx, almacenes);
      // Con un día pedido, `truncated` habla de ESE día: si se llegó al tope, la pantalla lo dice.
      const truncated = dia ? filas.length >= TOPE : pending > data.filter((d) => d.state === 'por_revisar').length;
      return { today: hoy, pending, truncated, data, scope: almacenes === null ? 'todos' : 'propios', ...conDia };
    });
  }

  async detail(orderId: string, query: Record<string, unknown> = {}): Promise<PresaleReviewDetail> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id inválido');
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    return this.tk.run(async (trx) => {
      const fila = await this.enAlcance(trx, orderId, almacenes);
      const renglones = armarRenglonesRevision(await this.vivos(trx, orderId), (fila['report'] as PresalePickReport | null) ?? null);
      const ids = renglones.map((r) => r.product_id).filter((x): x is string => !!x);
      let estado: ((w: string, p: string) => EstadoEnSucursal) | null = null;
      try {
        const r = await estadoDeProductos(trx, [{ id: String(fila['warehouse_id']), code: (fila['warehouse_code'] as string) ?? null }], ids);
        estado = r.estado;
      } catch (e) {
        // La existencia es ayuda, no requisito: sin ella la caja revisa igual y se DECLARA «sin dato».
        this.logger.warn(`[MCP.10] no se pudo leer la existencia de ${fila['code']}: ${(e as Error).message}`);
      }
      // [VTK.15] El SKU de los renglones que el surtido borró sale del catálogo (ya no hay renglón).
      const sinSku = [...new Set(renglones.filter((r) => !r.sku && r.product_id).map((r) => r.product_id as string))];
      const skuDe = new Map<string, string>(
        sinSku.length
          ? ((await trx('catalog.products').whereIn('id', sinSku).select('id', 'sku')) as Array<{ id: string; sku: string | null }>)
              .filter((p) => !!p.sku).map((p) => [p.id, String(p.sku)])
          : [],
      );
      const skuDeRenglon = (r: (typeof renglones)[number]): string | null => r.sku ?? (r.product_id ? skuDe.get(r.product_id) ?? null : null);
      // [MCP.10.3] Los códigos de Kepler de la sucursal, para escanear. Ayuda, no requisito: si no se leen,
      // `codes` va ausente y la pantalla lo DECLARA (se toca en la lista). En un savepoint: una lectura que
      // falla no puede abortar la transacción de la que cuelga el resto del detalle.
      let codigos: Map<string, PresaleReviewLine['codes']> | null = null;
      const sucursal = String(fila['warehouse_code'] ?? '').trim();
      const skus = [...new Set(renglones.map(skuDeRenglon).filter((s): s is string => !!s))];
      if (sucursal && skus.length) {
        try {
          const fichas = await trx.transaction((sp) => kdiiPorSku(sp, sucursal, skus));
          codigos = new Map(fichas.map((f) => [f.sku, codigosDeFicha(f)]));
        } catch (e) {
          this.logger.warn(`[MCP.10.3] no se pudieron leer los códigos de Kepler de ${fila['code']}: ${(e as Error).message}`);
        }
      }
      const lines: PresaleReviewLine[] = renglones.map((r) => {
        let stock: PresaleReviewLine['stock'] = null;
        if (estado && r.product_id) {
          const e = estado(String(fila['warehouse_id']), r.product_id);
          stock = { state: e.state, qty: e.qty == null ? null : Math.floor((e.qty + 1e-9) / (r.factor || 1)), checked_at: e.checked_at };
        }
        const sku = skuDeRenglon(r);
        return {
          key: r.key, product_id: r.product_id, product_name: r.product_name,
          sku, unit: r.unit, factor: r.factor,
          ordered: r.ordered, picked: r.picked, restorable: r.restorable, stock,
          ...(r.substitutes_for ? { substitutes_for: r.substitutes_for } : {}),
          ...(codigos ? { codes: sku ? codigos.get(sku) ?? [] : [] } : {}),
        };
      });
      // [MCP.18] Por qué cambió antes de llegar a caja: lo que corrigió la vendedora y lo que quitó el surtido.
      const justifications = armarJustificantes({
        historia: (await historiaDeCambios(trx, [orderId])).get(orderId) ?? [],
        reporte: (fila['report'] as PresalePickReport | null) ?? null,
        surtio: { name: (fila['finished_by_name'] as string) ?? null, at: fila['finished_at'] as string },
      });
      return { order: this.aRenglon(fila), lines, justifications };
    });
  }

  /**
   * `[MCP.10.3]` ¿En qué pedido por revisar de mi sucursal está este producto? Por código de Kepler, SKU
   * o nombre. Para cuando la caja tiene en la mano algo que no es del pedido abierto (dos rutas o dos
   * pedidos en el mismo carrito). Los renglones que el surtido borró no se buscan (ya no están en el pedido).
   */
  async search(query: Record<string, unknown> = {}): Promise<PresaleReviewSearchResponse> {
    const q = String(query['q'] ?? '').trim().slice(0, 80);
    if (!q) return { q, data: [], truncated: false };
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    if (almacenes !== null && almacenes.length === 0) return { q, data: [], truncated: false };
    return this.tk.run(async (trx) => {
      const pedidos = (await this.leer(trx, { almacenes })).filter((f) => !f['reviewed_at']);
      if (!pedidos.length) return { q, data: [], truncated: false };
      const porId = new Map(pedidos.map((f) => [String(f['id']), f]));
      const filas = (await trx('commercial.order_lines as l')
        .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
        .whereIn('l.order_id', [...porId.keys()])
        .select('l.order_id', 'p.nombre as product_name', 'p.sku')) as Array<{ order_id: string; product_name: string | null; sku: string | null }>;
      const sucDe = (orderId: string): string => String(porId.get(orderId)?.['warehouse_code'] ?? '').trim();
      // Los códigos de Kepler de cada sucursal, en un savepoint: si fallan, se busca igual por SKU y nombre.
      const skusPorSuc = new Map<string, Set<string>>();
      for (const l of filas) {
        const suc = sucDe(l.order_id);
        if (suc && l.sku) skusPorSuc.set(suc, (skusPorSuc.get(suc) ?? new Set<string>()).add(l.sku));
      }
      const codigos = new Map<string, ReturnType<typeof codigosDeFicha>>();
      for (const [suc, skus] of skusPorSuc) {
        try {
          const fichas = await trx.transaction((sp) => kdiiPorSku(sp, suc, [...skus]));
          for (const f of fichas) codigos.set(`${suc}|${f.sku}`, codigosDeFicha(f));
        } catch (e) {
          this.logger.warn(`[MCP.10.3] búsqueda sin códigos de Kepler de la sucursal ${suc}: ${(e as Error).message}`);
        }
      }
      const hallados = buscarEnRenglones(q, filas.map((l) => ({
        order_id: l.order_id, product_name: l.product_name ?? 'Producto', sku: l.sku,
        codes: l.sku ? codigos.get(`${sucDe(l.order_id)}|${l.sku}`) ?? [] : [],
      })));
      const pendientes = await this.contarPendientes(trx, almacenes);
      const data = hallados.slice(0, TOPE_BUSQUEDA).map(({ r, match }) => {
        const f = porId.get(r.order_id) as Record<string, unknown>;
        return {
          order_id: r.order_id, code: String(f['code']), customer_name: (f['customer_name'] as string) ?? null,
          seller_name: (f['seller_name'] as string) ?? null, product_name: r.product_name, sku: r.sku, match,
        };
      });
      return { q, data, truncated: hallados.length > TOPE_BUSQUEDA || pendientes > pedidos.length };
    });
  }

  async finish(orderId: string, dto: PresaleReviewFinishRequest, query: Record<string, unknown> = {}): Promise<PresaleReviewFinishResponse> {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('id inválido');
    const { userId, nombre } = await this.picking.quien();
    const almacenes = await this.scope.warehouseIds(query, RUTA);
    return this.tk.run(async (trx) => {
      const fila = await this.enAlcance(trx, orderId, almacenes);
      const pick = await trx('commercial.presale_picks').where({ order_id: orderId }).forUpdate().first();
      if (!pick?.finished_at) throw new ConflictException('El surtidor todavía no termina este pedido.');
      if (pick.reviewed_at) {
        throw new ConflictException(`Este pedido ya lo revisó ${pick.reviewed_by_name} a las ${horaMx(pick.reviewed_at)}.`);
      }
      const renglones = armarRenglonesRevision(await this.vivos(trx, orderId), (pick.report as PresalePickReport | null) ?? null);
      // [MCP.18] El motivo de lo que la caja deja por debajo de lo surtido, validado antes de escribir.
      let motivos: ReturnType<typeof motivosPorRenglon>;
      try {
        motivos = motivosPorRenglon((dto?.lines ?? []) as unknown as Array<Record<string, unknown>>, MOTIVOS_CAJA, 'key');
      } catch (e) {
        if (e instanceof MotivoInvalido) throw new BadRequestException(e.message);
        throw e;
      }
      let plan;
      try {
        plan = planearRevision(renglones, dto?.lines ?? []);
      } catch (e) {
        if (e instanceof RevisionInvalida) throw new BadRequestException(e.message);
        throw e;
      }
      // [MCP.18] D4: lo que la caja deja por debajo de lo surtido trae su porqué, o no se escribe nada.
      if (MOTIVO_OBLIGATORIO_EN_SERVIDOR) {
        try {
          exigirMotivosDeRenglones(plan.lines.filter((l) => l.final < l.picked - 1e-9).map((l) => ({ id: l.key, product_name: l.product_name })), motivos);
        } catch (e) {
          if (e instanceof MotivoInvalido) throw new BadRequestException(e.message);
          throw e;
        }
      }
      let totales = { total_before: Number(fila['total']), total_after: Number(fila['total']) };
      if (plan.cambia) {
        totales = await this.orders.ajustarTrasRevision(trx, orderId, plan, `revisión en caja: ${nombre}`);
      }
      const review: PresaleReviewResult = { lines: conMotivosEnRevision(plan.lines, motivos), ...totales };
      await trx('commercial.presale_picks').where({ id: pick.id }).update({
        reviewed_by: userId,
        reviewed_by_name: nombre,
        reviewed_at: trx.fn.now(),
        review: JSON.stringify(review),
        updated_at: trx.fn.now(),
      });
      if (plan.cambia) {
        const completos = plan.lines.filter((l) => l.resolution === 'completo').length;
        const titulo = completos ? `La caja completó ${completos} ${completos === 1 ? 'producto' : 'productos'}` : 'La caja ajustó tu pedido';
        this.picking.avisarVendedora(fila, titulo, `${fila['customer_name'] ?? fila['code']} · nuevo total ${totales.total_after.toFixed(2)}`);
      }
      return { order_id: orderId, review };
    });
  }

  // ───────────────────────────── Interno ─────────────────────────────

  private async enAlcance(trx: Knex.Transaction, orderId: string, almacenes: string[] | null): Promise<Record<string, unknown>> {
    if (almacenes !== null && almacenes.length === 0) throw new ForbiddenException('Tu usuario no tiene una sucursal asignada.');
    const [fila] = await this.leer(trx, { almacenes, orderId });
    if (!fila) throw new NotFoundException('Pedido surtido no encontrado en tu sucursal.');
    return fila;
  }

  private async vivos(trx: Knex.Transaction, orderId: string): Promise<RenglonVivo[]> {
    const filas = await trx('commercial.order_lines as l')
      .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
      .where('l.order_id', orderId)
      .orderBy('l.line_number', 'asc')
      .select('l.id', 'l.product_id', 'l.quantity', 'l.qty_unit', 'l.qty_factor', 'p.nombre as product_name', 'p.sku');
    return (filas as Array<{ id: string; product_id: string; quantity: string | number; qty_unit: string | null; qty_factor: string | number | null; product_name: string | null; sku?: string | null }>)
      .map((l) => ({
        line_id: l.id, product_id: l.product_id, product_name: l.product_name ?? 'Producto', sku: l.sku ?? null,
        quantity: Number(l.quantity), qty_unit: l.qty_unit, qty_factor: l.qty_factor == null ? null : Number(l.qty_factor),
      }));
  }

  /** Cuántos faltan por revisar, sin el tope de filas: es el número que se publica. */
  private async contarPendientes(trx: Knex.Transaction, almacenes: string[] | null): Promise<number> {
    const qb = trx('commercial.presale_picks as pp')
      .join('commercial.orders as o', function () {
        this.on('o.id', '=', 'pp.order_id').andOn('o.tenant_id', '=', 'pp.tenant_id');
      })
      .whereNotNull('pp.finished_at')
      .whereNull('pp.reviewed_at')
      .where('pp.review_required', true)
      .where('o.status', 'confirmed')
      .whereNotNull('o.requested_delivery_date');
    if (almacenes !== null) qb.whereIn('o.warehouse_id', almacenes);
    const r = await qb.count({ n: '*' }).first();
    return Number(r?.n) || 0;
  }

  /** Los pedidos de preventa surtidos: todo lo que falta por revisar (sin límite de días) y lo revisado del último día. */
  private async leer(trx: Knex.Transaction, f: { almacenes: string[] | null; orderId?: string; dia?: string }): Promise<Array<Record<string, unknown>>> {
    const qb = trx('commercial.presale_picks as pp')
      .join('commercial.orders as o', function () {
        this.on('o.id', '=', 'pp.order_id').andOn('o.tenant_id', '=', 'pp.tenant_id');
      })
      .join('commercial.warehouses as w', function () {
        this.on('w.id', '=', 'o.warehouse_id').andOn('w.tenant_id', '=', 'o.tenant_id');
      })
      .leftJoin('commercial.customers as c', function () {
        this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
      })
      .leftJoin('identity.users as u', 'u.id', 'o.user_id')
      .whereNotNull('pp.finished_at')
      .where('o.status', 'confirmed')
      .whereNotNull('o.requested_delivery_date');
    if (f.almacenes !== null) qb.whereIn('o.warehouse_id', f.almacenes);
    if (f.orderId) qb.where('o.id', f.orderId);
    else if (f.dia) {
      // [MCP.24] Todo lo surtido ese día en hora de México, revisado o no.
      qb.whereRaw(`(pp.finished_at AT TIME ZONE 'America/Mexico_City')::date = ?::date`, [f.dia])
        // Lo que no pide revisión no se pinta como «por revisar» (igual que la bandeja viva).
        .where(function () { this.where('pp.review_required', true).orWhereNotNull('pp.reviewed_at'); });
    } else {
      qb.where(function () {
        this.where(function () {
          // Sin límite de días: lo que no se revisó se queda hasta que alguien lo revise.
          this.whereNull('pp.reviewed_at').where('pp.review_required', true);
        }).orWhereRaw(`pp.reviewed_at >= now() - interval '${DIAS_REVISADOS} day'`);
      });
    }
    return qb
      .select(
        'o.id', 'o.code', 'o.total', 'o.warehouse_id', 'o.user_id', 'o.notes', 'w.code as warehouse_code',
        trx.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS requested_delivery_date`),
        'w.name as warehouse_name', 'c.name as customer_name',
        trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS seller_name`),
        'u.username as seller_username',
        'pp.finished_by', 'pp.finished_by_name', 'pp.finished_at', 'pp.outcome', 'pp.report',
        'pp.reviewed_by', 'pp.reviewed_by_name', 'pp.reviewed_at',
        trx.raw('(SELECT count(*) FROM commercial.order_lines ol WHERE ol.order_id = o.id)::int AS lines'),
        trx.raw(`(SELECT m.code FROM commercial.orders m WHERE m.tenant_id = o.tenant_id AND m.id = o.group_id) AS group_code`),
      )
      // Lo que falta por revisar primero, en el orden en que el surtidor lo terminó.
      .orderByRaw('(pp.reviewed_at IS NOT NULL) ASC, pp.finished_at ASC, o.code ASC')
      .limit(TOPE);
  }

  private aRenglon(f: Record<string, unknown>): PresaleReviewInboxRow {
    return {
      order_id: f['id'] as string,
      code: f['code'] as string,
      customer_name: (f['customer_name'] as string) ?? null,
      seller_name: (f['seller_name'] as string) ?? null,
      warehouse_name: (f['warehouse_name'] as string) ?? null,
      requested_delivery_date: f['requested_delivery_date'] as string,
      lines: Number(f['lines']) || 0,
      total: Number(f['total']) || 0,
      finished: { user_id: f['finished_by'] as string, name: f['finished_by_name'] as string, at: iso(f['finished_at']) as string },
      pick_outcome: f['outcome'] === 'con_faltantes' ? 'con_faltantes' : 'completo',
      state: f['reviewed_at'] ? 'revisado' : 'por_revisar',
      reviewed: f['reviewed_at']
        ? { user_id: f['reviewed_by'] as string, name: f['reviewed_by_name'] as string, at: iso(f['reviewed_at']) as string }
        : null,
      group_code: (f['group_code'] as string | null | undefined) ?? null,
      instructions: typeof f['notes'] === 'string' && f['notes'].trim() ? f['notes'].trim() : null,
    };
  }
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
