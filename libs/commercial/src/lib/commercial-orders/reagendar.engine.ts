/**
 * `[MCP.29]` Reglas puras de «cambiar el día de entrega» desde la tarjeta de «Mis pedidos». Sin base ni
 * HTTP: se prueban solas (`reagendar.engine.spec.ts`). Quién puede y hasta cuándo (D1: el surtidor no lo
 * ha tomado) lo revisa el servicio, igual que al modificar productos.
 *
 * Decisiones de David (2026-11-20): calendario LIBRE hacia adelante, domingos incluidos (hay sucursales
 * que trabajan en domingo); nunca al pasado (el surtidor lo vería «atrasado» desde que nace).
 */

/** Una fecha que no se puede guardar. El servicio la vuelve un 400 con este mensaje. */
export class FechaDeEntregaInvalida extends Error {}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** ¿`YYYY-MM-DD` de un día que existe? (`2026-02-30` no.) */
export function esFechaReal(v: string): boolean {
  const m = ISO.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * El día de entrega nuevo, validado. `hoy` es el día en México (`YYYY-MM-DD`), el que dice el servidor.
 * Lanza {@link FechaDeEntregaInvalida} con el mensaje para la vendedora.
 */
export function fechaDeEntregaNueva(valor: unknown, hoy: string): string {
  const v = typeof valor === 'string' ? valor.trim() : '';
  if (!esFechaReal(v)) throw new FechaDeEntregaInvalida('Elige un día de entrega válido en el calendario.');
  if (v < hoy) throw new FechaDeEntregaInvalida('El día de entrega no puede ser antes de hoy.');
  return v;
}

// Tablas fijas y no `Intl`: el texto queda guardado en el justificante y no debe cambiar con la versión de ICU.
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «vie 21 nov»: así se lee en la tarjeta del celular. */
export function diaCorto(v: string): string {
  const m = ISO.exec(v);
  if (!m || !esFechaReal(v)) return v;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]}`;
}

/** El detalle del justificante: «del vie 21 nov al lun 23 nov». */
export function detalleDeCambioDeFecha(desde: string | null, hasta: string): string {
  return desde ? `del ${diaCorto(desde)} al ${diaCorto(hasta)}` : `al ${diaCorto(hasta)}`;
}

/** Las dos fechas de una fila de historia de cambio de día (`snapshot.delivery_date`); `null` = no es de ésas. */
export function cambioDeFechaDe(snapshot: unknown): { from: string | null; to: string } | null {
  let s = snapshot;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  const dd = (s as { delivery_date?: { from?: unknown; to?: unknown } } | null)?.delivery_date;
  if (!dd || typeof dd.to !== 'string' || !esFechaReal(dd.to)) return null;
  return { from: typeof dd.from === 'string' && esFechaReal(dd.from) ? dd.from : null, to: dd.to };
}

/**
 * El texto de una fila de la historia del pedido para las líneas de tiempo que pintan «de estado → a estado + motivo»
 * (Comercial, Almacén y el portal del cliente): un cambio de día no cambia de estado, así que sin esto se leería
 * «Confirmado → Confirmado · <motivo>» sin decir qué pasó (Ley 0). Las demás filas, tal cual.
 */
export function razonDeHistoria(f: { from_status: string | null; to_status: string; reason: string | null; snapshot?: unknown }): string | null {
  const dd = f.from_status === f.to_status ? cambioDeFechaDe(f.snapshot) : null;
  if (!dd) return f.reason;
  const que = `Cambió el día de entrega ${detalleDeCambioDeFecha(dd.from, dd.to)}`;
  return f.reason?.trim() ? `${que} · ${f.reason.trim()}` : que;
}
