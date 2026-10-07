import type { SdSlaCompliance, SdReportTiming } from '@megadulces/contracts';

/**
 * `[MS.3.5]` Cómo se escribe lo que trae el reporte. Lo único que importa: **lo que no se midió no se dibuja
 * como cero**. Un tiempo sin muestras y un cumplimiento sin tickets que juzgar salen como «—», nunca «0 min» ni
 * «0 %» (que dirían «tardamos nada» y «nadie cumplió»).
 */

/** `null` → «—»; menos de una hora en minutos; el resto en horas (y minutos si sobran). */
export function fmtMin(min: number | null | undefined): string {
  if (min === null || min === undefined) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const r = Math.round(min % 60);
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

export function fmtPct(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? '—' : `${pct.toLocaleString('es-MX', { maximumFractionDigits: 1 })} %`;
}

/** «75 % (3 de 4)», o «—» si no hay nada que juzgar. Lo que sigue en plazo se dice aparte, no se mezcla. */
export function fmtCumplimiento(c: SdSlaCompliance): string {
  const juzgados = c.cumplidos + c.incumplidos;
  if (c.cumplimiento_pct === null || juzgados === 0) return '—';
  return `${fmtPct(c.cumplimiento_pct)} (${c.cumplidos} de ${juzgados})`;
}

/** Nota de lo que NO entró al porcentaje, para el `title` de la celda. */
export function notaCumplimiento(c: SdSlaCompliance): string {
  const partes: string[] = [];
  if (c.en_plazo) partes.push(`${c.en_plazo} todavía en plazo (no se juzgan aún)`);
  if (c.sin_plazo) partes.push(`${c.sin_plazo} sin plazo`);
  return partes.length ? `No entran al porcentaje: ${partes.join(' · ')}.` : 'Todos los tickets entran al porcentaje.';
}

export function fmtTiempo(t: SdReportTiming): string {
  return t.n === 0 ? '—' : `${fmtMin(t.p50)}`;
}
