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
  RouteBatchBag,
  RouteBatchDetail,
  RouteBatchFinishRequest,
  RouteBatchFinishResponse,
  RouteBatchInboxResponse,
  RouteBatchRow,
  RouteBatchState,
  SellerRouteDay,
} from '@megadulces/contracts';
import { relojMx } from '../warehouse-orders/warehouse-orders.engine';
import { AlertsService } from '../commercial-alerts/alerts.service';
import { CommercialPushService } from '../commercial-push/commercial-push.service';
import { CierreInvalido, cantidadMostrada, sumarDias } from './presale-picking.engine';
import { PEDIDO_EN_RUTA_SQL, consolidar, repartirRuta, type CierreDePedido, type RenglonDeRuta } from './presale-route.engine';
import { PresalePickingService } from './presale-picking.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AREA = 'warehouse/presale-picking';

/** Una fila de `commercial.seller_route_days`. */
type FilaRuta = {
  id: string; user_id: string; work_date: string; kind: 'ruta' | 'fuera_de_ruta';
  started_at: Date | string; finished_at: Date | string | null;
  pick_started_by: string | null; pick_started_by_name: string | null; pick_started_at: Date | string | null;
  pick_finished_by: string | null; pick_finished_by_name: string | null; pick_finished_at: Date | string | null;
};

/** `leerRutas` agrega el vendedor y los conteos. */
type FilaRutaConConteo = FilaRuta & {
  seller_name: string | null; seller_username: string | null; orders: number | string; products: number | string;
};

/**
 * `[MCP.3.6]` Ruta del vendedor y su surtido como UN pedido global.
 *
 * La ruta es una ventana (`commercial.seller_route_days`: inició → finalizó). Sus pedidos NO se
 * copian: se derivan por la ventana (`PEDIDO_EN_RUTA_SQL`), la misma con la que la bandeja de
 * siempre los deja de mostrar sueltos. Cerrar la ruta reparte lo encontrado y cierra cada pedido
 * con `PresalePickingService.cerrarPedido`, igual que el surtido por pedido.
 */
@Injectable()
export class PresaleRouteService {
  private readonly logger = new Logger(PresaleRouteService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly scope: ScopeService,
    private readonly picking: PresalePickingService,
    private readonly alerts: AlertsService,
    private readonly push: CommercialPushService,
  ) {}

  // ───────────────────────────── Vendedor ─────────────────────────────

  async myDay(): Promise<SellerRouteDay> {
    const userId = this.yo();
    const hoy = relojMx(new Date()).fecha;
    return this.tk.run((trx) => this.diaDe(trx, userId, hoy));
  }

  /** Idempotente: si ya inició hoy, devuelve la misma ruta. Una ruta finalizada no se reabre. */
  async startDay(): Promise<SellerRouteDay> {
    const userId = this.yo();
    const hoy = relojMx(new Date()).fecha;
    return this.tk.run(async (trx) => {
      const actual = await this.rutaDelDia(trx, userId, hoy);
      if (actual?.finished_at) throw new ConflictException('Tu ruta de hoy ya se finalizó.');
      if (!actual) {
        await trx.raw(
          `INSERT INTO commercial.seller_route_days (tenant_id, user_id, work_date, created_by, updated_by)
           VALUES (public.current_tenant_id(), ?, ?, ?, ?)
           ON CONFLICT (tenant_id, user_id, work_date) WHERE deleted_at IS NULL AND kind = 'ruta' DO NOTHING`,
          [userId, hoy, userId, userId],
        );
      }
      return this.diaDe(trx, userId, hoy);
    });
  }

  async finishDay(): Promise<SellerRouteDay> {
    const userId = this.yo();
    const hoy = relojMx(new Date()).fecha;
    const { dia, id } = await this.tk.run(async (trx) => {
      const actual = await this.rutaDelDia(trx, userId, hoy, true);
      if (!actual || actual.finished_at) throw new ConflictException('No tienes una ruta en curso hoy.');
      const [cerrada] = await trx('commercial.seller_route_days').where({ id: actual.id }).update({
        finished_at: trx.fn.now(),
        finished_how: 'vendedor',
        updated_at: trx.fn.now(),
        updated_by: userId,
      }, ['finished_at']);
      // Lo que levante después de cerrar cae en la tanda «fuera de la ruta», que empieza justo aquí.
      await this.abrirFueraDeRuta(trx, userId, hoy, cerrada.finished_at);
      return { dia: await this.diaDe(trx, userId, hoy), id: actual.id };
    });
    // Fuera de la transacción: el aviso nunca tumba el «Finalizar ruta».
    await this.avisarSurtidores(id, dia);
    return dia;
  }

