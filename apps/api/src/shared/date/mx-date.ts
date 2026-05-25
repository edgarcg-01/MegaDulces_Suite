/**
 * Helpers de fecha en zona horaria de México (America/Mexico_City).
 *
 * Por qué existe este archivo: las visitas se capturan en MX (UTC-6/-5). Si
 * derivamos el "día calendario" con `toISOString().split('T')[0]` (UTC), una
 * captura del lunes 7 PM MX se convierte en el martes UTC y cae en el bucket
 * equivocado en los reportes diarios/semanales.
 *
 * Todos los endpoints de reportes/dashboard que agrupen por fecha **deben**
 * usar `toMxDateKey()` en lugar de `toISOString().split('T')[0]`.
 *
 * El TZ está hardcoded como constante porque el negocio opera en México.
 * Si en el futuro se internacionaliza, este es el único archivo que cambia.
 */

export const MX_TZ = 'America/Mexico_City';

/**
 * Devuelve `YYYY-MM-DD` correspondiente al día calendario en MX para la
 * fecha dada.
 *
 * Acepta:
 *   - `Date` → formatea según TZ MX
 *   - `string` ISO o `YYYY-MM-DD` → toma los primeros 10 chars (asume que
 *     ya viene como string del día calendario, sin desplazar)
 *   - `null` / `undefined` / inválido → devuelve `''`
 */
export function toMxDateKey(value: Date | string | null | undefined): string {
  if (value == null) return '';
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return '';
    return value.toLocaleDateString('en-CA', { timeZone: MX_TZ });
  }
  // String: si trae componente de tiempo, recortar; si ya es 'YYYY-MM-DD' queda igual.
  return String(value).split('T')[0];
}

/**
 * "Hoy" en MX como `YYYY-MM-DD`. Útil para filtros "fecha = hoy" donde el
 * "hoy" del servidor (UTC) puede no coincidir con el "hoy" del usuario en MX.
 */
export function todayMx(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: MX_TZ });
}
