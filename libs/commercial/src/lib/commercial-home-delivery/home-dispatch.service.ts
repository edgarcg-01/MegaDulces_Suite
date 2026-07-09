import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';
import { AlertsService } from '../commercial-alerts/alerts.service';
import { solveOpenRoute, centroid, GeoPoint } from './route-solver';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse tolerante de JSONB serializado (nunca lanza). */
function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Valor más frecuente de un arreglo (moda), o null si vacío. */
function mode(arr: string[]): string | null {
  if (!arr.length) return null;
  const counts = new Map<string, number>();
  let best: string | null = null;
  let bestN = 0;
  for (const v of arr) {
    const n = (counts.get(v) || 0) + 1;
    counts.set(v, n);
    if (n > bestN) { bestN = n; best = v; }
  }
  return best;
}

export interface DispatchOrderDto {
  rider_user_id: string; // usuario con rol repartidor (dominio Reparto)
  vehicle_id?: string; // moto opcional (para overflow CEDIS)
  shipment_date: string; // YYYY-MM-DD
}

export interface DispatchFromKeplerDto {
  folio: string;
  serie?: string;
  warehouse_code: string;
  rider_user_id: string;
  vehicle_id?: string;
  shipment_date: string;
  delivery_address: {
    recipient_name?: string;
    phone?: string;
    street?: string;
    references?: string;
    lat?: number;
    lng?: number;
  };
  /** COD explícito. Si se omite, se deriva de forma_pago (CONTADO → false). */
  collect_on_delivery?: boolean;
  /** Monto a cobrar si COD. Si se omite y COD, se usa el total del ticket. */
  amount_to_collect?: number;
}

/**
 * Fase LM.3 + LM-K.2 — DESPACHO de entregas a domicilio a REPARTIDORES en moto.
 *
 * DESACOPLADO de logística (decisión 2026-07-03): el repartidor es un USUARIO
 * con rol `repartidor`, NO un chofer de la flota. La entrega vive en la tabla
 * propia `commercial.home_deliveries` (colapsa embarque+guía+parada en 1 fila),
 * asignada por `rider_user_id`. La moto (`vehicle_id`) es opcional y solo se usa
 * para el aviso de overflow CEDIS.
 *
 * Se despacha desde:
 *   - un pedido de intake propio (commercial.orders home_delivery), o
 *   - un TICKET de Kepler (referencia el folio, NO materializa orden, NO mueve
 *     stock — Kepler ya lo descontó en el POS).
 */
@Injectable()
export class HomeDispatchService {
  private readonly logger = new Logger(HomeDispatchService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
    private readonly alerts: AlertsService,
  ) {}

  private async nextFolio(trx: any): Promise<string> {
    const year = new Date().getFullYear();
    const [{ current_value }] = (
      await trx.raw(
        `INSERT INTO commercial.home_delivery_sequences (tenant_id, year, current_value)
         VALUES (public.current_tenant_id(), ?, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.home_delivery_sequences.current_value + 1, updated_at = now()
         RETURNING current_value`,
        [year],
      )
    ).rows;
    return `REP-${year}-${String(current_value).padStart(5, '0')}`;
  }

  /** Valida que el asignado sea un usuario repartidor activo del tenant. Devuelve moto (opcional). */
  private async assertRiderVehicle(trx: any, riderUserId: string, vehicleId?: string) {
    if (!UUID_RE.test(riderUserId)) throw new BadRequestException('rider_user_id (repartidor) requerido');
    const rider = await trx('identity.users')
      .where({ id: riderUserId })
      .whereNull('deleted_at')
      .first();
    if (!rider) throw new NotFoundException(`Repartidor ${riderUserId} no encontrado`);
    if (rider.role_name !== 'repartidor')
      throw new BadRequestException('El usuario asignado no tiene rol repartidor');

    let vehicle: any = null;
    if (vehicleId) {
      if (!UUID_RE.test(vehicleId)) throw new BadRequestException('vehicle_id inválido');
      vehicle = await trx('logistics.vehicles').where({ id: vehicleId }).whereNull('deleted_at').first();
      if (!vehicle) throw new NotFoundException(`Unidad ${vehicleId} no encontrada`);
    }
    return { rider, vehicle };
  }

