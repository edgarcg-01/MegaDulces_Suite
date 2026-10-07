/**
 * Helpers de fecha en zona horaria de México (espejo del util del backend).
 *
 * Toda fecha de "día calendario" (YYYY-MM-DD) que se mande/reciba debe
 * representar el día del NEGOCIO en MX, no UTC. `new Date('2026-05-25')`
 * y `new Date().toISOString().split('T')[0]` ambos producen UTC, así que
 * en pantallas en MX vespertinas el día cambia uno hacia adelante y se
 * rompen filtros, charts y agregaciones diarias.
 */

export const MX_TZ = 'America/Mexico_City';

/** "Hoy" en MX como `YYYY-MM-DD`. */
export function todayMx(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: MX_TZ });
}

/**
 * Devuelve `YYYY-MM-DD` correspondiente al día en MX para la fecha dada.
 * Acepta `Date`, string (ISO o `YYYY-MM-DD`), null/undefined → `''`.
 */
export function toMxDateKey(value: Date | string | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return value.toLocaleDateString('en-CA', { timeZone: MX_TZ });
  }
  return String(value).split('T')[0];
}

/**
 * Parsea un string `YYYY-MM-DD` como fecha LOCAL (midnight en la TZ del
 * browser, no UTC). Útil para extraer día de semana / día del mes sin que
 * el TZ corra al día anterior.
 *
 * `new Date('2026-05-25')` (parser nativo) → UTC midnight → en MX cae al
 * 24 de mayo 18:00 local. Esta función devuelve `new Date(2026, 4, 25)`.
 */
export function parseLocalDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parts = String(iso).split('T')[0].split('-');
  if (parts.length < 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
