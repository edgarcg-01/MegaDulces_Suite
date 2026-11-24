/**
 * `[RE.87]` La entrada INTERNA: el «proveedor» de la entrada de Kepler es la propia empresa. No es una compra y nunca
 * va a traer factura de proveedor — son altas de códigos de promoción a un centavo, kits de promoción o mercancía
 * que regresa al terminar una promoción, capturadas como «compra» a la clave de la empresa (en prod, `CL005`
 * LUIS FRANCISCO LOPEZ GUTIERREZ, RFC = el de `fiscal.issuer_config`).
 *
 * Medido el 2026-11-23 (prod, sólo lectura): desde el arranque (1-ago) 190 de 4,205 entradas son internas; 119
 * contaban como «factura que falta» (Canindo: 14 de 14, o sea que tenía el 100 % y decía que no). Ninguna se había
 * descartado a mano.
 *
 * Es la MISMA definición que ya usaba el expediente (`goods-receipt-expediente.service.ts`, `interno`): el RFC de la
 * empresa, o un proveedor marcado `is_internal` en el catálogo (RE.30). Aquí vive en SQL, una sola vez, para la
 * lista, los conteos, la cobertura y los atrasos: se calcula del dato, no se escribe nada.
 *
 * ⛔ No desaparece: sale de lo que se le pide a la sucursal y se cuenta APARTE (igual que los descartes), con su
 * motivo siempre a la vista.
 */

/**
 * La entrada `alias` es interna. `conCatalogo` = existe la columna `catalog.suppliers.is_internal` (el código puede
 * llegar antes que su migración). Usa `alias.tenant_id`, `alias.proveedor_rfc` y `alias.proveedor_code`.
 */
export const esEntradaInternaSql = (conCatalogo: boolean, alias = 'c'): string => `(
    upper(btrim(COALESCE(${alias}.proveedor_rfc, ''))) = (SELECT upper(btrim(ic.rfc)) FROM fiscal.issuer_config ic
                                                        WHERE ic.tenant_id = ${alias}.tenant_id LIMIT 1)${conCatalogo ? `
    OR EXISTS (SELECT 1 FROM catalog.suppliers si WHERE si.tenant_id = ${alias}.tenant_id AND si.is_internal
                  AND si.deleted_at IS NULL AND btrim(si.code) = btrim(${alias}.proveedor_code))` : ''})`;

/** El porqué, para la fila y el detalle: una entrada interna nunca se muestra sin él. */
export const MOTIVO_ENTRADA_INTERNA =
  'El proveedor es la propia empresa: es un movimiento interno (alta de códigos de promoción, kit o mercancía que regresa de una promoción) y no lleva factura de proveedor.';
