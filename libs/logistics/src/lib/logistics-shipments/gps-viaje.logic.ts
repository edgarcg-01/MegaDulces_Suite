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
      dia_salida: diaMx(salida.en),
    },
  };
}

/**
 * `[CML.J]` ¿Dos guías salieron en el MISMO viaje físico? Sí, si el GPS de la misma unidad da el
 * mismo día y la misma hora de salida (D17: cuando los mandan a otro destino estando en camino,
 * Kepler a veces hace otra guía). Medido en prod el 2026-11-23, catorcena 5→18 nov: 20 de las 118
 * guías con GPS comparten salida con otra (8 viajes). Sin día de salida no se afirma nada.
 */
export function mismoViajeFisico(a: Pick<ViajeGps, 'salida' | 'dia_salida'>, b: Pick<ViajeGps, 'salida' | 'dia_salida'>): boolean {
  return !!a.dia_salida && a.dia_salida === b.dia_salida && a.salida === b.salida;
}

/** `HH:MM` → minutos del día; `null` si no es una hora válida. */
const minutos = (h: string | null | undefined): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(h ?? '');
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh < 24 && mm < 60 ? hh * 60 + mm : null;
};
const DIA = 1440;
const dias = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/**
 * `[CML.J]` La ventana en que el camión estuvo FUERA según la hoja de viaje (salida y llegada que
 * capturó el encargado), en minutos desde una época común. Sin GPS es lo único que dice cuándo salió.
 *  · El día de salida es el de la guía, salvo que la guía se haya capturado DESPUÉS de la hora de
 *    salida: entonces se cargó en la tarde y salió al día siguiente (medido en CML.H).
 *  · Si la llegada no es posterior a la salida, o durmió fuera, regresó al día siguiente.
 * `null` si falta algo: sin ventana no se sugiere nada.
 */
export function ventanaDeLaHoja(
  guia: { fecha: string; hora_captura: string | null },
  hoja: { salida: string | null; llegada: string | null; duerme_fuera: boolean },
): { desde: number; hasta: number } | null {
  const s = minutos(hoja.salida);
  const l = minutos(hoja.llegada);
  if (s == null || l == null || !guia.fecha) return null;
  const captura = minutos(guia.hora_captura);
  const dia = dias(guia.fecha) + (captura != null && captura > s ? 1 : 0);
  const desde = dia * DIA + s;
  const hasta = (dia + (l <= s || hoja.duerme_fuera ? 1 : 0)) * DIA + l;
  // Más de 20 h fuera casi siempre es un error de captura (4:30 AM por 4:30 PM): sugeriría las guías de
  // todo un día. Sin ventana confiable no se sugiere nada.
  if (hasta - desde > VENTANA_HOJA_MAX_HORAS * 60) return null;
  return { desde, hasta };
}

/** `[CML.J]` Más horas fuera que esto, sin GPS, no se cree: es más probable un error de captura. */
export const VENTANA_HOJA_MAX_HORAS = 20;

/**
 * `[CML.J]` Sin GPS (D17, caso 3): ¿otra guía de la MISMA unidad se capturó en Kepler mientras el
 * camión estaba fuera según la hoja? Un camión en la calle no empieza otro viaje: si la sucursal le
 * hizo otra guía en ese rato, es el desvío. Estrictamente dentro de la ventana (capturar justo a la
 * hora de salida es la guía del viaje siguiente o la misma carga). Sólo SUGIERE: confirma una persona.
 */
export function capturadaMientrasFuera(
  ventana: { desde: number; hasta: number } | null,
  otra: { fecha: string; hora_captura: string | null },
): boolean {
  const h = minutos(otra.hora_captura);
  if (!ventana || h == null || !otra.fecha) return false;
  const t = dias(otra.fecha) * DIA + h;
  return t > ventana.desde && t < ventana.hasta;
}

/**
 * `[CML.J2]` Cuántas guías capturadas mientras el camión estaba fuera se pueden sugerir como desvío.
 * Un desvío (D17) es UN destino más; si Kepler le hizo dos o más guías a la unidad en ese rato, la
 * clave de unidad la comparten varios camiones (medido en local el 2026-11-25: la sucursal 01 tiene
 * 102 guías en 9 unidades, hasta 9 en una unidad el mismo día) y la hoja no dice cuál fue.
 */
export const MAX_DESVIOS_POR_HOJA = 1;

/**
 * `[CML.J2]` Qué se sugiere de las guías capturadas mientras el camión estaba fuera: todas si son a
 * lo más `MAX_DESVIOS_POR_HOJA`; si son más, ninguna, y se dice cuántas fueron (nunca se adivina).
 */
export function desvioPorLaHoja<T>(capturadasFuera: T[]): { sugeridas: T[]; omitidas: number } {
  return capturadasFuera.length > MAX_DESVIOS_POR_HOJA
    ? { sugeridas: [], omitidas: capturadasFuera.length }
    : { sugeridas: capturadasFuera, omitidas: 0 };
}
