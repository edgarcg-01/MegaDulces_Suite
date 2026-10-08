/**
 * `[WMS-REC.18]` **El día en hora de México**, para separar lo de hoy de lo atrasado en el Andén.
 *
 * Es el mismo día con que filtra el servidor (`now() AT TIME ZONE 'America/Mexico_City'`). Se
 * calcula en México y no con la hora del teléfono: un equipo con la zona mal puesta pasaría los
 * vales de hoy al grupo de atrasados.
 *
 * Las fechas llegan de dos formas: `YYYY-MM-DD` (la fecha del documento, ya como texto) o un
 * instante ISO (cuándo se abrió un vale). Las dos se reducen al día de México.
 */

const ZONA = 'America/Mexico_City';

/** Hoy en México como `YYYY-MM-DD`. */
export function hoyMexico(ahora: Date = new Date()): string {
  return ahora.toLocaleDateString('en-CA', { timeZone: ZONA });
}

/** El día de México de una fecha o un instante. `null` si no se puede leer. */
export function fechaMexico(valor: string | null | undefined): string | null {
  if (!valor) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(valor)) return valor;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA', { timeZone: ZONA });
}

/** Días completos entre esa fecha y hoy (0 = hoy, 1 = ayer, negativo = a futuro). */
export function diasDesde(valor: string | null | undefined, hoy: string): number | null {
  const f = fechaMexico(valor);
  if (!f) return null;
  return Math.round((Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${f}T00:00:00Z`)) / 86_400_000);
}

/** ¿Es de un día anterior a hoy? Lo de hoy, lo de mañana y lo que no tiene fecha, no. */
export function esAnterior(valor: string | null | undefined, hoy: string): boolean {
  const d = diasDesde(valor, hoy);
  return d !== null && d > 0;
}
