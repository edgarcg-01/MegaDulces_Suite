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
