import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DispatchOrderDto {
  driver_id: string; // logistics.drivers.id (repartidor)
  vehicle_id: string; // logistics.vehicles.id (moto)
  shipment_date: string; // YYYY-MM-DD
}

export interface DispatchFromKeplerDto {
  folio: string;
  serie?: string;
  warehouse_code: string;
  driver_id: string;
  vehicle_id: string;
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
 * Fase LM.3 + LM-K.2 — DESPACHO de entregas a domicilio a repartidores en moto.
 *
 * NO vive en logística (logística = embarques/flota/foráneo): esto es fulfillment
 * comercial disparado por tienda. Crea el embarque + guía + parada (artefactos
 * logistics.* reusados) desde:
 *   - un pedido de intake propio (commercial.orders home_delivery), o
 *   - un TICKET de Kepler (referencia el folio, NO materializa orden, NO mueve
 *     stock — Kepler ya lo descontó en el POS).
 * Regla de overflow: unidades > capacidad de la moto → aviso CEDIS.
 */
@Injectable()
export class HomeDispatchService {
  private readonly logger = new Logger(HomeDispatchService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  private async nextFolio(trx: any, prefix: 'EMB' | 'GUIA'): Promise<string> {
    const year = new Date().getFullYear();
    const [{ current_value }] = (
      await trx.raw(
        `INSERT INTO logistics.sequences (tenant_id, prefix, year, current_value)
         VALUES (public.current_tenant_id(), ?, ?, 1)
         ON CONFLICT (tenant_id, prefix, year) DO UPDATE
           SET current_value = logistics.sequences.current_value + 1, updated_at = now()
         RETURNING current_value`,
        [prefix, year],
      )
    ).rows;
    return `${prefix}-${year}-${String(current_value).padStart(5, '0')}`;
  }

  private async assertDriverVehicle(trx: any, driverId: string, vehicleId: string) {
    if (!UUID_RE.test(driverId)) throw new BadRequestException('driver_id (repartidor) requerido');
    if (!UUID_RE.test(vehicleId)) throw new BadRequestException('vehicle_id (moto) requerido');
    const driver = await trx('logistics.drivers').where({ id: driverId }).whereNull('deleted_at').first();
    if (!driver) throw new NotFoundException(`Repartidor ${driverId} no encontrado`);
    const vehicle = await trx('logistics.vehicles').where({ id: vehicleId }).whereNull('deleted_at').first();
    if (!vehicle) throw new NotFoundException(`Unidad ${vehicleId} no encontrada`);
    return { driver, vehicle };
  }

  private cedisNote(units: number, capacity: number | null): string | null {
    return capacity != null && units > capacity
      ? `REQUIERE CEDIS: ${units} u excede capacidad de la moto (${capacity} u). Reasignar a camión.`
      : null;
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

      const dup = await trx('logistics.guide_recipients').where({ order_id: orderId }).first();
      if (dup) throw new ConflictException('El pedido ya fue despachado (tiene guía)');

      const { vehicle } = await this.assertDriverVehicle(trx, dto.driver_id, dto.vehicle_id);
      const addr = order.delivery_address
        ? (typeof order.delivery_address === 'string' ? JSON.parse(order.delivery_address) : order.delivery_address)
        : null;

      const [{ units }] = await trx('commercial.order_lines').where({ order_id: orderId }).sum('quantity as units');
      const totalUnits = Math.round(Number(units) || 0);
      const capacity = vehicle.capacity_boxes != null ? Number(vehicle.capacity_boxes) : null;
      const requiresCedis = capacity != null && totalUnits > capacity;

      return this.createDelivery(trx, {
        shipment_date: dto.shipment_date,
        vehicle_id: dto.vehicle_id,
        driver_id: dto.driver_id,
        order_id: orderId,
        customer_id: order.customer_id || null,
        customer_name: addr?.recipient_name || order.customer_name || `Pedido ${order.code}`,
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
      const dup = await trx('logistics.guide_recipients')
        .where({ kepler_warehouse_code: warehouseCode, kepler_serie: ticket.serie, kepler_folio: folio })
        .first();
      if (dup) throw new ConflictException('Ese folio ya fue despachado');

      const { vehicle } = await this.assertDriverVehicle(trx, dto.driver_id, dto.vehicle_id);
      const items = typeof ticket.items === 'string' ? JSON.parse(ticket.items) : ticket.items || [];
      const totalUnits = Math.round(items.reduce((s: number, it: any) => s + (Number(it.cant) || 0), 0));
      const capacity = vehicle.capacity_boxes != null ? Number(vehicle.capacity_boxes) : null;
      const total = Number(ticket.total) || 0;

      // COD: explícito o derivado de forma_pago (CONTADO = ya pagado en tienda).
      const alreadyPaid = String(ticket.forma_pago || '').toUpperCase() === 'CONTADO';
      const collect = dto.collect_on_delivery ?? !alreadyPaid;
      const amountToCollect = collect ? (dto.amount_to_collect ?? total) : null;

      return this.createDelivery(trx, {
        shipment_date: dto.shipment_date,
        vehicle_id: dto.vehicle_id,
        driver_id: dto.driver_id,
        order_id: null,
        customer_id: null,
        customer_name: dto.delivery_address.recipient_name || `Ticket ${folio}`,
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

  /** Inserta embarque + guía + parada (comparte los dos flujos). */
  private async createDelivery(
    trx: any,
    p: {
      shipment_date: string;
      vehicle_id: string;
      driver_id: string;
      order_id: string | null;
      customer_id: string | null;
      customer_name: string;
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
    const empFolio = await this.nextFolio(trx, 'EMB');
    const [shipment] = await trx('logistics.shipments')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        folio: empFolio,
        shipment_date: p.shipment_date,
        vehicle_id: p.vehicle_id,
        order_id: p.order_id,
        status: 'programado',
        type: 'entrega',
        destination: p.address?.street || null,
        cargo_value: p.value,
        boxes_count: p.units,
        notes: this.cedisNote(p.units, p.capacity),
      })
      .returning('*');

    const guiaFolio = await this.nextFolio(trx, 'GUIA');
    const [guide] = await trx('logistics.delivery_guides')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        number: guiaFolio,
        shipment_id: shipment.id,
        driver_id: p.driver_id,
        status: 'pendiente',
      })
      .returning('id');

    const [recipient] = await trx('logistics.guide_recipients')
      .insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        guide_id: guide.id,
        customer_id: p.customer_id,
        order_id: p.order_id,
        customer_name: p.customer_name,
        fiscal_address: p.address ? JSON.stringify(p.address) : null,
        value: p.value,
        boxes_count: p.units,
        gps_lat: p.address?.lat ?? null,
        gps_lng: p.address?.lng ?? null,
        sequence_order: 1,
        status: 'pendiente',
        kepler_folio: p.kepler?.folio ?? null,
        kepler_serie: p.kepler?.serie ?? null,
        kepler_warehouse_code: p.kepler?.warehouse_code ?? null,
        items_snapshot: p.kepler ? JSON.stringify(p.kepler.items) : null,
        collect_on_delivery: p.collect_on_delivery,
        amount_to_collect: p.amount_to_collect,
      })
      .returning('id');

    return {
      shipment_id: shipment.id,
      folio: empFolio,
      guide_number: guiaFolio,
      recipient_id: recipient.id,
      total_units: p.units,
      capacity_boxes: p.capacity,
      requires_cedis: requiresCedis,
      collect_on_delivery: p.collect_on_delivery,
      amount_to_collect: p.amount_to_collect,
    };
  }

  /**
   * Fase LM.8 — KPIs de última milla (§13 SOP) en un rango de fechas.
   * Solo paradas a domicilio (folio Kepler o pedido home_delivery). Tiempo de
   * entrega = delivered_at − created_at (ciclo despacho→entrega). El cuadre de
   * efectivo sale de los cortes cerrados (rider_liquidations).
   */
  async kpis(opts: { from?: string; to?: string } = {}) {
    const today = new Date().toISOString().slice(0, 10);
    const from = opts.from || today;
    const to = opts.to || today;

    return this.tk.run(async (trx) => {
      const paradas = await trx('logistics.guide_recipients as r')
        .leftJoin('commercial.orders as o', 'o.id', 'r.order_id')
        .whereRaw('r.created_at::date BETWEEN ? AND ?', [from, to])
        .where((qb: any) => qb.whereNotNull('r.kepler_folio').orWhere('o.delivery_type', 'home_delivery'))
        .select('r.status', 'r.incident_type', 'r.created_at', 'r.delivered_at');

      const total = paradas.length;
      let delivered = 0;
      let incidents = 0;
      let minutesSum = 0;
      let minutesN = 0;
      for (const p of paradas) {
        if (p.status === 'entregado') delivered++;
        if (p.incident_type) incidents++;
        if (p.delivered_at && p.created_at) {
          const mins = (new Date(p.delivered_at).getTime() - new Date(p.created_at).getTime()) / 60000;
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

  /** Paradas a domicilio del repartidor autenticado (resuelve driver por user_id). */
  async myDeliveries(opts: { pending?: boolean } = {}) {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Sin user_id en contexto');

    return this.tk.run(async (trx) => {
      const driver = await trx('logistics.drivers').where({ user_id: userId }).whereNull('deleted_at').first();
      if (!driver) return [];

      let q = trx('logistics.guide_recipients as r')
        .join('logistics.delivery_guides as g', 'g.id', 'r.guide_id')
        .join('logistics.shipments as s', 's.id', 'g.shipment_id')
        .leftJoin('commercial.orders as o', 'o.id', 'r.order_id')
        .where('g.driver_id', driver.id)
        .whereNull('g.deleted_at')
        .whereNull('s.deleted_at');
      if (opts.pending !== false) q = q.whereIn('r.status', ['pendiente', 'no_entregado']);

      return q
        .select(
          'r.id as recipient_id',
          'r.status',
          'r.customer_name',
          'r.fiscal_address as delivery_address',
          'r.gps_lat',
          'r.gps_lng',
          'r.incident_type',
          'r.items_snapshot',
          'r.collect_on_delivery',
          'r.amount_to_collect',
          'r.kepler_folio',
          's.folio as shipment_folio',
          's.id as shipment_id',
          's.notes as shipment_notes',
          'o.id as order_id',
          'o.code as order_code',
          'o.total',
          'o.balance_due',
        )
        .orderBy('s.shipment_date', 'desc');
    });
  }
}
