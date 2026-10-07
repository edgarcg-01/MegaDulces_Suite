/**
 * `[MS.3.5]` El periodo de un reporte: validación PURA de `desde`/`hasta` (fechas del calendario de México, no
 * instantes). Vive aparte de `reports.service.ts` para poder probarse sin Nest ni base de datos.
 *
 * Reglas: ambas fechas son `AAAA-MM-DD` REALES (el 31 de febrero no se «corrige» en silencio al 3 de marzo),
 * `desde <= hasta`, y a lo sumo 366 días. Sin parámetros, los últimos 30 días contando hoy.
 */
export const MAX_DIAS_REPORTE = 366;
export const DIAS_POR_DEFECTO = 30;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

export function fechaValida(s: unknown): s is string {
  if (typeof s !== 'string' || !FECHA_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export const sumarDias = (s: string, n: number): string => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const diasEntre = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export type ResultadoPeriodo = { ok: true; desde: string; hasta: string } | { ok: false; motivo: string };

export function resolverPeriodo(desde: string | undefined, hasta: string | undefined, hoy: string): ResultadoPeriodo {
  const h = hasta ?? hoy;
  const d = desde ?? sumarDias(h, -(DIAS_POR_DEFECTO - 1));
  if (!fechaValida(d)) return { ok: false, motivo: 'desde debe ser una fecha AAAA-MM-DD válida' };
  if (!fechaValida(h)) return { ok: false, motivo: 'hasta debe ser una fecha AAAA-MM-DD válida' };
  if (d > h) return { ok: false, motivo: 'desde no puede ser posterior a hasta' };
  if (diasEntre(d, h) + 1 > MAX_DIAS_REPORTE) return { ok: false, motivo: `El periodo admite hasta ${MAX_DIAS_REPORTE} días` };
  return { ok: true, desde: d, hasta: h };
}
