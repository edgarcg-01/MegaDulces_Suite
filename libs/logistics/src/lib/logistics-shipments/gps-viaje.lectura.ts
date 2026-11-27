/**
 * `[CML.H]` Lee del GPS el viaje de UNA guía de Kepler: la unidad, su rastreador, las coordenadas
 * de la sucursal de salida y las posiciones de la ventana, y se las pasa a `reconstruirViaje`
 * (EMB.21, la misma regla de la revisión de embarques). Sólo lee.
 *
 * Medido en prod el 2026-11-23 sobre las 448 guías de la catorcena 5→18 nov: 118 se reconstruyen
 * (26 %); 178 van en una unidad sin GPS, 43 salen de la 00 (sin coordenadas), 62 nunca pasan por su
 * sucursal y 42 no regresan o no tienen puntos. Por eso el resultado sólo PRECARGA y se declara.
 *
 * Deuda con nombre: `ShipmentGpsReviewService.review` todavía arma esta misma lectura por su cuenta
 * (por embarque de la Suite); debe pasar a usar ésta.
 */
import type { Knex } from 'knex';
import type { GuiaDelMismoViaje, ViajeGps } from '@megadulces/contracts';
import { horaNormal } from '@megadulces/contracts';
import { capturadaMientrasFuera, desvioPorLaHoja, mismoViajeFisico, PuntoGps, ventanaDeLaHoja, reconstruirViaje, ResultadoGps, VENTANA_HORAS } from './gps-viaje.logic';

export interface GuiaParaGps {
  /** Sucursal de Kepler de dos dígitos: de ahí sale la unidad. */
  sucursal: string;
  /** Fecha de la guía, `YYYY-MM-DD`. */
  fecha: string;
  /** Hora en que Kepler capturó la guía: la unidad sale después de cargar. */
  hora: string | null;
  vehicleId: string | null;
}

interface PosicionRow {
  captured_at: Date | string;
  lat: number | string;
  lng: number | string;
  odometer: number | string | null;
}

export async function leerViajeGps(trx: Knex | Knex.Transaction, g: GuiaParaGps, ahora: Date): Promise<ResultadoGps> {
  if (!g.vehicleId) return { ok: false, motivo: 'sin_unidad' };
  const rastreador = await trx('logistics.trackers').where({ vehicle_id: g.vehicleId }).whereNull('deleted_at').first('id');
  if (!rastreador) return { ok: false, motivo: 'sin_gps' };
  const origen = await trx('commercial.warehouses')
    .where({ code: g.sucursal }).whereNull('deleted_at')
    .whereNotNull('latitude').whereNotNull('longitude')
    .first('latitude', 'longitude');
  if (!origen) return { ok: false, motivo: 'origen_sin_coordenadas' };

  const desde = new Date(`${g.fecha}T${horaNormal(g.hora) ?? '00:00'}:00-06:00`);
  if (Number.isNaN(desde.getTime())) return { ok: false, motivo: 'sin_puntos' };
  const hasta = new Date(desde.getTime() + VENTANA_HORAS * 3600_000);
  // `vehicle_positions` no tiene RLS (patrón route_location_pings): el tenant va explícito.
  const filas: PosicionRow[] = await trx('logistics.vehicle_positions')
    .whereRaw('tenant_id = public.current_tenant_id()')
    .where({ vehicle_id: g.vehicleId })
    .where('captured_at', '>=', desde).where('captured_at', '<', hasta)
    .orderBy('captured_at', 'asc')
    .select('captured_at', 'lat', 'lng', 'odometer');
  const puntos: PuntoGps[] = filas.map((p) => ({
    en: new Date(p.captured_at), lat: Number(p.lat), lng: Number(p.lng),
    odometro: p.odometer == null ? null : Number(p.odometer),
  }));
  return reconstruirViaje(puntos, { lat: Number(origen.latitude), lng: Number(origen.longitude) }, desde, ahora);
}

/** Días alrededor de la guía en que se buscan otras guías de la misma unidad (lo cargado en la tarde sale al día siguiente). */
export const DIAS_MISMO_VIAJE = 2;

/**
 * `[CML.J]` Las OTRAS guías de Kepler que salieron en el mismo viaje físico que `propia`: la misma
 * unidad, con la misma salida según su GPS. Sólo lee; cada guía se reconstruye con `leerViajeGps`.
 */
