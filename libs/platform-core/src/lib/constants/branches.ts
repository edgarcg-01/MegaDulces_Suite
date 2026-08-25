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
