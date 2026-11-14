/**
 * `[RE.74]` — Lo que se muestra de la referencia de una devolución o nota de crédito (`kdm1.c11`).
 *
 * Es TEXTO LIBRE, no el folio de una factura: el cajón la rotulaba «Factura ref.» y en prod (2026-11-14)
 * 429 de 2,154 ajustes traen ahí el CÓDIGO DEL PROVEEDOR. Leerlo como factura manda a buscar un documento
 * que no existe. Ese caso se dice en llano; el resto se muestra tal cual.
 */
export function referenciaDelAjuste(ref: string | null | undefined, proveedorCode: string | null | undefined): string | null {
  const r = (ref ?? '').trim();
  if (!r) return null;
  if (proveedorCode && r.toUpperCase() === proveedorCode.trim().toUpperCase()) {
    return `${r} (es el código del proveedor, no una factura)`;
  }
  return r;
}
