import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Knex } from 'knex';
import { TenantContextService, TenantKnexService } from '@megadulces/platform-core';
import type { MotivoNoMedible, RevisionGps, ViajeCapturado } from '@megadulces/contracts';
import {
  compararConGps, horaNormal, MOTIVO_NO_MEDIBLE, tarifasDeViatico, TOLERANCIA_KM, TOLERANCIA_MINUTOS,
} from '@megadulces/contracts';
import { PuntoGps, reconstruirViaje, VENTANA_HORAS } from './gps-viaje.logic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EmbarqueRow {
  id: string;
  shipment_date: string;
  vehicle_id: string | null;
  kepler_sucursal: string | null;
  kepler_guia: string | null;
  actual_km: number | string | null;
}

interface GuiaRow {
  driver_id: string | null;
  helper1_id: string | null;
  helper2_id: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  overnight: boolean;
  per_diem_total: number | string | null;
}

interface PosicionRow {
  captured_at: Date;
  lat: number | string;
  lng: number | string;
  odometer: number | string | null;
}

/**
 * EMB.21 — Revisión con GPS de lo capturado en la guía (horario, kilómetros y los viáticos que de
 * ahí salen). Se calcula al abrir el embarque: son dos consultas por índice de ~20 ms en prod
 * (medido 2026-10-08), así que no hace falta guardarla ni agendarla.
 */
@Injectable()
export class ShipmentGpsReviewService {
  constructor(
    private readonly tk: TenantKnexService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async review(shipmentId: string, ahora: Date = new Date()): Promise<RevisionGps> {
    if (!UUID_REGEX.test(shipmentId)) throw new BadRequestException('id inválido');
    const tenantId = this.tenantCtx.requireTenantId();
    return this.tk.run(async (trx: Knex.Transaction) => {
      const s: EmbarqueRow | undefined = await trx('logistics.shipments')
        .where({ id: shipmentId }).whereNull('deleted_at')
        .first('id', trx.raw(`to_char(shipment_date, 'YYYY-MM-DD') AS shipment_date`), 'vehicle_id', 'kepler_sucursal', 'kepler_guia', 'actual_km');
      if (!s) throw new NotFoundException(`Embarque ${shipmentId} no encontrado`);

      const guia: GuiaRow | undefined = await trx('logistics.delivery_guides')
        .where({ shipment_id: shipmentId }).whereNull('deleted_at').whereNot('status', 'cancelada')
        .orderBy('created_at', 'asc')
        .first('driver_id', 'helper1_id', 'helper2_id', 'departure_time', 'arrival_time', 'overnight', 'per_diem_total');
      if (!guia) return noMedible('sin_guia', null);

      const capturado: ViajeCapturado = {
        salida: horaNormal(guia.departure_time),
        llegada: horaNormal(guia.arrival_time),
        duerme_fuera: !!guia.overnight,
        km: s.actual_km == null ? null : Number(s.actual_km),
        viaticos: guia.per_diem_total == null ? null : Number(guia.per_diem_total),
      };
      if (!s.kepler_sucursal || !s.kepler_guia) return noMedible('embarque_manual', capturado);
      if (!s.vehicle_id) return noMedible('sin_unidad', capturado);

      const rastreador = await trx('logistics.trackers')
        .where({ vehicle_id: s.vehicle_id }).whereNull('deleted_at').first('id');
      if (!rastreador) return noMedible('sin_gps', capturado);

      const origen = await trx('commercial.warehouses')
        .where({ code: s.kepler_sucursal }).whereNull('deleted_at')
        .whereNotNull('latitude').whereNotNull('longitude')
        .first('latitude', 'longitude');
      if (!origen) return noMedible('origen_sin_coordenadas', capturado);

      // La unidad sale DESPUÉS de cargar: la ventana arranca a la hora en que Kepler capturó el
      // embarque (la primera parada de la guía). Sin esa hora, desde el inicio del día.
      const cap = await trx('analytics.erp_shipment_stops')
        .where({ sucursal: s.kepler_sucursal, guia_embarque: s.kepler_guia })
        .min({ hora: 'hora_captura' }).first();
      const desde = new Date(`${s.shipment_date}T${horaNormal(cap?.hora) ?? '00:00'}:00-06:00`);
      const hasta = new Date(desde.getTime() + VENTANA_HORAS * 3600_000);

      // `vehicle_positions` no tiene RLS (patrón route_location_pings): el tenant va explícito.
      const filas: PosicionRow[] = await trx('logistics.vehicle_positions')
        .where({ tenant_id: tenantId, vehicle_id: s.vehicle_id })
        .where('captured_at', '>=', desde).where('captured_at', '<', hasta)
        .orderBy('captured_at', 'asc')
        .select('captured_at', 'lat', 'lng', 'odometer');
      const puntos: PuntoGps[] = filas.map((p) => ({
        en: new Date(p.captured_at), lat: Number(p.lat), lng: Number(p.lng),
        odometro: p.odometer == null ? null : Number(p.odometer),
      }));

      const r = reconstruirViaje(puntos, { lat: Number(origen.latitude), lng: Number(origen.longitude) }, desde, ahora);
      if (!r.ok) return noMedible(r.motivo, capturado);

      const tarifas = tarifasDeViatico(await trx('logistics.config_finance')
        .where({ category: 'viatico', active: true }).select('key', 'value'));
      const va = { driver: !!guia.driver_id, helper1: !!guia.helper1_id, helper2: !!guia.helper2_id };

      // Sin horario capturado (guías de antes de EMB.19) no hay contra qué comparar: se muestra lo
      // que dice el GPS y se declara.
      if (!capturado.salida || !capturado.llegada) {
        return {
          estado: 'no_medible',
          motivo: 'La guía no tiene horario capturado: se muestra sólo lo que marca el GPS.',
          capturado,
          gps: { ...r.viaje, viaticos: null },
          diferencias: [],
          tolerancias: TOLERANCIAS,
        };
      }
      const c = compararConGps(capturado, r.viaje, tarifas, va);
      return {
        estado: c.estado,
        motivo: null,
        capturado,
        gps: { ...r.viaje, viaticos: c.viaticos_gps },
        diferencias: c.diferencias,
        tolerancias: TOLERANCIAS,
      };
    });
  }
}

const TOLERANCIAS = { minutos: TOLERANCIA_MINUTOS, km: TOLERANCIA_KM };

function noMedible(motivo: MotivoNoMedible, capturado: ViajeCapturado | null): RevisionGps {
  return {
    estado: motivo === 'en_curso' ? 'en_curso' : 'no_medible',
    motivo: MOTIVO_NO_MEDIBLE[motivo],
    capturado,
    gps: null,
    diferencias: [],
    tolerancias: TOLERANCIAS,
  };
}
