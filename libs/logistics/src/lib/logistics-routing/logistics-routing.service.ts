import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantKnexService } from '@megadulces/platform-core';
import { solveOpenRoute, GeoPoint } from './route-solver';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OptimizeDto {
  origin: { lat: number; lng: number };
  stops: GeoPoint[];
}

@Injectable()
export class LogisticsRoutingService {
  constructor(private readonly tk: TenantKnexService) {}

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

      const result = solveOpenRoute(origin, stops);

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

      return { ...result, located: stops.length, unlocated, origin_from: wh?.latitude != null ? 'warehouse' : 'centroid' };
    });
  }
}
