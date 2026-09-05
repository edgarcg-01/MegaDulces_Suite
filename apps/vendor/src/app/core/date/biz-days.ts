/**
 * Fuente única de verdad para fechas de reparto en la app del vendedor.
 *
 * Antes esta lógica vivía triplicada y DIVERGENTE: `vendor-carga` y
 * `vendor-notifications` saltaban el domingo con ISO local; `vendor-take-order`
 * NO saltaba domingo y usaba `toISOString()` (UTC) → en sábado agendaba entrega
 * el DOMINGO (día sin reparto) y Carga —que busca el próximo día hábil (lunes)—
 * nunca lo mostraba. Un solo helper mata ese desajuste.
 *
 * Todo en hora LOCAL (el device del vendedor corre en TZ MX). Nada de
 * `toISOString()`, que corre el día por el offset UTC.
 */

/** ISO `YYYY-MM-DD` de una fecha, en calendario LOCAL (sin corrimiento UTC). */
export function toLocalIso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** ISO `YYYY-MM-DD` de hoy, en calendario LOCAL. */
export function todayIso(): string {
  return toLocalIso(new Date());
}

/**
 * Próximo día hábil de reparto: mañana; si cae domingo (no hay reparto) pasa a
 * lunes. Devuelve la `Date` (medianoche local).
 */
export function nextBusinessDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  if (d.getDay() === 0) d.setDate(d.getDate() + 1); // domingo → lunes
  return d;
}

/** ISO `YYYY-MM-DD` del próximo día hábil de reparto (local). */
export function nextBusinessDayIso(): string {
  return toLocalIso(nextBusinessDay());
}

/** true si la fecha (Date o ISO `YYYY-MM-DD`) cae en domingo. */
export function isSunday(d: Date | string): boolean {
  const date = typeof d === 'string' ? new Date(`${d}T00:00:00`) : d;
  return date.getDay() === 0;
}