  private cedisNote(units: number, capacity: number | null): string | null {
    return capacity != null && units > capacity
      ? `REQUIERE CEDIS: ${units} u excede capacidad de la moto (${capacity} u). Reasignar a camión.`
      : null;
  }

  /** Repartidores asignables: usuarios con rol repartidor (opcional scope por sucursal). */
  async listRiders(opts: { warehouse_code?: string } = {}) {
    return this.tk.run(async (trx) => {
      let q = trx('identity.users')
        .where({ role_name: 'repartidor', activo: true })
        .whereNull('deleted_at');
      if (opts.warehouse_code) q = q.andWhere({ warehouse_code: opts.warehouse_code });
      return q
        .select('id as rider_user_id', 'username', 'nombre as full_name', 'warehouse_code')
        .orderBy('nombre', 'asc');
    });
  }

  // ── Despacho desde pedido de intake propio (commercial.orders home_delivery) ──
  async dispatchOrder(orderId: string, dto: DispatchOrderDto) {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('orderId inválido');
    if (!dto?.shipment_date) throw new BadRequestException('shipment_date requerido');

    return this.tk.run(async (trx) => {
      const order = await trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .where('o.id', orderId)
        .whereNull('o.deleted_at')
        .select('o.*', 'c.name as customer_name')
        .first();
      if (!order) throw new NotFoundException(`Order ${orderId} no encontrada`);
      if (order.delivery_type !== 'home_delivery')
        throw new BadRequestException('El pedido no es de entrega a domicilio');
      if (!['confirmed', 'pending_approval'].includes(order.status))
        throw new ConflictException(`El pedido debe estar confirmado (status=${order.status})`);

      const dup = await trx('commercial.home_deliveries')
        .where({ order_id: orderId })
        .whereNull('deleted_at')
        .first();
      if (dup) throw new ConflictException('El pedido ya fue despachado');

      const { vehicle } = await this.assertRiderVehicle(trx, dto.rider_user_id, dto.vehicle_id);
      const addr = order.delivery_address
        ? (typeof order.delivery_address === 'string' ? JSON.parse(order.delivery_address) : order.delivery_address)
        : null;

      const [{ units }] = await trx('commercial.order_lines').where({ order_id: orderId }).sum('quantity as units');
      const totalUnits = Math.round(Number(units) || 0);
      const capacity = vehicle?.capacity_boxes != null ? Number(vehicle.capacity_boxes) : null;

      return this.createDelivery(trx, {
        shipment_date: dto.shipment_date,
        vehicle_id: dto.vehicle_id || null,
        rider_user_id: dto.rider_user_id,
        order_id: orderId,
        customer_id: order.customer_id || null,
        customer_name: addr?.recipient_name || order.customer_name || `Pedido ${order.code}`,
        phone: addr?.phone || null,
        address: addr,
        value: Number(order.total) || 0,
        units: totalUnits,
        capacity,
        // Intake propio: el cobro se maneja por el flujo commercial (balance_due).
        collect_on_delivery: Number(order.balance_due) > 0,
        amount_to_collect: Number(order.balance_due) > 0 ? Number(order.balance_due) : null,
      });
    });
  }

