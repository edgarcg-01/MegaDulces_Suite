/**
 * `[PQ.162]` **Una compra se paga CON impuestos, y así se muestra desde que se genera** (Edgar,
 * 2026-11-27: *«se paga con impuestos, lo correcto es siempre agregar los impuestos desde que se
 * genera la compra, para no sobrecomprar»*).
 *
 * La fórmula es la de Kepler, no una propia: el total de la OC (`kdm1.c16`) es
 * Σ `c13` × (1 + IVA%/100 + IEPS%/100), con las tasas de la ficha del producto (`kdii.c18` IVA,
 * `kdii.c19` IEPS, guardadas en negativo) que el sink copia al renglón `[PQ.21]`. Medida contra
 * `c16` el 2026-11-27: 3,381 de 3,381 OC de compra sin descuento de encabezado (ago–nov 2026).
 * Las 210 con descuento (`kdm1.c13`) cuadran restándolo: ese descuento se negocia en Kepler y la
 * Suite no lo conoce antes de la OC.
 *
 * Lo que se GUARDA (requisición, renglón de Kepler) sigue sin impuestos: es como Kepler lo escribe.
 * Esto es sólo lo que se muestra como dinero a pagar.
 */

/**
 * El importe con impuestos, redondeado a centavos.
 *
 * @param importe  importe sin impuestos (cantidad × costo).
 * @param imp      IVA % + IEPS % (p. ej. 16, 8, 24 o 0). `null`/`undefined` = sin tasa en Kepler:
 *                 el importe sale tal cual y quien lo muestre DEBE declararlo (`sinTasa`).
 */
export function conImpuestos(importe: number, imp: number | null | undefined): number {
  const v = Number(importe) || 0;
  const t = imp == null ? 0 : Math.abs(Number(imp)) || 0;
  return Math.round(v * (1 + t / 100) * 100) / 100;
}

/** La tasa total desde las dos columnas de la ficha de Kepler (vienen en negativo). */
export function tasaImpuestos(iva: number | string | null | undefined, ieps: number | string | null | undefined): number | null {
  if (iva == null && ieps == null) return null;
  return Math.abs(Number(iva) || 0) + Math.abs(Number(ieps) || 0);
}
