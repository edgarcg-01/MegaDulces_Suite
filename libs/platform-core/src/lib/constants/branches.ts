/**
 * Catálogo de sucursales del espacio de códigos **Kepler / Wincaja** (`sucursal` en
 * `analytics.erp_*`). Fuente única: el mismo mapa estaba copiado en varios services y
 * ya había divergido en la forma de nombrar ("8 Esquinas" vs "8ESQ" vs "Ocho Esquinas").
 *
 * ⚠️ **No confundir espacios de códigos.** Finanzas/GX (`expense-proofs`) usa OTRO
 * espacio para la misma sucursal física ('10' = Padre Hidalgo, '40' = Ocho Esquinas,
 * '42' = La Piedad, '44' = Yurécuaro). Este archivo es SOLO el de Kepler/Wincaja.
 *
 * 🎯 **Destino:** cuando `commercial.warehouses.kepler_code` / `.wincaja_source_branch`
 * estén poblados (hoy: 0 filas), esto se deriva de la tabla y el mapa queda como
 * fallback. Ver la regla "derivar, no copiar" del modelo canónico de datos.
 */
export const KEPLER_BRANCH_NAMES: Readonly<Record<string, string>> = Object.freeze({
  // Kepler
  '00': 'CEDIS Irapuato',
  '01': 'Padre Hidalgo',
  '02': 'La Piedad Abastos',
  '03': '8 Esquinas',
  '04': 'Yurécuaro',
  '05': 'Zamora Centro',
  // Canindo pasó a tener sucursal Kepler propia (`md_06`) desde el 2026-08-15; antes sólo
  // existía del lado Wincaja ('50', que se conserva abajo para los registros previos).
  '06': 'Canindo',
  // Wincaja (mostrador)
  '30': 'Morelia Abastos',
  '32': 'Morelia Madero',
  '50': 'Canindo',
});

/** Nombre legible de la sucursal; si el código no está en el catálogo, devuelve el código. */
export function branchName(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  return KEPLER_BRANCH_NAMES[c] || c;
}
