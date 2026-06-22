import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { solveOpenRoute, GeoPoint, haversineKm } from './route-solver';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OptimizeDto {
  origin: { lat: number; lng: number };
  stops: GeoPoint[];
}

export interface BuildShipmentDto {
  vehicle_id: string;
  order_ids: string[];
  shipment_date: string;
  driver_id?: string;
  origin?: string;
  destination?: string;
}

@Injectable()
export class LogisticsRoutingService {
  constructor(private readonly tk: TenantKnexService) {}

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

  /**
   * J12.3 — Arma el reparto del día: toma pedidos pendientes, crea un embarque
   * (programado) + una guía + un destinatario por pedido (ligado a la orden,
   * domicilio fiscal auto), optimiza la secuencia y reporta capacidad estimada.
   * Todo atómico en una transacción.
   */
  async buildShipmentFromOrders(dto: BuildShipmentDto) {
    if (!UUID_REGEX.test(dto?.vehicle_id || '')) throw new BadRequestException('vehicle_id requerido');
    if (!Array.isArray(dto?.order_ids) || !dto.order_ids.length) throw new BadRequestException('order_ids requerido');
    if (!dto?.shipment_date) throw new BadRequestException('shipment_date requerido');
    if (dto.driver_id && !UUID_REGEX.test(dto.driver_id)) throw new BadRequestException('driver_id inválido');

    return this.tk.run(async (trx) => {
      const vehicle = await trx('logistics.vehicles')
        .where({ id: dto.vehicle_id }).whereNull('deleted_at').first();
      if (!vehicle) throw new NotFoundException(`Unidad ${dto.vehicle_id} no encontrada`);
      if (dto.driver_id) {
        const d = await trx('logistics.drivers').where({ id: dto.driver_id }).whereNull('deleted_at').first();
        if (!d) throw new NotFoundException(`Chofer ${dto.driver_id} no encontrado`);
      }

      const orders = await trx('commercial.orders as o')
        .leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
        .whereIn('o.id', dto.order_ids)
        .whereNot('o.status', 'cancelado')
        .whereNull('o.deleted_at')
        .select('o.id', 'o.code', 'o.total', 'o.customer_id',
          'c.name as customer_name', 'c.billing_address', 'c.latitude', 'c.longitude');
      if (!orders.length) throw new NotFoundException('Ninguna orden válida en order_ids');

      // Unidades estimadas por orden (sum order_lines.quantity) para capacidad suave.
      const lineAgg = await trx('commercial.order_lines')
        .whereIn('order_id', orders.map((o: any) => o.id))
        .groupBy('order_id')
        .select('order_id')
        .sum('quantity as units');
      const unitsByOrder = new Map<string, number>(lineAgg.map((r: any) => [r.order_id, Math.round(Number(r.units) || 0)]));
      const totalUnits = orders.reduce((s: number, o: any) => s + (unitsByOrder.get(o.id) || 0), 0);
      const overCapacity = vehicle.capacity_boxes != null && totalUnits > Number(vehicle.capacity_boxes);

      const empFolio = await this.nextFolio(trx, 'EMB');
      const [shipment] = await trx('logistics.shipments').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        folio: empFolio, shipment_date: dto.shipment_date, vehicle_id: dto.vehicle_id,
        status: 'programado', type: 'entrega',
        origin: dto.origin || null, destination: dto.destination || null,
        boxes_count: totalUnits,
      }).returning('*');

      const guiaFolio = await this.nextFolio(trx, 'GUIA');
      const [guide] = await trx('logistics.delivery_guides').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        number: guiaFolio, shipment_id: shipment.id, driver_id: dto.driver_id || null, status: 'pendiente',
      }).returning('id');

      const stops: GeoPoint[] = [];
      for (const o of orders) {
        const fiscal = o.billing_address
          ? (typeof o.billing_address === 'string' ? JSON.parse(o.billing_address) : o.billing_address)
          : null;
        const [rec] = await trx('logistics.guide_recipients').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          guide_id: guide.id, customer_id: o.customer_id || null, order_id: o.id,
          customer_name: o.customer_name || `Pedido ${o.code}`,
          fiscal_address: fiscal ? JSON.stringify(fiscal) : null,
          value: Number(o.total) || 0, boxes_count: unitsByOrder.get(o.id) || 0,
          status: 'pendiente',
        }).returning('id');
        if (o.latitude != null && o.longitude != null) {
          stops.push({ id: rec.id, lat: Number(o.latitude), lng: Number(o.longitude) });
        }
      }

      // Optimizar secuencia (si hay paradas localizables).
      let optimized_km = 0;
      if (stops.length) {
        const wh = await trx('commercial.warehouses').where({ is_default: true }).whereNull('deleted_at').first();
        const origin = wh?.latitude != null && wh?.longitude != null
          ? { lat: Number(wh.latitude), lng: Number(wh.longitude) }
          : { lat: stops.reduce((s, p) => s + p.lat, 0) / stops.length, lng: stops.reduce((s, p) => s + p.lng, 0) / stops.length };
        const result = solveOpenRoute(origin, stops);
        optimized_km = result.total_km;
        let seq = 1;
        for (const id of result.order) {
          await trx('logistics.guide_recipients').where({ id }).update({ sequence_order: seq++, updated_at: trx.fn.now() });
        }
      }

      return {
        shipment_id: shipment.id, folio: shipment.folio, guide_number: guiaFolio,
        recipients: orders.length, located: stops.length, unlocated: orders.length - stops.length,
        total_units: totalUnits, capacity_boxes: vehicle.capacity_boxes != null ? Number(vehicle.capacity_boxes) : null,
        over_capacity: overCapacity, optimized_km,
      };
    });
  }

  /** Stateless: ordena paradas sin tocar la DB (para el planner). */
  optimize(dto: OptimizeDto) {
    if (!dto?.origin || !Number.isFinite(dto.origin.lat) || !Number.isFinite(dto.origin.lng)) {
      throw new BadRequestException('origin {lat,lng} requerido');
    }
    if (!Array.isArray(dto.stops) || !dto.stops.length) {
      throw new BadRequestException('stops requerido');
    }
    return solveOpenRoute(dto.origin, dto.stops);
  }

  /**
   * Plan de ruta de un embarque para el mapa: origen (almacén) + destinatarios
   * con coords ordenados por `sequence_order`. No recalcula (lee lo persistido).
   */
  async shipmentPlan(shipmentId: string) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments').where({ id: shipmentId }).whereNull('deleted_at').first();
      if (!shipment) throw new NotFoundException(`Embarque ${shipmentId} no encontrado`);

      const wh = await trx('commercial.warehouses').where({ is_default: true }).whereNull('deleted_at').first();
      const guideIds = (
        await trx('logistics.delivery_guides').where({ shipment_id: shipmentId }).whereNull('deleted_at').select('id')
      ).map((g: any) => g.id);

      const recipients = guideIds.length
        ? await trx('logistics.guide_recipients as r')
            .leftJoin('commercial.customers as c', 'c.id', 'r.customer_id')
            .whereIn('r.guide_id', guideIds)
            .select('r.id', 'r.customer_name', 'r.status', 'r.sequence_order', 'c.latitude', 'c.longitude')
        : [];

      const located = recipients
        .filter((r: any) => r.latitude != null && r.longitude != null)
        .map((r: any) => ({
          recipient_id: r.id, customer_name: r.customer_name, status: r.status,
          sequence_order: r.sequence_order, lat: Number(r.latitude), lng: Number(r.longitude),
        }))
        .sort((a, b) => (a.sequence_order ?? 9999) - (b.sequence_order ?? 9999));

      const origin = wh?.latitude != null && wh?.longitude != null
        ? { lat: Number(wh.latitude), lng: Number(wh.longitude), name: wh.name }
        : null;

      return {
        folio: shipment.folio,
        origin,
        optimized: located.some((s) => s.sequence_order != null),
        stops: located,
        unlocated: recipients.length - located.length,
      };
    });
  }

  /**
   * Optimiza el reparto de un embarque: toma los destinatarios de sus guías,
   * resuelve coords vía commercial.customers (lat/lng), corre el solver y
   * persiste `sequence_order` en cada destinatario localizable.
   */
  async optimizeShipment(shipmentId: string) {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('shipmentId inválido');
    return this.tk.run(async (trx) => {
      const shipment = await trx('logistics.shipments').where({ id: shipmentId }).whereNull('deleted_at').first();
      if (!shipment) throw new NotFoundException(`Embarque ${shipmentId} no encontrado`);

      // Origen: almacén default con coords; fallback al centroide de paradas.
      const wh = await trx('commercial.warehouses')
        .where({ is_default: true }).whereNull('deleted_at').first();

      const guideIds = (
        await trx('logistics.delivery_guides').where({ shipment_id: shipmentId }).whereNull('deleted_at').select('id')
      ).map((g: any) => g.id);
      if (!guideIds.length) return { order: [], total_km: 0, located: 0, unlocated: 0 };

      const recipients = await trx('logistics.guide_recipients as r')
        .leftJoin('commercial.customers as c', 'c.id', 'r.customer_id')
        .whereIn('r.guide_id', guideIds)
        .orderBy('r.created_at', 'asc') // orden de captura = baseline sin optimizar
        .select('r.id', 'r.customer_name', 'c.latitude', 'c.longitude');

      const stops: GeoPoint[] = recipients
        .filter((r: any) => r.latitude != null && r.longitude != null)
        .map((r: any) => ({ id: r.id, lat: Number(r.latitude), lng: Number(r.longitude) }));
      const unlocated = recipients.length - stops.length;
      if (!stops.length) return { order: [], total_km: 0, located: 0, unlocated };

      const origin =
        wh?.latitude != null && wh?.longitude != null
          ? { lat: Number(wh.latitude), lng: Number(wh.longitude) }
          : { lat: stops.reduce((s, p) => s + p.lat, 0) / stops.length, lng: stops.reduce((s, p) => s + p.lng, 0) / stops.length };

      // Baseline: distancia en orden de captura (sin optimizar).
      let naiveKm = 0;
      let prev = origin;
      for (const s of stops) { naiveKm += haversineKm(prev, s); prev = s; }
      naiveKm = Math.round(naiveKm * 100) / 100;

      const result = solveOpenRoute(origin, stops);
      const savedKm = Math.round(Math.max(0, naiveKm - result.total_km) * 100) / 100;
      await trx('logistics.route_optimizations').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        shipment_id: shipmentId, naive_km: naiveKm, optimized_km: result.total_km,
        saved_km: savedKm, stops: stops.length,
      });

      // Persistir sequence_order (1..N) y limpiar el de los no localizables.
      let seq = 1;
      for (const id of result.order) {
        await trx('logistics.guide_recipients').where({ id }).update({ sequence_order: seq++, updated_at: trx.fn.now() });
      }
      const locatedIds = new Set(result.order);
      await trx('logistics.guide_recipients')
        .whereIn('id', recipients.map((r: any) => r.id))
        .whereNotIn('id', [...locatedIds])
        .update({ sequence_order: null });

      return { ...result, naive_km: naiveKm, saved_km: savedKm, located: stops.length, unlocated, origin_from: wh?.latitude != null ? 'warehouse' : 'centroid' };
    });
  }
}