  // ───────────────────────────── Surtidor ─────────────────────────────

  /** Rutas de hoy (y de ayer sin surtir) con al menos un pedido de mi sucursal. */
  async routes(query: Record<string, unknown> = {}): Promise<RouteBatchInboxResponse> {
    const hoy = relojMx(new Date()).fecha;
    const almacenes = await this.scope.warehouseIds(query, AREA);
    if (almacenes !== null && almacenes.length === 0) return { today: hoy, data: [], scope: 'ninguno' };
    return this.tk.run(async (trx) => {
      const filas = await this.leerRutas(trx, { almacenes, hoy });
      return { today: hoy, data: filas.map((f) => aRenglon(f)), scope: almacenes === null ? 'todos' : 'propios' };
    });
  }

  async routeDetail(id: string, query: Record<string, unknown> = {}): Promise<RouteBatchDetail> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const almacenes = await this.alcance(query);
    return this.tk.run(async (trx) => {
      const fila = await this.rutaEnAlcance(trx, id, almacenes);
      const renglones = await this.renglonesDeRuta(trx, id, almacenes);
      return { route: aRenglon(fila), products: consolidar(renglones) };
    });
  }

  /** Registra quién empieza a surtir la ruta y abre el surtido de cada pedido. Idempotente para la misma persona. */
  async routeStart(id: string, query: Record<string, unknown> = {}): Promise<RouteBatchRow> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const { userId, nombre } = await this.picking.quien();
    const almacenes = await this.alcance(query);
    return this.tk.run(async (trx) => {
      const rd = await this.bloquear(trx, id);
      if (rd.kind !== 'fuera_de_ruta' && !rd.finished_at) throw new ConflictException('La ruta sigue abierta: el vendedor todavía no la finaliza.');
      if (rd.pick_finished_at) throw new ConflictException('Esta ruta ya se surtió.');
      if (rd.pick_started_by && rd.pick_started_by !== userId) {
        throw new ConflictException(`Ya la está surtiendo ${rd.pick_started_by_name} desde ${horaMx(rd.pick_started_at)}.`);
      }
      const renglones = await this.renglonesDeRuta(trx, id, almacenes);
      const pedidos = pedidosDe(renglones);
      if (!pedidos.length) throw new NotFoundException('Esta ruta no tiene pedidos de tu sucursal.');
      const ids = pedidos.map((p) => p.order_id);

      const enOla = await trx('commercial.wave_orders as wo')
        .join('commercial.orders as o', 'o.id', 'wo.order_id')
        .whereIn('wo.order_id', ids)
        .whereNot('wo.stage', 'listo_embarque')
        .first('o.code');
      if (enOla) throw new ConflictException(`El pedido ${enOla.code} ya va en un recorrido de la consola de surtido.`);
      const ajeno = await trx('commercial.presale_picks')
        .whereIn('order_id', ids)
        .whereNull('finished_at')
        .whereNot('started_by', userId)
        .first('started_by_name', 'started_at');
      if (ajeno) throw new ConflictException(`Un pedido de esta ruta ya lo está surtiendo ${ajeno.started_by_name} desde ${horaMx(ajeno.started_at)}.`);

      if (rd.kind === 'fuera_de_ruta' && !rd.finished_at) {
        // Empezar a recolectarla la CIERRA: lo que llegue desde ahora va a la siguiente tanda, y no se
        // mezcla con lo que ya se está surtiendo.
        const [corte] = await trx('commercial.seller_route_days').where({ id })
          .update({ finished_at: trx.fn.now(), updated_at: trx.fn.now(), updated_by: userId }, ['finished_at']);
        // La fecha se copia en SQL: un `date` leído llega como medianoche UTC y en hora MX sería el día anterior.
        await trx.raw(
          `INSERT INTO commercial.seller_route_days (tenant_id, user_id, work_date, kind, started_at, created_by, updated_by)
           SELECT tenant_id, user_id, work_date, 'fuera_de_ruta', ?, ?, ?
             FROM commercial.seller_route_days WHERE id = ?
           ON CONFLICT (tenant_id, user_id, work_date) WHERE deleted_at IS NULL AND kind = 'fuera_de_ruta' AND finished_at IS NULL
           DO NOTHING`,
          [corte.finished_at, userId, userId, id],
        );
      }
      if (!rd.pick_started_by) {
        await trx('commercial.seller_route_days').where({ id }).update({
          pick_started_by: userId,
          pick_started_by_name: nombre,
          pick_started_at: trx.fn.now(),
          updated_at: trx.fn.now(),
          updated_by: userId,
        });
      }
      for (const p of pedidos) {
        await trx.raw(
          `INSERT INTO commercial.presale_picks (tenant_id, order_id, warehouse_id, started_by, started_by_name)
           VALUES (public.current_tenant_id(), ?, ?, ?, ?)
           ON CONFLICT (tenant_id, order_id) DO NOTHING`,
          [p.order_id, p.warehouse_id, userId, nombre],
        );
      }
      // Empezar a surtir es el acuse de los avisos de la sucursal, igual que pedido por pedido.
      await trx('commercial.order_notifications')
        .whereIn('order_id', ids)
        .whereNull('seen_at')
        .update({ seen_at: trx.fn.now(), seen_by: userId });
      const fila = await this.rutaEnAlcance(trx, id, almacenes);
      this.avisarVendedora(fila, 'Tu ruta ya la están surtiendo', `${pedidos.length} ${pedidos.length === 1 ? 'pedido' : 'pedidos'} · ${nombre} empezó a las ${horaMx(fila.pick_started_at ?? new Date())}`);
      return aRenglon(fila);
    });
  }

  /**
   * Cierra la ruta en UNA transacción: reparte lo encontrado y cierra cada pedido como en el
   * surtido por pedido. Si algo falla, no queda ningún pedido a medias.
   */
  async routeFinish(id: string, dto: RouteBatchFinishRequest, query: Record<string, unknown> = {}): Promise<RouteBatchFinishResponse> {
    if (!UUID_RE.test(id)) throw new BadRequestException('id inválido');
    const quien = await this.picking.quien();
    const almacenes = await this.alcance(query);
    return this.tk.run(async (trx) => {
      const rd = await this.bloquear(trx, id);
      if (rd.pick_finished_at) throw new ConflictException('Esta ruta ya se surtió.');
      if (!rd.pick_started_by) throw new ConflictException('Primero toca «Empezar a surtir».');
      if (rd.pick_started_by !== quien.userId) {
        throw new ForbiddenException(`La está surtiendo ${rd.pick_started_by_name}: sólo esa persona la puede cerrar.`);
      }
      const renglones = await this.renglonesDeRuta(trx, id, almacenes);
      if (!renglones.length) throw new NotFoundException('Esta ruta no tiene pedidos de tu sucursal.');
      let cierres: CierreDePedido[];
      try {
        cierres = repartirRuta(consolidar(renglones), renglones, dto?.products ?? []);
      } catch (e) {
        if (e instanceof CierreInvalido) throw new BadRequestException(e.message);
        throw e;
      }

      const bags: RouteBatchBag[] = [];
      for (const c of cierres) {
        const suyos = renglones.filter((r) => r.order_id === c.order_id);
        const [fila] = await this.picking.leer(trx, { almacenes: null, orderId: c.order_id, incluirRutas: true });
        if (!fila) throw new ConflictException(`El pedido ${suyos[0]?.code ?? c.order_id} ya no está por surtir.`);
        let pick = await trx('commercial.presale_picks').where({ order_id: c.order_id }).forUpdate().first();
        if (!pick) {
          // Llegó a la ruta después de «Empezar a surtir» (no debería: la ruta ya estaba finalizada).
          await trx.raw(
            `INSERT INTO commercial.presale_picks (tenant_id, order_id, warehouse_id, started_by, started_by_name)
             VALUES (public.current_tenant_id(), ?, ?, ?, ?)
             ON CONFLICT (tenant_id, order_id) DO NOTHING`,
            [c.order_id, String(fila['warehouse_id']), quien.userId, quien.nombre],
          );
          pick = await trx('commercial.presale_picks').where({ order_id: c.order_id }).forUpdate().first();
        }
        if (pick?.finished_at) throw new ConflictException(`El pedido ${fila['code']} ya se surtió por separado.`);

        const total = Number(fila['total']) || 0;
        const picked = new Map(c.marcados.map((m) => [m.line_id, m.picked]));
        const lines = suyos.map((r) => {
          const m = cantidadMostrada({ quantity: Number(r.quantity), qty_unit: r.qty_unit, qty_factor: r.qty_factor });
          return { product_name: r.product_name, unit: m.unit, ordered: m.qty, picked: picked.get(r.line_id) ?? 0 };
        });
        const base = { order_id: c.order_id, code: fila['code'] as string, customer_name: (fila['customer_name'] as string) ?? null, lines };
        if (c.sin_mercancia) {
          // planearCierre rechaza el pedido vacío: no se cierra, se reporta para que lo cancelen.
          bags.push({ ...base, outcome: 'sin_mercancia', total_before: total, total_after: total });
          continue;
        }
        const { outcome, report } = await this.picking.cerrarPedido(trx, fila, pick.id, c.marcados, quien);
        bags.push({
          ...base,
          outcome,
          total_before: report?.total_before ?? total,
          total_after: report?.total_after ?? total,
        });
      }

      await trx('commercial.seller_route_days').where({ id }).update({
        pick_finished_by: quien.userId,
        pick_finished_by_name: quien.nombre,
        pick_finished_at: trx.fn.now(),
        updated_at: trx.fn.now(),
        updated_by: quien.userId,
      });

      const fila = await this.rutaEnAlcance(trx, id, almacenes);
      const cortos = bags.filter((b) => b.outcome !== 'completo');
      const antes = bags.reduce((s, b) => s + b.total_before, 0);
      const despues = bags.reduce((s, b) => s + b.total_after, 0);
      if (cortos.length) {
        const vacios = bags.filter((b) => b.outcome === 'sin_mercancia').length;
        this.avisarVendedora(
          fila,
          `Reporte de surtido de tu ruta: ${cortos.length} de ${bags.length} ${bags.length === 1 ? 'pedido' : 'pedidos'} con faltantes`,
          `Nuevo total $${despues.toFixed(2)} (antes $${antes.toFixed(2)})${vacios ? ` · ${vacios} sin mercancía: cancélalo${vacios === 1 ? '' : 's'}` : ''}`,
        );
      } else {
        this.avisarVendedora(fila, 'Tu ruta se surtió completa', `${bags.length} ${bags.length === 1 ? 'pedido' : 'pedidos'} · listos para cobrar`);
      }
      return { route_day_id: id, bags };
    });
  }

  // ───────────────────────────── Interno ─────────────────────────────

  /** Abre la tanda «fuera de la ruta» del vendedor desde `desde`. Si ya hay una abierta, no hace nada. */
  private async abrirFueraDeRuta(trx: Knex.Transaction, userId: string, fecha: string, desde: Date | string): Promise<void> {
    await trx.raw(
      `INSERT INTO commercial.seller_route_days (tenant_id, user_id, work_date, kind, started_at, created_by, updated_by)
       VALUES (public.current_tenant_id(), ?, ?, 'fuera_de_ruta', ?, ?, ?)
       ON CONFLICT (tenant_id, user_id, work_date) WHERE deleted_at IS NULL AND kind = 'fuera_de_ruta' AND finished_at IS NULL
       DO NOTHING`,
      [userId, fecha, desde, this.tenantCtx.get()?.userId ?? userId, this.tenantCtx.get()?.userId ?? userId],
    );
  }

  private yo(): string {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new UnauthorizedException('Sin usuario en la sesión.');
    return userId;
  }

  private async alcance(query: Record<string, unknown>): Promise<string[] | null> {
    const almacenes = await this.scope.warehouseIds(query, AREA);
    if (almacenes !== null && almacenes.length === 0) throw new ForbiddenException('Tu usuario no tiene una sucursal asignada.');
    return almacenes;
  }

  private async rutaDelDia(trx: Knex.Transaction, userId: string, hoy: string, paraActualizar = false): Promise<FilaRuta | undefined> {
    const qb = trx('commercial.seller_route_days').where({ user_id: userId, work_date: hoy, kind: 'ruta' }).whereNull('deleted_at');
    if (paraActualizar) qb.forUpdate();
    return qb.first();
  }

  private async bloquear(trx: Knex.Transaction, id: string): Promise<FilaRuta> {
    const rd = await trx('commercial.seller_route_days').where({ id }).whereNull('deleted_at').forUpdate().first();
    if (!rd) throw new NotFoundException('Ruta no encontrada.');
    return rd as FilaRuta;
  }

  /** El día de la persona con sus pedidos dentro de la ventana (hasta ahora, si sigue en ruta). */
  private async diaDe(trx: Knex.Transaction, userId: string, hoy: string): Promise<SellerRouteDay> {
    const rd = await this.rutaDelDia(trx, userId, hoy);
    if (!rd) return { id: null, work_date: hoy, state: 'sin_iniciar', started_at: null, finished_at: null, visited: 0, orders: 0, total: 0 };
    // [MCP.3.6] Clientes DISTINTOS con visita registrada por esta persona dentro de la ventana de
    // la ruta (inicio → fin, o ahora si sigue en ruta). Una visita es la llegada que se registra al
    // abrir al cliente (`vendor_visits`); volver a abrirlo no suma otro. Usa el índice
    // (tenant_id, user_id, visited_at).
    const v = await trx('commercial.vendor_visits')
      .where('user_id', userId)
      .where('visited_at', '>=', rd.started_at)
      .where('visited_at', '<=', rd.finished_at ?? trx.fn.now())
      .first(trx.raw('count(DISTINCT customer_id)::int AS visited'));
    const r = await trx('commercial.seller_route_days as rd')
      .joinRaw(`JOIN commercial.orders o ON ${PEDIDO_EN_RUTA_SQL}`)
      .where('rd.id', rd.id)
      .where('o.status', 'confirmed')
      .where('o.delivery_type', 'route')
      .select(trx.raw('count(*)::int AS orders'), trx.raw('coalesce(sum(o.total), 0) AS total'))
      .first();
    return {
      id: rd.id,
      work_date: hoy,
      state: rd.finished_at ? 'finalizada' : 'en_ruta',
      started_at: iso(rd.started_at),
      finished_at: iso(rd.finished_at),
      visited: Number(v?.visited) || 0,
      orders: Number(r?.orders) || 0,
      total: Number(r?.total) || 0,
    };
  }

  private async rutaEnAlcance(trx: Knex.Transaction, id: string, almacenes: string[] | null): Promise<FilaRutaConConteo> {
    const [fila] = await this.leerRutas(trx, { almacenes, id });
    if (!fila) throw new NotFoundException('Ruta no encontrada en tu sucursal.');
    return fila;
  }

  /**
   * Las rutas con sus conteos. Una ruta sin ningún pedido de mi sucursal no sale (JOIN). Lo que
   * cuenta es lo que está por surtir (`confirmed`); ya surtida, cuenta todo lo no cancelado.
   */
  private async leerRutas(
    trx: Knex.Transaction,
    f: { almacenes: string[] | null; hoy?: string; id?: string },
  ): Promise<FilaRutaConConteo[]> {
    const qb = trx('commercial.seller_route_days as rd')
      .joinRaw(`JOIN commercial.orders o ON ${PEDIDO_EN_RUTA_SQL}`)
      .leftJoin('commercial.order_lines as l', 'l.order_id', 'o.id')
      .leftJoin('identity.users as u', 'u.id', 'rd.user_id')
      .whereNull('rd.deleted_at')
      .where('o.delivery_type', 'route')
      .whereNotNull('o.requested_delivery_date')
      .whereRaw(`(o.status = 'confirmed' OR (rd.pick_finished_at IS NOT NULL AND o.status <> 'cancelled'))`);
    if (f.almacenes !== null) qb.whereIn('o.warehouse_id', f.almacenes);
    if (f.id) qb.where('rd.id', f.id);
    if (f.hoy) {
      const ayer = sumarDias(f.hoy, -1);
      qb.where(function () {
        this.where('rd.work_date', f.hoy as string).orWhere(function () {
          this.where('rd.work_date', ayer).whereNull('rd.pick_finished_at');
        });
      });
    }
    const filas = await qb
      .groupBy('rd.id', 'u.nombre', 'u.username')
      .select(
        'rd.id', 'rd.user_id', 'rd.kind', 'rd.started_at', 'rd.finished_at',
        'rd.pick_started_by', 'rd.pick_started_by_name', 'rd.pick_started_at',
        'rd.pick_finished_by', 'rd.pick_finished_by_name', 'rd.pick_finished_at',
        trx.raw(`to_char(rd.work_date, 'YYYY-MM-DD') AS work_date`),
        trx.raw(`coalesce(nullif(btrim(u.nombre), ''), u.username) AS seller_name`),
        'u.username as seller_username',
        trx.raw('count(DISTINCT o.id)::int AS orders'),
        trx.raw('count(DISTINCT l.product_id)::int AS products'),
      )
      .orderByRaw('rd.work_date ASC, rd.finished_at ASC NULLS LAST, rd.started_at ASC')
      .limit(200);
    return filas as FilaRutaConConteo[];
  }

  /** Los renglones de los pedidos de la ruta que están por surtir, en mi alcance. */
  private async renglonesDeRuta(
    trx: Knex.Transaction,
    id: string,
    almacenes: string[] | null,
  ): Promise<Array<RenglonDeRuta & { warehouse_id: string }>> {
    const qb = trx('commercial.seller_route_days as rd')
      .joinRaw(`JOIN commercial.orders o ON ${PEDIDO_EN_RUTA_SQL}`)
      .join('commercial.order_lines as l', 'l.order_id', 'o.id')
      // [MCP.3.1] La columna es `nombre`, no `name` (con `p.name` ya hubo un 500 en prod).
      .leftJoin('catalog.products as p', 'p.id', 'l.product_id')
      .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
      .leftJoin('commercial.customers as c', function () {
        this.on('c.id', '=', 'o.customer_id').andOn('c.tenant_id', '=', 'o.tenant_id');
      })
      .where('rd.id', id)
      .whereNull('rd.deleted_at')
      .where('o.status', 'confirmed')
      .where('o.delivery_type', 'route')
      .whereNotNull('o.requested_delivery_date');
    if (almacenes !== null) qb.whereIn('o.warehouse_id', almacenes);
    const filas = await qb
      .select(
        'o.id as order_id', 'o.code', 'c.name as customer_name', 'o.confirmed_at', 'o.warehouse_id',
        trx.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS delivery_date`),
        'l.id as line_id', 'l.product_id', 'p.sku', 'p.barcode', 'p.nombre as product_name',
        trx.raw('coalesce(b.display_name, b.nombre) AS brand'),
        'l.quantity', 'l.qty_unit', 'l.qty_factor',
      )
      .orderByRaw('o.confirmed_at ASC NULLS LAST, o.code ASC, l.created_at ASC');
    return (filas as Array<Record<string, unknown>>).map((r) => ({
      order_id: r['order_id'] as string,
      code: r['code'] as string,
      customer_name: (r['customer_name'] as string) ?? null,
      confirmed_at: iso(r['confirmed_at']),
      delivery_date: (r['delivery_date'] as string) ?? null,
      warehouse_id: String(r['warehouse_id']),
      line_id: r['line_id'] as string,
      product_id: r['product_id'] as string,
      sku: (r['sku'] as string) ?? null,
      barcode: (r['barcode'] as string) ?? null,
      product_name: (r['product_name'] as string) ?? 'Producto',
      brand: (r['brand'] as string) ?? null,
      quantity: Number(r['quantity']),
      qty_unit: (r['qty_unit'] as string) ?? null,
      qty_factor: r['qty_factor'] == null ? null : Number(r['qty_factor']),
    }));
  }

  /**
   * «Ruta lista» al surtidor de las sucursales de sus pedidos, por el mismo canal que el aviso de
   * cada pedido (`emitTo` a quien tiene `COMMERCIAL_PICKING_GESTIONAR` en esa sucursal, ver
   * `CommercialOrdersService.avisarSucursal`). Sin tabla nueva: la bandeja de rutas se deriva del
   * estado, así que si el aviso se pierde la ruta igual aparece en «Rutas».
   */
  private async avisarSurtidores(routeId: string, dia: SellerRouteDay): Promise<void> {
    const tenantId = this.tenantCtx.get()?.tenantId;
    if (!tenantId) return;
    try {
      await this.tk.run(async (trx) => {
        const almacenes = await trx('commercial.seller_route_days as rd')
          .joinRaw(`JOIN commercial.orders o ON ${PEDIDO_EN_RUTA_SQL}`)
          .where('rd.id', routeId)
          .where('o.status', 'confirmed')
          .where('o.delivery_type', 'route')
          .whereNotNull('o.warehouse_id')
          .distinct('o.warehouse_id');
        const vendedor = await trx('identity.users').where({ id: this.tenantCtx.get()?.userId }).first('nombre', 'username');
        const quien = String(vendedor?.nombre ?? '').trim() || String(vendedor?.username ?? '').trim() || 'El vendedor';
        for (const { warehouse_id } of almacenes as Array<{ warehouse_id: string }>) {
          const { rows: gente } = await trx.raw(
            `SELECT DISTINCT u.username
               FROM identity.users u
               JOIN identity.role_permissions rp
                 ON rp.role_name = u.role_name AND rp.deleted_at IS NULL
              WHERE u.tenant_id = ? AND u.activo AND u.deleted_at IS NULL
                AND (u.warehouse_id = ?
                     OR btrim(u.warehouse_code) IN (
                       SELECT btrim(w.code) FROM commercial.warehouses w WHERE w.id = ?
                       UNION SELECT btrim(w.kepler_code) FROM commercial.warehouses w
                        WHERE w.id = ? AND w.kepler_code IS NOT NULL))
                AND (rp.permissions ->> 'COMMERCIAL_PICKING_GESTIONAR') = 'true'`,
            [tenantId, warehouse_id, warehouse_id, warehouse_id],
          );
          for (const g of gente as Array<{ username: string }>) {
            this.alerts.emitTo(tenantId, g.username, {
              type: 'order_to_pick',
              severity: 'info',
              title: 'Ruta lista para surtir',
              message: `${quien} · ${dia.orders} ${dia.orders === 1 ? 'pedido' : 'pedidos'}`,
              data: { route_day_id: routeId, warehouse_id, route: `/almacen/surtir?ruta=${routeId}` },
            });
          }
        }
      });
    } catch (e) {
      this.logger.warn(`[MCP.3.6] aviso de ruta lista al surtidor falló (ruta ${routeId}): ${(e as Error).message}`);
    }
    this.logger.log(`[MCP.3.6] ruta ${routeId} finalizada · ${dia.orders} pedidos`);
  }

  /** Aviso a la vendedora en vivo y al celular. Nunca tumba el surtido: lo que se pierde es el aviso. */
  private avisarVendedora(fila: FilaRutaConConteo, titulo: string, mensaje: string): void {
    const tenantId = this.tenantCtx.get()?.tenantId;
    const route = '/vendor/mis-pedidos';
    try {
      if (tenantId && fila.seller_username) {
        this.alerts.emitTo(tenantId, fila.seller_username, {
          type: 'presale_pick',
          severity: 'info',
          title: titulo,
          message: mensaje,
          data: { route_day_id: fila.id, route },
        });
      }
    } catch (e) {
      this.logger.warn(`[MCP.3.6] aviso en vivo a la vendedora falló: ${(e as Error).message}`);
    }
    if (fila.user_id) {
      void Promise.resolve()
        .then(() => this.push.sendToUser(fila.user_id, { title: titulo, body: mensaje, url: route }))
        .catch((e) => this.logger.warn(`[MCP.3.6] push a la vendedora falló: ${(e as Error).message}`));
    }
  }
}

/** Los pedidos distintos de los renglones, con su sucursal. */
function pedidosDe(renglones: ReadonlyArray<RenglonDeRuta & { warehouse_id: string }>): Array<{ order_id: string; warehouse_id: string }> {
  const vistos = new Map<string, string>();
  for (const r of renglones) if (!vistos.has(r.order_id)) vistos.set(r.order_id, r.warehouse_id);
  return Array.from(vistos, ([order_id, warehouse_id]) => ({ order_id, warehouse_id }));
}

function estadoDe(f: FilaRuta): RouteBatchState {
  if (!f.finished_at && f.kind !== 'fuera_de_ruta') return 'en_ruta';
  if (f.pick_finished_at) return 'surtida';
  if (f.pick_started_at) return 'surtiendo';
  return 'lista';
}

function aRenglon(f: FilaRutaConConteo): RouteBatchRow {
  return {
    route_day_id: f.id,
    kind: f.kind ?? 'ruta',
    seller_name: f.seller_name ?? null,
    work_date: f.work_date,
    state: estadoDe(f),
    started_at: iso(f.started_at) as string,
    finished_at: iso(f.finished_at),
    orders: Number(f.orders) || 0,
    products: Number(f.products) || 0,
    pick_started: f.pick_started_at
      ? { user_id: f.pick_started_by ?? '', name: f.pick_started_by_name ?? '', at: iso(f.pick_started_at) as string }
      : null,
    pick_finished: f.pick_finished_at
      ? { user_id: f.pick_finished_by ?? '', name: f.pick_finished_by_name ?? '', at: iso(f.pick_finished_at) as string }
      : null,
  };
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
