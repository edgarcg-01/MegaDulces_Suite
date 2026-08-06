/**
 * Presets de rango de fecha compartidos por las vistas de Operations (Compras 360,
 * Costo neto, tablero CxP, …). Un solo lugar para las opciones + la resolución a
 * {from,to}, para que "Este mes" signifique lo mismo en toda la app.
 */
export interface DatePresetOption { label: string; value: string; }

export const DATE_PRESET_OPTIONS: DatePresetOption[] = [
  { label: 'Hoy', value: 'hoy' },
  { label: 'Últimos 7 días', value: 'd7' },
  { label: 'Últimos 30 días', value: 'd30' },
  { label: 'Este mes', value: 'mes' },
  { label: 'Mes pasado', value: 'mes_prev' },
  { label: 'Este año', value: 'anio' },
];

/**
 * Resuelve un preset a un rango de `Date` locales (sin correr por TZ). Devuelve null
 * si la key no es un preset conocido (p.ej. al limpiar el select). `now` es inyectable
 * para pruebas; por default usa el reloj del navegador.
 */
export function datePresetRange(key: string, now: Date = new Date()): { from: Date; to: Date } | null {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  let from: Date; let to: Date = new Date(y, m, d);
  switch (key) {
    case 'hoy': from = new Date(y, m, d); break;
    case 'd7': from = new Date(y, m, d - 6); break;
    case 'd30': from = new Date(y, m, d - 29); break;
    case 'mes': from = new Date(y, m, 1); break;
    case 'mes_prev': from = new Date(y, m - 1, 1); to = new Date(y, m, 0); break;
    case 'anio': from = new Date(y, 0, 1); break;
    default: return null;
  }
  return { from, to };
}
