import type { CorteCodigo } from '@megadulces/contracts';
import { rangoEnCorte } from '@megadulces/contracts';

/** `[FCU.3]` Periodo y corte de las pantallas de Costo por unidad. */
export type CorteVista = 'periodo' | CorteCodigo;
export type Preset = 'mes' | 'mes_anterior' | 'anio' | 'doce' | 'otro';

/** `[FCU.3.1]` Fecha local ↔ AAAA-MM-DD (sin pasar por UTC, para que el día no se corra). */
export const aIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const deIso = (s: string) => new Date(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));

/** Las fechas de cada atajo de periodo, contadas desde `hoy`. */
export function rangoDe(preset: Exclude<Preset, 'otro'>, hoy: Date): { desde: string; hasta: string } {
  const y = hoy.getFullYear();
  const m = hoy.getMonth();
  switch (preset) {
    case 'mes': return { desde: aIso(new Date(y, m, 1)), hasta: aIso(hoy) };
    case 'mes_anterior': return { desde: aIso(new Date(y, m - 1, 1)), hasta: aIso(new Date(y, m, 0)) };
    case 'anio': return { desde: aIso(new Date(y, 0, 1)), hasta: aIso(hoy) };
    case 'doce': return { desde: aIso(new Date(y, m, hoy.getDate() - 364)), hasta: aIso(hoy) };
  }
}

/** Un monto del periodo en el corte elegido (como las columnas de la hoja); «periodo» lo deja tal cual. */
export function enCorte(monto: number | null, dias: number, corte: CorteVista): number | null {
  if (monto == null) return null;
  return corte === 'periodo' ? monto : rangoEnCorte(monto, dias, corte);
}
