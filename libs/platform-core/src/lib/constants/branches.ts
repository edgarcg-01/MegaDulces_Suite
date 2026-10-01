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
  // ⚠️ El `00` de Kepler cambió de SIGNIFICADO, no sólo de nombre: era **OFICINAS** (facturación
  // centralizada, 79-143 docs/día) y desde el corte del 2026-09-30 es además el **CEDIS**. Este
  // rótulo es el de HOY; para un documento anterior a esa fecha, `00` era Oficinas.
  // El nombre canónico vive en `commercial.warehouses.name` (mig 20261001120000); esto es fallback.
  '00': 'CEDIS',
  '01': 'Padre Hidalgo',
  '02': 'La Piedad Abastos',
  '03': '8 Esquinas',
  '04': 'Yurécuaro',
  '05': 'Zamora Centro',
  // Canindo pasó a tener sucursal Kepler propia (`md_06`) desde el 2026-08-15; antes sólo
  // existía del lado Wincaja ('50', que se conserva abajo para los registros previos).
  '06': 'Canindo',
  // Morelia Madero pasó a tener sucursal Kepler propia (`md_07`) desde el 2026-09-08; antes sólo
  // existía del lado Wincaja ('32', que se conserva abajo para los registros previos al cutover).
  '07': 'Morelia Madero',
  // Morelia Abastos pasó a Kepler propio (`md_08`) el 2026-09-18, y el 2026-09-21 su almacén se
  // FUSIONÓ: `MD-30` se renombró a `08` y quedó con las dos identidades en la misma fila
  // (`kepler_code='08'` + `wincaja_source_branch='30'`), como Canindo. El '30' de abajo sigue
  // siendo la llave de su historia Wincaja, que los feeds antiguos emiten y nadie reescribe.
  '08': 'Morelia Abastos',
  // Wincaja (mostrador) — eras cerradas; se conservan porque la historia se sigue consultando.
  '30': 'Morelia Abastos',
  '32': 'Morelia Madero',
  '50': 'Canindo',
});

/** Nombre legible de la sucursal; si el código no está en el catálogo, devuelve el código. */
export function branchName(code: string | null | undefined): string {
  const c = (code ?? '').trim();
  return KEPLER_BRANCH_NAMES[c] || c;
}
