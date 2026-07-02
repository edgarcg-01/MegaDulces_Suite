import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantKnexService, TenantContextService } from '@megadulces/platform-core';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DispatchHomeDeliveryDto {
  /** Repartidor (logistics.drivers.id) — moto rider. */
  driver_id: string;
  /** Unidad (logistics.vehicles.id) — la moto. */
  vehicle_id: string;
  /** Fecha del embarque (YYYY-MM-DD). Default: la del pedido / hoy no disponible → requerido. */
  shipment_date: string;
}

/**
 * Fase LM.3 — despacho de un pedido a domicilio a un repartidor en moto.
 *
 * Crea el embarque + guía (con el rider) + destinatario tomando la dirección de
 * `commercial.orders.delivery_address` (ad-hoc, sirve para clientes casuales sin
 * cartera). Regla de OVERFLOW: si las unidades del pedido exceden la capacidad de
 * la moto → marca `requires_cedis` (aviso al encargado; MVP no auto-splitea, el
 * encargado decide reasignar a camión). El check-in/salida y el retorno reusan
 * los endpoints existentes de flota (`/fleet/usage/check-in`) y embarques
 * (`/shipments/:id/depart`). Logística lee commercial.orders a nivel SQL (no
 * importa el módulo commercial), consistente con el routing existente.
 */
@Injectable()
export class LogisticsHomeDispatchService {
  private readonly logger = new Logger(LogisticsHomeDispatchService.name);

  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * Paradas a domicilio del repartidor autenticado (resuelve driver por user_id).
   * Un solo fetch para la app: parada + pedido + dirección + estado. `pending`=true
   * (default) devuelve solo lo no cerrado.
   */
  async myDeliveries(opts: { pending?: boolean } = {}) {
    const userId = this.tenantCtx.get()?.userId;
    if (!userId) throw new BadRequestException('Sin user_id en contexto');

    return this.tk.run(async (trx) => {
      const driver = await trx('logistics.drivers')
        .where({ user_id: userId })
        .whereNull('deleted_at')
        .first();
      if (!driver) return []; // user sin driver → lista vacía (no error)

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
          's.folio as shipment_folio',
          's.id as shipment_id',
          's.notes as shipment_notes', // trae el aviso CEDIS si aplica
          'o.id as order_id',
          'o.code as order_code',
          'o.total',
          'o.balance_due',
          'o.payment_method',
        )
        .orderBy('s.shipment_date', 'desc');
    });
  }

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

  async dispatch(orderId: string, dto: DispatchHomeDeliveryDto) {
    if (!UUID_RE.test(orderId)) throw new BadRequestException('orderId inválido');
    if (!UUID_RE.test(dto?.driver_id || '')) throw new BadRequestException('driver_id (repartidor) requerido');
    if (!UUID_RE.test(dto?.vehicle_id || '')) throw new BadRequestException('vehicle_id (moto) requerido');
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
        throw new ConflictException(`El pedido debe estar confirmado para despacharse (status=${order.status})`);

      // Evita doble despacho: ¿ya existe un destinatario ligado a esta orden?
      const alreadyDispatched = await trx('logistics.guide_recipients')
        .where({ order_id: orderId })
        .first();
      if (alreadyDispatched)
        throw new ConflictException('El pedido ya fue despachado (tiene guía)');

      const driver = await trx('logistics.drivers').where({ id: dto.driver_id }).whereNull('deleted_at').first();
      if (!driver) throw new NotFoundException(`Repartidor ${dto.driver_id} no encontrado`);
      const vehicle = await trx('logistics.vehicles').where({ id: dto.vehicle_id }).whereNull('deleted_at').first();
      if (!vehicle) throw new NotFoundException(`Unidad ${dto.vehicle_id} no encontrada`);

      const addr = order.delivery_address
        ? (typeof order.delivery_address === 'string' ? JSON.parse(order.delivery_address) : order.delivery_address)
        : null;

      // Unidades del pedido → capacidad de la moto (overflow → CEDIS).
      const [{ units }] = await trx('commercial.order_lines')
        .where({ order_id: orderId })
        .sum('quantity as units');
      const totalUnits = Math.round(Number(units) || 0);
      const capacity = vehicle.capacity_boxes != null ? Number(vehicle.capacity_boxes) : null;
      const overCapacity = capacity != null && totalUnits > capacity;
      const requiresCedis = overCapacity;

      const empFolio = await this.nextFolio(trx, 'EMB');
      const cedisNote = requiresCedis
        ? `REQUIERE CEDIS: ${totalUnits} u excede capacidad de la moto (${capacity} u). Reasignar a camión.`
        : null;
      const [shipment] = await trx('logistics.shipments')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          folio: empFolio,
          shipment_date: dto.shipment_date,
          vehicle_id: dto.vehicle_id,
          order_id: orderId,
          status: 'programado',
          type: 'entrega',
          destination: addr?.street || null,
          cargo_value: Number(order.total) || 0,
          boxes_count: totalUnits,
          notes: cedisNote,
        })
        .returning('*');

      const guiaFolio = await this.nextFolio(trx, 'GUIA');
      const [guide] = await trx('logistics.delivery_guides')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          number: guiaFolio,
          shipment_id: shipment.id,
          driver_id: dto.driver_id,
          status: 'pendiente',
        })
        .returning('id');

      const [recipient] = await trx('logistics.guide_recipients')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          guide_id: guide.id,
          customer_id: order.customer_id || null,
          order_id: orderId,
          customer_name: addr?.recipient_name || order.customer_name || `Pedido ${order.code}`,
          fiscal_address: addr ? JSON.stringify(addr) : null,
          value: Number(order.total) || 0,
          boxes_count: totalUnits,
          gps_lat: addr?.lat ?? null,
          gps_lng: addr?.lng ?? null,
          sequence_order: 1,
          status: 'pendiente',
        })
        .returning('id');

      return {
        shipment_id: shipment.id,
        folio: empFolio,
        guide_number: guiaFolio,
        recipient_id: recipient.id,
        driver_id: dto.driver_id,
        vehicle_id: dto.vehicle_id,
        total_units: totalUnits,
        capacity_boxes: capacity,
        over_capacity: overCapacity,
        requires_cedis: requiresCedis,
      };
    });
  }
}