  // ── Despacho desde folio de Kepler (referencia, sin materializar orden) ──
  async dispatchFromKepler(dto: DispatchFromKeplerDto) {
    const folio = (dto?.folio || '').trim();
    const warehouseCode = (dto?.warehouse_code || '').trim();
    const serie = (dto?.serie || '').trim();
    if (!folio) throw new BadRequestException('folio requerido');
    if (!warehouseCode) throw new BadRequestException('warehouse_code requerido');
    if (!dto?.shipment_date) throw new BadRequestException('shipment_date requerido');
    if (!dto?.delivery_address?.street)
      throw new BadRequestException('delivery_address.street requerido (Kepler no trae domicilio)');

    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();

      // Allowlist de sucursales habilitadas (piloto 01/02/03).
      const wh = await trx('logistics.home_delivery_warehouses')
        .where({ tenant_id: tenantId, warehouse_code: warehouseCode, enabled: true })
        .first();
      if (!wh)
        throw new BadRequestException(`Sucursal ${warehouseCode} no habilitada para entrega a domicilio`);

      // Ticket del buffer del día (app_runtime tiene SELECT; tabla sin RLS).
      let tq = trx('analytics.store_live_tickets')
        .where({ tenant_id: tenantId, warehouse_code: warehouseCode, folio });
      if (serie) tq = tq.andWhere('serie', serie);
      const ticket = await tq.orderBy('ticket_ts', 'desc').first();
      if (!ticket)
        throw new NotFoundException(`Ticket ${warehouseCode}/${serie || '*'}/${folio} no encontrado (ventana del día)`);

      // Anti doble-despacho por folio.
      const dup = await trx('commercial.home_deliveries')
        .where({ kepler_warehouse_code: warehouseCode, kepler_serie: ticket.serie, kepler_folio: folio })
        .whereNull('deleted_at')
        .first();
      if (dup) throw new ConflictException('Ese folio ya fue despachado');

      const { vehicle } = await this.assertRiderVehicle(trx, dto.rider_user_id, dto.vehicle_id);
      const items = typeof ticket.items === 'string' ? JSON.parse(ticket.items) : ticket.items || [];
      const totalUnits = Math.round(items.reduce((s: number, it: any) => s + (Number(it.cant) || 0), 0));
      const capacity = vehicle?.capacity_boxes != null ? Number(vehicle.capacity_boxes) : null;
      const total = Number(ticket.total) || 0;

      // COD: explícito o derivado de forma_pago (CONTADO = ya pagado en tienda).
      const alreadyPaid = String(ticket.forma_pago || '').toUpperCase() === 'CONTADO';
      const collect = dto.collect_on_delivery ?? !alreadyPaid;
      const amountToCollect = collect ? (dto.amount_to_collect ?? total) : null;

      return this.createDelivery(trx, {
        shipment_date: dto.shipment_date,
        vehicle_id: dto.vehicle_id || null,
        rider_user_id: dto.rider_user_id,
        order_id: null,
        customer_id: null,
        customer_name: dto.delivery_address.recipient_name || `Ticket ${folio}`,
        phone: dto.delivery_address.phone || null,
        address: dto.delivery_address,
        value: total,
        units: totalUnits,
        capacity,
        collect_on_delivery: collect,
        amount_to_collect: amountToCollect,
        kepler: { folio, serie: ticket.serie, warehouse_code: warehouseCode, items },
      });
    });
  }

  /** Inserta la parada a domicilio (fila propia de Reparto). */
  private async createDelivery(
    trx: any,
    p: {
      shipment_date: string;
      vehicle_id: string | null;
      rider_user_id: string;
      order_id: string | null;
      customer_id: string | null;
      customer_name: string;
      phone: string | null;
      address: any;
      value: number;
      units: number;
      capacity: number | null;
      collect_on_delivery: boolean;
      amount_to_collect: number | null;
      kepler?: { folio: string; serie: string; warehouse_code: string; items: any[] };
    },
  ) {
    const requiresCedis = p.capacity != null && p.units > p.capacity;
    const folio = await this.nextFolio(trx);

    const [row] = await trx('commercial.home_deliveries')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        folio,
        rider_user_id: p.rider_user_id,
        vehicle_id: p.vehicle_id,
        order_id: p.order_id,
        customer_id: p.customer_id,
        kepler_folio: p.kepler?.folio ?? null,
        kepler_serie: p.kepler?.serie ?? null,
        kepler_warehouse_code: p.kepler?.warehouse_code ?? null,
        customer_name: p.customer_name,
        phone: p.phone,
        delivery_address: p.address ? JSON.stringify(p.address) : null,
        items_snapshot: p.kepler ? JSON.stringify(p.kepler.items) : null,
        value: p.value,
        units: p.units,
        collect_on_delivery: p.collect_on_delivery,
        amount_to_collect: p.amount_to_collect,
        requires_cedis: requiresCedis,
        cedis_note: this.cedisNote(p.units, p.capacity),
        status: 'pendiente',
        shipment_date: p.shipment_date,
        dispatched_by: this.tenantCtx.get()?.userId || null,
      })
      .returning(['id', 'folio']);

    // Aviso in-app al repartidor: nueva entrega asignada (filtra por rider_user_id).
    const tenantId = this.tenantCtx.get()?.tenantId;
    if (tenantId) {
      this.alerts.emitDeliveryAssigned(tenantId, {
        delivery_id: row.id,
        folio: row.folio,
        rider_user_id: p.rider_user_id,
        customer_name: p.customer_name,
        address: p.address?.street || null,
        units: p.units,
        collect_on_delivery: p.collect_on_delivery,
        amount_to_collect: p.amount_to_collect,
      });
    }

    return {
      delivery_id: row.id,
      recipient_id: row.id, // alias de compatibilidad con el flujo anterior
      folio: row.folio,
      total_units: p.units,
      capacity_boxes: p.capacity,
      requires_cedis: requiresCedis,
      collect_on_delivery: p.collect_on_delivery,
      amount_to_collect: p.amount_to_collect,
    };
  }

  /**
   * Fase LM.8 — KPIs de última milla (§13 SOP) en un rango de fechas.
   * Tiempo de entrega = delivered_at − dispatched_at. El cuadre de efectivo
   * sale de los cortes cerrados (rider_liquidations).
   */
  async kpis(opts: { from?: string; to?: string } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const from = opts.from || today;
    const to = opts.to || today;

    return this.tk.run(async (trx) => {
      const paradas = await trx('commercial.home_deliveries')
        .whereNull('deleted_at')
        .whereRaw('dispatched_at::date BETWEEN ? AND ?', [from, to])
        .select('status', 'incident_type', 'dispatched_at', 'delivered_at');

      const total = paradas.length;
      let delivered = 0;
      let incidents = 0;
      let minutesSum = 0;
      let minutesN = 0;
      for (const p of paradas) {
        if (p.status === 'entregado') delivered++;
        if (p.incident_type) incidents++;
        if (p.delivered_at && p.dispatched_at) {
          const mins = (new Date(p.delivered_at).getTime() - new Date(p.dispatched_at).getTime()) / 60000;
          if (mins >= 0 && mins < 1440) { minutesSum += mins; minutesN++; }
        }
      }

      const liqs = await trx('commercial.rider_liquidations')
        .whereBetween('business_date', [from, to])
        .where('status', 'closed')
        .whereNull('deleted_at')
        .select('cash_counted', 'cash_difference', 'card_total', 'transfer_total');
      const cashCounted = liqs.reduce((s: number, l: any) => s + Number(l.cash_counted || 0), 0);
      const cashDiffAbs = liqs.reduce((s: number, l: any) => s + Math.abs(Number(l.cash_difference || 0)), 0);
      const cardTotal = liqs.reduce((s: number, l: any) => s + Number(l.card_total || 0), 0);
      const transferTotal = liqs.reduce((s: number, l: any) => s + Number(l.transfer_total || 0), 0);

      const pct = (n: number) => (total ? Math.round((n / total) * 1000) / 10 : 0);
      return {
        from,
        to,
        deliveries_total: total,
        delivered,
        incidents,
        success_rate_pct: pct(delivered), // meta ≥98
        incident_rate_pct: pct(incidents), // meta ≤2
        avg_delivery_min: minutesN ? Math.round((minutesSum / minutesN) * 10) / 10 : null, // meta ≤60
        cash_counted: Math.round(cashCounted * 100) / 100,
        cash_difference_abs: Math.round(cashDiffAbs * 100) / 100, // meta 0
        card_total: Math.round(cardTotal * 100) / 100,
        transfer_total: Math.round(transferTotal * 100) / 100,
        cuts_closed: liqs.length,
      };
    });
  }

  /**
   * Tracking para la tienda: dónde va cada pedido despachado (estado + repartidor
   * + hora de entrega). Por default el día de hoy; filtrable por sucursal Kepler
   * y estado.
   */
  async listDispatched(opts: { warehouse_code?: string; date?: string; status?: string } = {}) {
    const date = opts.date || new Date().toISOString().slice(0, 10);
    return this.tk.run(async (trx) => {
      let q = trx('commercial.home_deliveries as d')
        .leftJoin('identity.users as u', 'u.id', 'd.rider_user_id')
        .leftJoin('commercial.orders as o', 'o.id', 'd.order_id')
        .whereNull('d.deleted_at')
        .whereRaw('d.dispatched_at::date = ?', [date]);
      if (opts.warehouse_code) q = q.andWhere('d.kepler_warehouse_code', opts.warehouse_code);
      if (opts.status) q = q.andWhere('d.status', opts.status);

      return q
        .select(
          'd.id as delivery_id',
          'd.folio',
          'd.status',
          'd.customer_name',
          'd.phone',
          'd.delivery_address',
          'd.kepler_folio',
          'd.kepler_warehouse_code',
          'd.collect_on_delivery',
          'd.amount_to_collect',
          'd.incident_type',
          'd.dispatched_at',
          'd.delivered_at',
          'd.rider_user_id',
          'u.nombre as rider_name',
          'u.username as rider_username',
          'o.code as order_code',
        )
        .orderBy('d.dispatched_at', 'desc');
    });
  }

  /** Extrae lat/lng del delivery_address JSONB (string u objeto). */
  private addrCoords(delivery_address: any): { lat: number; lng: number } | null {
    if (!delivery_address) return null;
    const a = typeof delivery_address === 'string' ? safeJson(delivery_address) : delivery_address;
    const lat = Number(a?.lat);
    const lng = Number(a?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }

  /**
   * LM.10 — Ruta óptima del repartidor autenticado para una fecha (hoy default).
   *
   * Toma sus paradas pendientes con coordenadas, resuelve el mejor orden de
   * visita (open-route NN + 2-opt) y PERSISTE `sequence_order` para que la app y
   * el tracking de tienda coincidan. Las paradas sin coordenada se devuelven
   * aparte (`unlocated`) para que el repartidor las vea igual (navega por texto).
   *
   * Origen de la ruta, por prioridad:
   *   1) GPS fresco del repartidor (último ping < 30 min),
   *   2) coord de la sucursal (kepler_warehouse_code más común),
   *   3) centroide de las paradas.
   */
  async myRoute(opts: { date?: string } = {}) {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Sin user_id en contexto');
    const date = opts.date || new Date().toISOString().slice(0, 10);

    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();

      const rows = await trx('commercial.home_deliveries')
        .where('rider_user_id', userId)
        .andWhere('status', 'pendiente')
        .andWhere('shipment_date', date)
        .whereNull('deleted_at')
        .select(
          'id',
          'folio',
          'customer_name',
          'phone',
          'delivery_address',
          'kepler_warehouse_code',
          'value',
          'units',
          'collect_on_delivery',
          'amount_to_collect',
          'sequence_order',
        );

      const located: (GeoPoint & { row: any })[] = [];
      const unlocated: any[] = [];
      for (const r of rows) {
        const c = this.addrCoords(r.delivery_address);
        if (c) located.push({ id: r.id, lat: c.lat, lng: c.lng, row: r });
        else unlocated.push(r);
      }

      // Origen: GPS fresco del repartidor → sucursal → centroide.
      let origin: { lat: number; lng: number } | null = null;
      const ping = await trx('public.route_location_pings')
        .where({ tenant_id: tenantId, user_id: userId })
        .whereRaw(`captured_at > now() - interval '30 minutes'`)
        .orderBy('captured_at', 'desc')
        .first();
      if (ping && Number.isFinite(Number(ping.lat)) && Number.isFinite(Number(ping.lng))) {
        origin = { lat: Number(ping.lat), lng: Number(ping.lng) };
      }
      if (!origin && located.length) {
        const codes = located.map((l) => l.row.kepler_warehouse_code).filter(Boolean);
        const topCode = mode(codes);
        if (topCode) {
          const wh = await trx('logistics.home_delivery_warehouses')
            .where({ tenant_id: tenantId, warehouse_code: topCode })
            .first();
          if (wh && Number.isFinite(Number(wh.lat)) && Number.isFinite(Number(wh.lng))) {
            origin = { lat: Number(wh.lat), lng: Number(wh.lng) };
          }
        }
      }
      if (!origin) origin = centroid(located.map((l) => ({ lat: l.lat, lng: l.lng })));

      let ordered: any[] = [];
      let totalKm = 0;
      if (located.length && origin) {
        const solved = solveOpenRoute(origin, located.map((l) => ({ id: l.id, lat: l.lat, lng: l.lng })));
        totalKm = solved.total_km;
        const byId = new Map(located.map((l) => [l.id, l]));
        ordered = solved.order.map((id, i) => {
          const l = byId.get(id)!;
          return this.mapStop(l.row, i + 1, l.lat, l.lng);
        });

        // Persistir sequence_order para que el tracking de tienda coincida.
        const now = trx.fn.now();
        for (let i = 0; i < solved.order.length; i++) {
          await trx('commercial.home_deliveries')
            .where('id', solved.order[i])
            .update({ sequence_order: i + 1, route_computed_at: now });
        }
      }

      return {
        date,
        origin,
        total_km: totalKm,
        stops_count: ordered.length,
        stops: ordered,
        unlocated: unlocated.map((r) => this.mapStop(r, null, null, null)),
      };
    });
  }

  private mapStop(r: any, seq: number | null, lat: number | null, lng: number | null) {
    const a = typeof r.delivery_address === 'string' ? safeJson(r.delivery_address) : r.delivery_address;
    return {
      delivery_id: r.id,
      folio: r.folio,
      sequence_order: seq,
      customer_name: r.customer_name,
      phone: r.phone,
      street: a?.street || null,
      references: a?.references || null,
      lat,
      lng,
      value: Number(r.value) || 0,
      units: r.units,
      collect_on_delivery: r.collect_on_delivery,
      amount_to_collect: r.amount_to_collect != null ? Number(r.amount_to_collect) : null,
    };
  }

  /**
   * LM.10 — Última posición conocida de cada repartidor (para el mapa de tienda).
   * Lee public.route_location_pings (sin RLS → tenant explícito) y toma el ping
   * más reciente por repartidor dentro de una ventana. El vivo real llega por WS
   * `route_ping`; esto es el seed inicial.
   */
  async riderPositions(opts: { sinceMin?: number } = {}) {
    const sinceMin = Math.min(Math.max(Number(opts.sinceMin) || 30, 1), 240);
    return this.tk.run(async (trx) => {
      const tenantId = this.tenantCtx.requireTenantId();
      const rows = await trx('public.route_location_pings as p')
        .join('identity.users as u', 'u.id', 'p.user_id')
        .where('p.tenant_id', tenantId)
        .andWhere('u.role_name', 'repartidor')
        .whereNull('u.deleted_at')
        .whereRaw(`p.captured_at > now() - (? || ' minutes')::interval`, [sinceMin])
        .select(
          trx.raw('DISTINCT ON (p.user_id) p.user_id as rider_user_id'),
          'u.username',
          'u.nombre as full_name',
          'p.lat',
          'p.lng',
          'p.captured_at',
          'p.speed_mps',
          'p.accuracy_m',
        )
        .orderBy([
          { column: 'p.user_id' },
          { column: 'p.captured_at', order: 'desc' },
        ]);
      return { positions: rows, server_now: new Date().toISOString() };
    });
  }

  /** Paradas a domicilio del repartidor autenticado (por rider_user_id). */
  async myDeliveries(opts: { pending?: boolean } = {}) {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Sin user_id en contexto');

    return this.tk.run(async (trx) => {
      let q = trx('commercial.home_deliveries as d')
        .leftJoin('commercial.orders as o', 'o.id', 'd.order_id')
        .where('d.rider_user_id', userId)
        .whereNull('d.deleted_at');
      if (opts.pending !== false) q = q.whereIn('d.status', ['pendiente', 'no_entregado']);

      return q
        .select(
          'd.id as recipient_id', // alias de compatibilidad (el front lo usa como id de parada)
          'd.id as delivery_id',
          'd.status',
          'd.customer_name',
          'd.phone',
          'd.delivery_address',
          'd.gps_lat',
          'd.gps_lng',
          'd.incident_type',
          'd.items_snapshot',
          'd.collect_on_delivery',
          'd.amount_to_collect',
          'd.kepler_folio',
          'd.folio as shipment_folio',
          'd.cedis_note as shipment_notes',
          'd.requires_cedis',
          'o.id as order_id',
          'o.code as order_code',
          'o.total',
          'o.balance_due',
        )
        .orderBy('d.dispatched_at', 'desc');
    });
  }
}
