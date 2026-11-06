/**
 * [CANON.5.23] La identidad de un producto (nombre, línea, barcode crudo) sale de UNA regla, la de
 * CANON.1.3: **retail primero** (excluye el CEDIS `00`, gana el precio más alto y a igual precio la
 * sucursal menor), con respaldo al CEDIS sólo si el SKU no existe en ninguna tienda.
 *
 * La usan los dos escritores de `catalog.products.nombre`: el barrido nocturno
 * (`repoint-catalog-names`) y el hop-2 al llegar un cambio de `kdii` (`normalizeProductsFromOds`).
 * Antes cada uno tenía su regla (el hop-2, CEDIS primero) y un producto descontinuado sólo en el
 * CEDIS («***DESC DOÑA VITA…») cambiaba de nombre dos veces cada noche (H12 del anexo CANON.5).
 *
 * @param {object}  o
 * @param {string}  [o.schema='kepler_ods']  esquema que tiene `kdii` (`kp` en el modo legado)
 * @param {string}  [o.skuParam]             placeholder de un text[] para acotar SKUs (p. ej. '$1')
 * @returns {string} SELECT de (sku, nombre, linea, barcode); barcode NULL si viene vacío
 */
function identitySnapshotSql({ schema = 'kepler_ods', skuParam } = {}) {
  if (!/^[a-z_]+$/.test(schema)) throw new Error(`product-identity: esquema inválido '${schema}'`);
  if (skuParam != null && !/^\$[0-9]+$/.test(skuParam)) throw new Error(`product-identity: parámetro inválido '${skuParam}'`);
  const acota = skuParam ? `AND btrim(c1) = ANY(${skuParam})` : '';
  const una = (cond) => `
        SELECT DISTINCT ON (btrim(c1)) btrim(c1) AS sku, btrim(c2) AS nombre, btrim(c3::text) AS linea,
               nullif(btrim(coalesce(c7,'')),'') AS barcode
          FROM ${schema}.kdii
         WHERE btrim(coalesce(c1,'')) <> '' AND btrim(coalesce(c2,'')) <> '' AND ${cond} ${acota}
         ORDER BY btrim(c1), c90::numeric DESC NULLS LAST, btrim(sucursal)`;
  return `
      WITH retail AS (${una(`btrim(sucursal) <> '00'`)}),
           cedis AS (${una(`btrim(sucursal) = '00'`)})
      SELECT sku, nombre, linea, barcode FROM retail
      UNION ALL
      SELECT c.sku, c.nombre, c.linea, c.barcode FROM cedis c WHERE NOT EXISTS (SELECT 1 FROM retail r WHERE r.sku = c.sku)`;
}

module.exports = { identitySnapshotSql };
