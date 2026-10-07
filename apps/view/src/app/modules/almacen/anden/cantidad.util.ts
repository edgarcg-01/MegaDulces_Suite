/**
 * Andén · aritmética de la captura por cajas. **Puro, sin Angular ni PrimeNG.**
 *
 * Vive aparte del componente a propósito: es la parte testeable y la que decide
 * cuántas piezas entran al inventario. Importarla desde una spec no debe arrastrar
 * medio framework.
 *
 * El bodeguero no cuenta 480 mazapanes: cuenta 20 cajas de 24. De ahí que la
 * captura pida cajas completas y piezas sueltas por separado.
 *
 * **`uxc` (piezas por caja)** sale de `catalog.product_barcodes.factor`. Verificado
 * contra la base: **sólo el 3.1 % de los SKU tiene código de caja** (358 de 11,525)
 * y 4,579 filas lo tienen en `null`. Cuando falta, las cajas no aportan y se cuenta
 * por piezas — nunca se asume un factor, porque eso metería cantidades falsas.
 */

/** `cajas × uxc + sueltas`. Trunca y descarta negativos: no hay media caja. */
export function calcularTotal(cajas: number, sueltas: number, uxc: number | null): number {
  const c = Number.isFinite(cajas) && cajas > 0 ? Math.floor(cajas) : 0;
  const s = Number.isFinite(sueltas) && sueltas > 0 ? Math.floor(sueltas) : 0;
  const f = uxc && uxc > 0 ? uxc : 0;
  return c * f + s;
}

/**
 * La diferencia contra Kepler, en el idioma del bodeguero: "faltan 48 — 2 cajas"
 * en vez de "faltan 48 pz". Sólo se dice en cajas cuando es múltiplo exacto del
 * `uxc`; si no, hablar de "2.08 cajas" confunde más de lo que ayuda.
 */
export function describirDiferencia(diff: number, uxc: number | null): string {
  if (diff === 0) return 'coincide con Kepler';
  const abs = Math.abs(diff);
  const verbo = diff < 0 ? 'faltan' : 'sobran';
  if (uxc && uxc > 1 && abs % uxc === 0) {
    const cajas = abs / uxc;
    return `${verbo} ${abs} — ${cajas} ${cajas === 1 ? 'caja' : 'cajas'}`;
  }
  return `${verbo} ${abs}`;
}
