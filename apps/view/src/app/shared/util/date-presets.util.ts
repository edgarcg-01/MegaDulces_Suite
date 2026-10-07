/**
 * Presets de rango de fecha compartidos por las vistas de Operations (Compras 360,
 * Costo neto, tablero CxP, …). Un solo lugar para las opciones + la resolución a
 * {from,to}, para que "Este mes" signifique lo mismo en toda la app.
 */
export interface DatePresetOption { label: string; value: string; }

/**
 * `Date` → `YYYY-MM-DD` **en la fecha LOCAL**, que es la que el usuario ve en el calendario.
 *
 * ⚠️ El reflejo de escribir `d.toISOString().slice(0, 10)` devuelve la fecha **UTC**, y en
 * `America/Mexico_City` (UTC−6) eso **ya es el día siguiente a partir de las 18:00**. Medido:
 * a las 19:30 del 14-sep, `toISOString()` da `2026-09-15`.
 *
 * El daño escala al revés de lo que uno espera: en un rango de un mes el corrimiento de un día
 * es invisible, pero en un filtro **"hoy"** es el 100% del error — pide desde mañana y la
 * pantalla sale vacía toda la tarde. Y en un turno vespertino de captura, la tarde es el turno.
 *
 * Usar SIEMPRE esto para mandarle una fecha de calendario al backend. Es la contracara en el
 * frontend de lo que `apps/api/src/shared/date/mx-date.ts` hace del lado del servidor, y de la
 * regla de DESIGN §Ing.UI 7: "no re-convertir con `new Date()` ingenuo del navegador".
 */
export function isoLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

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
