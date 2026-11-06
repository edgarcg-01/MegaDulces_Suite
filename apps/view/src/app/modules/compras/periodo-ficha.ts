import { datePresetRange, isoLocalDate } from '../../shared/util/date-presets.util';

/**
 * `[PF.23]` El periodo de un bloque de la ficha de Compras › Catálogo (la venta por sucursal en Sencillo, las
 * compras en Detallado). Los rangos salen de `datePresetRange` (shared): «Este mes» significa lo mismo en toda la app.
 * El servidor valida y recorta (`periodoFicha`): a lo más dos años y nunca después de hoy.
 */
export type PresetPeriodo = 'mes' | 'mes_prev' | 'd90' | 'anio' | 'anio_prev' | 'otro';

export const OPCIONES_PERIODO: ReadonlyArray<{ label: string; value: PresetPeriodo }> = [
  { label: 'Este mes', value: 'mes' },
  { label: 'Mes pasado', value: 'mes_prev' },
  { label: 'Últimos 90 días', value: 'd90' },
  { label: 'Este año', value: 'anio' },
  { label: 'Año pasado', value: 'anio_prev' },
  { label: 'Elegir fechas', value: 'otro' },
];

export interface PeriodoFicha { desde: string; hasta: string }

/** Un preset a fechas (YYYY-MM-DD, locales). `otro` necesita el rango elegido; incompleto → null. */
export function periodoDe(preset: PresetPeriodo, elegido: readonly (Date | null)[] | null, hoy: Date = new Date()): PeriodoFicha | null {
  if (preset === 'otro') {
    const [a, b] = elegido ?? [];
    if (!a) return null;
    return { desde: isoLocalDate(a), hasta: isoLocalDate(b ?? a) };
  }
  const r = datePresetRange(preset, hoy);
  return r ? { desde: isoLocalDate(r.from), hasta: isoLocalDate(r.to) } : null;
}

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** «1 ene 2025», sin pasar por `Date` (una fecha de calendario no tiene zona horaria). */
export function fechaCortaPeriodo(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${Number(m[3])} ${MESES[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** «del 1 ene 2025 al 31 dic 2025»; el mismo día, «el 4 nov 2026». */
export function textoPeriodo(p: PeriodoFicha | null | undefined): string {
  if (!p) return '';
  return p.desde === p.hasta ? `el ${fechaCortaPeriodo(p.desde)}` : `del ${fechaCortaPeriodo(p.desde)} al ${fechaCortaPeriodo(p.hasta)}`;
}