export async function leerMismoViaje(
  trx: Knex | Knex.Transaction,
  propia: { sucursal: string; guia: string; fecha: string; vehicleId: string | null },
  viaje: ViajeGps,
  ahora: Date,
): Promise<GuiaDelMismoViaje[]> {
  if (!propia.vehicleId || !viaje.dia_salida) return [];
  const otras: Array<{ sucursal: string; guia: string; fecha: string }> = await trx('analytics.erp_shipment_trips')
    .whereRaw('tenant_id = public.current_tenant_id()')
    .where({ vehicle_id: propia.vehicleId })
    .whereRaw(`fecha BETWEEN ?::date - ${DIAS_MISMO_VIAJE} AND ?::date + ${DIAS_MISMO_VIAJE}`, [propia.fecha, propia.fecha])
    .whereNot((q) => q.where({ sucursal: propia.sucursal, guia_embarque: propia.guia }))
    .orderBy([{ column: 'fecha' }, { column: 'guia_embarque' }])
    .select('sucursal', trx.raw('guia_embarque AS guia'), trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`));
  if (!otras.length) return [];
  const paradas: Array<{ sucursal: string; guia_embarque: string; hora_captura: string | null }> = await trx('analytics.erp_shipment_stops')
    .whereIn(['sucursal', 'guia_embarque'], otras.map((o) => [o.sucursal, o.guia]))
    .select('sucursal', 'guia_embarque', 'hora_captura');
  const horaDe = new Map<string, string>();
  for (const p of paradas) {
    const h = horaNormal(p.hora_captura);
    const k = `${p.sucursal}|${p.guia_embarque}`;
    if (h && (!horaDe.has(k) || h < (horaDe.get(k) as string))) horaDe.set(k, h);
  }
  const mismas: GuiaDelMismoViaje[] = [];
  for (const o of otras) {
    const r = await leerViajeGps(trx, { sucursal: o.sucursal, fecha: o.fecha, hora: horaDe.get(`${o.sucursal}|${o.guia}`) ?? null, vehicleId: propia.vehicleId }, ahora);
    if (r.ok && mismoViajeFisico(viaje, r.viaje)) mismas.push({ sucursal: o.sucursal, guia: o.guia, fecha: o.fecha });
  }
  return mismas;
}

/**
 * `[CML.J]` D17 caso 3 — sin GPS: las otras guías de la MISMA unidad que Kepler capturó mientras el
 * camión estaba fuera según la hoja de viaje (`capturadaMientrasFuera`). Mismo universo que el de
 * GPS (misma unidad, ±2 días); la hora de cada guía es su primera captura en Kepler.
 */
export async function leerMismoViajePorHoja(
  trx: Knex | Knex.Transaction,
  propia: { sucursal: string; guia: string; fecha: string; vehicleId: string | null; hora_captura: string | null },
  hoja: { salida: string | null; llegada: string | null; duerme_fuera: boolean },
): Promise<{ sugeridas: GuiaDelMismoViaje[]; omitidas: number }> {
  const ventana = ventanaDeLaHoja({ fecha: propia.fecha, hora_captura: propia.hora_captura }, hoja);
  if (!propia.vehicleId || !ventana) return { sugeridas: [], omitidas: 0 };
  const otras: Array<{ sucursal: string; guia: string; fecha: string }> = await trx('analytics.erp_shipment_trips')
    .whereRaw('tenant_id = public.current_tenant_id()')
    .where({ vehicle_id: propia.vehicleId })
    .whereRaw(`fecha BETWEEN ?::date - ${DIAS_MISMO_VIAJE} AND ?::date + ${DIAS_MISMO_VIAJE}`, [propia.fecha, propia.fecha])
    .whereNot((q) => q.where({ sucursal: propia.sucursal, guia_embarque: propia.guia }))
    .orderBy([{ column: 'fecha' }, { column: 'guia_embarque' }])
    .select('sucursal', trx.raw('guia_embarque AS guia'), trx.raw(`to_char(fecha, 'YYYY-MM-DD') AS fecha`));
  if (!otras.length) return { sugeridas: [], omitidas: 0 };
  const paradas: Array<{ sucursal: string; guia_embarque: string; hora_captura: string | null }> = await trx('analytics.erp_shipment_stops')
    .whereIn(['sucursal', 'guia_embarque'], otras.map((o) => [o.sucursal, o.guia]))
    .select('sucursal', 'guia_embarque', 'hora_captura');
  const horaDe = new Map<string, string>();
  for (const p of paradas) {
    const h = horaNormal(p.hora_captura);
    const k = `${p.sucursal}|${p.guia_embarque}`;
    if (h && (!horaDe.has(k) || h < (horaDe.get(k) as string))) horaDe.set(k, h);
  }
  const fuera = otras
    .map((o) => ({ ...o, hora_captura: horaDe.get(`${o.sucursal}|${o.guia}`) ?? null }))
    .filter((o) => capturadaMientrasFuera(ventana, o))
    .map((o) => ({ sucursal: o.sucursal, guia: o.guia, fecha: o.fecha, por: 'hoja' as const, hora_captura: o.hora_captura }));
  // [CML.J2] Dos o más guías en ese rato = unidad compartida: no se sugiere ninguna, se dice cuántas.
  return desvioPorLaHoja(fuera);
}
