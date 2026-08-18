/* eslint-disable no-console */
/**
 * FEED de códigos de barras por UNIDAD — `import-product-barcodes.js`.
 *
 * Puebla `catalog.product_barcodes` (1 SKU → N barcodes) uniendo, server-side (mismas DB en prod):
 *   - Kepler `kdii.c7`  (unidad c11, típ. PZA)  → barcode de la PIEZA   [source kepler_pza, is_primary]
 *   - Kepler `kdii.c82` (unidad c83, factor c81) → barcode de la CAJA    [source kepler_cja]
 *   - Wincaja `articulos.codigo_barras` (unidad_compra) → el de su unidad [source wincaja]
 *
 * Dedup por (sku, barcode), precedencia kepler_pza > kepler_cja > wincaja para la etiqueta de unidad.
 * UPSERT idempotente (no borra). Filtra basura: barcode < 8 chars, = SKU, o todo-ceros.
 *
 *   DATABASE_URL_NEW = prod (kepler_ods + wincaja + catalog viven ahí mismo)
 *   node database/importers/kepler/import-product-barcodes.js            # DRY-RUN (cuenta, no escribe)
 *   node database/importers/kepler/import-product-barcodes.js --apply    # UPSERT
 *
 * Env: CRON_TENANT_ID (default mega_dulces).
 */
const { Client } = require('pg');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

// CTE de las 3 fuentes → dedup por (sku, barcode). Reusable en dry-run y apply.
// c81 (factor caja) puede traer no-numérico → guard con regex antes de ::numeric.
const SRC_CTE = `
  WITH k AS (
    SELECT DISTINCT ON (btrim(c1::text)) btrim(c1::text) sku,
           btrim(c7::text)  pza_bc, nullif(btrim(c11::text),'') pza_u,
           btrim(c82::text) cja_bc, nullif(btrim(c83::text),'') cja_u,
           CASE WHEN btrim(c81::text) ~ '^[0-9]+(\\.[0-9]+)?$' THEN btrim(c81::text)::numeric END cja_factor
      FROM kepler_ods.kdii
     WHERE btrim(coalesce(c1::text,'')) <> ''
     ORDER BY btrim(c1::text), (sucursal='00') DESC, sucursal),
  w AS (
    SELECT DISTINCT ON (articulo) articulo sku,
           btrim(coalesce(codigo_barras,'')) bc, nullif(btrim(coalesce(unidad_compra,'')),'') u
      FROM wincaja.articulos
     WHERE btrim(coalesce(articulo,'')) <> ''),
  src AS (
    -- Solo barcodes REALES: dígitos, 8..14 (EAN-8/UPC/EAN-13/ITF-14), no todo-ceros.
    -- Descarta códigos internos de Kepler (CB…), letra-envueltos (A…A) y placeholders.
    SELECT sku, pza_bc barcode, coalesce(pza_u,'PZA') unit, 1::numeric factor, 'kepler_pza' source, true is_primary
      FROM k WHERE pza_bc ~ '^[0-9]{8,14}$' AND pza_bc !~ '^0+$'
    UNION ALL
    SELECT sku, cja_bc, coalesce(cja_u,'CJA'), cja_factor, 'kepler_cja', false
      FROM k WHERE cja_bc ~ '^[0-9]{8,14}$' AND cja_bc !~ '^0+$' AND cja_bc <> pza_bc
    UNION ALL
    SELECT sku, bc, coalesce(u,'?'), NULL::numeric, 'wincaja', false
      FROM w WHERE bc ~ '^[0-9]{8,14}$' AND bc !~ '^0+$'),
  dedup AS (
    SELECT DISTINCT ON (sku, barcode) sku, barcode, unit, factor, source, is_primary
      FROM src
     ORDER BY sku, barcode, (source='kepler_pza') DESC, (source='kepler_cja') DESC)`;

async function q(c, sql, args) { return (await c.query(sql, args)).rows; }

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 180000 });
  await c.connect();
  try {
    console.log(`=== import-product-barcodes (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);

    // Cobertura de lo que se generaría
    const cov = await q(c, `${SRC_CTE}
      SELECT
        count(*)                                   AS filas,
        count(DISTINCT sku)                        AS skus,
        count(*) FILTER (WHERE source='kepler_pza') AS pza,
        count(*) FILTER (WHERE source='kepler_cja') AS cja,
        count(*) FILTER (WHERE source='wincaja')    AS wincaja,
        count(DISTINCT sku) FILTER (WHERE source='wincaja'
          AND sku NOT IN (SELECT sku FROM dedup WHERE source LIKE 'kepler%')) AS skus_solo_wincaja
      FROM dedup`);
    console.table(cov);

    const multi = await q(c, `${SRC_CTE}
      SELECT n_barcodes, count(*) skus FROM (
        SELECT sku, count(*) n_barcodes FROM dedup GROUP BY sku
      ) t GROUP BY n_barcodes ORDER BY n_barcodes`);
    console.log('SKUs por # de barcodes:'); console.table(multi);

    if (!APPLY) {
      const ej = await q(c, `${SRC_CTE}
        SELECT sku, barcode, unit, factor, source, is_primary FROM dedup
        WHERE sku IN (SELECT sku FROM dedup GROUP BY sku HAVING count(*)>=2)
        ORDER BY sku, is_primary DESC LIMIT 16`);
      console.log('\nEjemplos (SKUs con ≥2 barcodes):'); console.table(ej);
      console.log('\nDRY-RUN: nada escrito. Corré con --apply (requiere migración aplicada).');
      return;
    }

    // Guard: la tabla debe existir (migración aplicada)
    const has = await q(c, `SELECT 1 FROM information_schema.tables WHERE table_schema='catalog' AND table_name='product_barcodes'`);
    if (!has.length) { console.error('ABORTA: falta catalog.product_barcodes (aplicá la migración 20260818210000).'); process.exit(2); }

    const res = await c.query(`${SRC_CTE}
      INSERT INTO catalog.product_barcodes (tenant_id, sku, barcode, unit, factor, source, is_primary, synced_at, updated_at)
      SELECT $1, sku, barcode, unit, factor, source, is_primary, now(), now() FROM dedup
      ON CONFLICT (tenant_id, sku, barcode) WHERE deleted_at IS NULL
      DO UPDATE SET unit=excluded.unit, factor=excluded.factor, source=excluded.source,
                    is_primary=excluded.is_primary, synced_at=now(), updated_at=now()
        WHERE catalog.product_barcodes.unit IS DISTINCT FROM excluded.unit
           OR catalog.product_barcodes.factor IS DISTINCT FROM excluded.factor
           OR catalog.product_barcodes.source IS DISTINCT FROM excluded.source
           OR catalog.product_barcodes.is_primary IS DISTINCT FROM excluded.is_primary`,
      [TENANT]);
    const tot = await q(c, `SELECT count(*)::int n, count(DISTINCT sku)::int skus FROM catalog.product_barcodes WHERE tenant_id=$1 AND deleted_at IS NULL`, [TENANT]);
    console.log(`\n✓ UPSERT ok (filas afectadas ${res.rowCount}). Total en tabla: ${tot[0].n} barcodes / ${tot[0].skus} SKUs.`);
  } finally { await c.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
