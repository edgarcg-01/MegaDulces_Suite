/**
 * `[CGP-L.4]` 'YYYY-MM-DD' → '13-oct'. Para nombrar una jornada en una frase.
 *
 * Vive en `contracts` porque lo usan el servidor (los textos del sensor y de la regla de apertura)
 * y la pantalla (las jornadas pendientes): dos copias de un formateador divergen, y la campana diría
 * "13-oct" mientras la pantalla dice "13/10/26" sobre el mismo día.
 *
 * ⚠️ Sin `Date`: una fecha de CALENDARIO no tiene zona horaria. Pasarla por `new Date()` la corre un
 * día en cualquier zona al oeste de UTC — es la familia de `String(date)` que ya cobró en este repo.
 * Lo que no tiene forma de fecha se devuelve tal cual: no se inventa un día.
 */
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

export function diaCorto(fecha: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(fecha ?? ''));
  const mes = m ? MESES[Number(m[2]) - 1] : undefined;
  return m && mes ? `${Number(m[3])}-${mes}` : String(fecha);
}
