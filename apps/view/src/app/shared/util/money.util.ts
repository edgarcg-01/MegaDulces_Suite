/**
 * Importe en pesos, SIN redondear.
 *
 * Existe porque cada pantalla se estaba escribiendo la suya, y varias cortaban a pesos
 * enteros (`maximumFractionDigits: 0`). En una pantalla de conciliación o de cuadre eso es
 * grave: los centavos suelen SER la diferencia que se anda buscando, y el usuario termina
 * viendo dos cifras idénticas al lado de un semáforo que dice "no cuadra" —el semáforo se
 * calcula con centavos, la pantalla los esconde—. Una sola definición, dos decimales.
 *
 * Acepta null: muchas columnas son "el importe de la otra fuente, si lo tiene".
 */
export function money(v: number | null | undefined): string {
  return Number(v || 0).toLocaleString('es-MX', {
    style: 'currency', currency: 'MXN',
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

/**
 * Variante para KPIs y ejes de gráfica, donde el centavo es ruido y lo que importa es la
 * magnitud. Se usa a propósito y por excepción — NUNCA en una celda que alguien vaya a cuadrar.
 */
export function moneyShort(v: number | null | undefined): string {
  return Number(v || 0).toLocaleString('es-MX', {
    style: 'currency', currency: 'MXN', maximumFractionDigits: 0,
  });
}

/**
 * `[CGP-V.7]` Como `money`, pero lo que no se midió se DICE: `null`, `undefined`, vacío o algo que no
 * es número → `'sin medir'` (o la etiqueta que se pase), nunca `$0.00`. Un cero medido sigue siendo
 * cero. Acepta texto porque el `numeric` de Postgres llega así por JSON.
 *
 * ⚠️ Aditiva a propósito: `money` no cambia. La usan Finanzas y Compras, y muchas columnas suyas
 * son «el importe de la otra fuente, si lo tiene», donde el `?? 0` es una decisión de cada pantalla.
 */
export function moneyOSinMedir(v: number | string | null | undefined, sinDato = 'sin medir'): string {
  if (v == null || v === '') return sinDato;
  const n = Number(v);
  return Number.isFinite(n) ? money(n) : sinDato;
}
