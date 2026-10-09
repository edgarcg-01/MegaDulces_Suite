/**
 * EMB.21 — El viaje reconstruido con el GPS de la flota: cuándo salió la unidad de su sucursal,
 * cuándo regresó y cuántos kilómetros hizo. Sirve para REVISAR lo capturado en la guía, no para
 * reemplazarlo (`compararConGps` en el contrato).
 *
 * Medido en prod el 2026-10-08 sobre viajes reales de las sucursales 01, 06 y 08:
 *   · con una ventana de 48 h desde que Kepler capturó el embarque, 29 de 42 viajes con rastreador
 *     se reconstruyen completos; los demás no regresan en ese plazo o traen el odómetro roto;
 *   · el odómetro (`vehicle_positions.odometer`) va en KILÓMETROS y casi siempre queda entre 1.0 y
 *     1.3 veces el trazo del GPS (el trazo une puntos cada tantos segundos y se come las curvas);
 *   · pero en 9 de 34 viajes el odómetro es basura: negativo (se reinició) o de 37 a 133 veces el
 *     trazo. Ahí se usa el trazo y se DECLARA el método.
 */
import type { MotivoNoMedible, ViajeGps } from '@megadulces/contracts';
import { haversineKm } from '../logistics-routing/route-solver';

/** A más de esto de la sucursal, la unidad ya salió. */
export const RADIO_SALIDA_M = 800;
/** A menos de esto, la unidad ya regresó (más chico que el de salida para no rebotar en la orilla). */
export const RADIO_REGRESO_M = 400;
/** Cuánto se espera el regreso desde que se cargó. */
export const VENTANA_HORAS = 48;
/** El odómetro se cree si queda entre estas veces el trazo del GPS. */
export const ODOMETRO_CREIBLE = { min: 0.9, max: 2 } as const;

export interface PuntoGps {
  en: Date;
  lat: number;
  lng: number;
  odometro: number | null;
}

export type ResultadoGps =
  | { ok: true; viaje: ViajeGps }
  | { ok: false; motivo: MotivoNoMedible };

const HORA_MX = new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Mexico_City', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const DIA_MX = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });

/** `HH:MM` en hora de México. */
export function horaMx(d: Date): string {
  return HORA_MX.format(d);
}

/** `YYYY-MM-DD` en hora de México. */
export function diaMx(d: Date): string {
  return DIA_MX.format(d);
}

/**
 * El viaje que empieza después de `desde` (la hora en que Kepler capturó el embarque: la unidad
 * sale después de cargar). Los puntos van ordenados por fecha y cubren la ventana de 48 h.
 */
export function reconstruirViaje(
  puntos: PuntoGps[],
  origen: { lat: number; lng: number },
  desde: Date,
  ahora: Date,
): ResultadoGps {
  if (!puntos.length) return { ok: false, motivo: 'sin_puntos' };
  const conDistancia = puntos.map((p) => ({ ...p, m: haversineKm(origen, p) * 1000 }));
  if (!conDistancia.some((p) => p.m <= RADIO_REGRESO_M)) return { ok: false, motivo: 'nunca_en_origen' };

  const iSalida = conDistancia.findIndex((p) => p.en >= desde && p.m > RADIO_SALIDA_M);
  if (iSalida < 0) return { ok: false, motivo: 'no_sale' };
  const iLlegada = conDistancia.findIndex((p, i) => i > iSalida && p.m <= RADIO_REGRESO_M);
  if (iLlegada < 0) {
    const fin = new Date(desde.getTime() + VENTANA_HORAS * 3600_000);
    return { ok: false, motivo: fin > ahora ? 'en_curso' : 'no_regresa' };
  }

  const salida = conDistancia[iSalida];
  const llegada = conDistancia[iLlegada];
  let trazo = 0;
  for (let i = iSalida + 1; i <= iLlegada; i++) trazo += haversineKm(conDistancia[i - 1], conDistancia[i]);
  const odometro = salida.odometro != null && llegada.odometro != null ? llegada.odometro - salida.odometro : null;
  const creible = odometro != null && odometro > 0 && trazo > 0
    && odometro / trazo >= ODOMETRO_CREIBLE.min && odometro / trazo <= ODOMETRO_CREIBLE.max;
  const km = creible ? Math.round(odometro) : trazo > 0 ? Math.round(trazo) : null;

  return {
    ok: true,
    viaje: {
      salida: horaMx(salida.en),
      llegada: horaMx(llegada.en),
      duerme_fuera: diaMx(llegada.en) > diaMx(salida.en),
      km,
      km_metodo: km == null ? null : creible ? 'odometro' : 'trazo',
      puntos: iLlegada - iSalida + 1,
    },
  };
}
