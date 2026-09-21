/**
 * **En qué se cuenta un renglón de vale.**
 *
 * El vale del ERP trae su propia unidad (`analytics.erp_goods_receipt_lines.unidad`)
 * y **casi nunca es la pieza**: medido en `platform_test`, **68,440 de 93,030
 * renglones (73.6%) se cuentan en otra cosa** — `PAQ` 60,468 · `PZA` 24,587 ·
 * `KG` 4,455 · `CJA` 168 · `BTO` 8, y alguna con el gramaje metido como unidad
 * (`500`, `250`, `2KG`).
 *
 * Por eso ninguna pantalla puede escribir "pz" y darlo por hecho: el bodeguero
 * está contando paquetes y la pantalla le dice piezas. Es la misma confusión que
 * ADR-055 documentó en el pedido, con la diferencia de que acá **no hay que
 * convertir nada** — sólo llamar a la cantidad por su nombre.
 *
 * `'ambigua'` es un centinela del backend, no una unidad: significa que ese SKU
 * llegó con MÁS DE UNA unidad dentro del mismo vale y el join dejó de ser
 * determinista. Hoy son 0 casos de 89,167 pares en prod, pero es una propiedad
 * del dato y no del modelo. Antes que elegir una en silencio, se dice `unidades`.
 */

/** La unidad del vale, lista para escribirla al lado de un número. */
export function unidadDelVale(expectedUnit: string | null | undefined): string {
  const u = (expectedUnit || '').trim();
  if (!u || u === 'ambigua') return 'unidades';
  return u.toLowerCase();
}

/** `true` cuando el backend no pudo decidir en qué se cuenta ese renglón. */
export function unidadAmbigua(expectedUnit: string | null | undefined): boolean {
  return (expectedUnit || '').trim() === 'ambigua';
}
