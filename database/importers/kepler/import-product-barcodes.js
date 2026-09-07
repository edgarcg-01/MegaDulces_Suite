/* eslint-disable no-console */
/**
 * BACKSTOP RECONCILIADOR de códigos de barras por UNIDAD — `import-product-barcodes.js`.
 *
 * ⚠️ La VÍA PRINCIPAL es el hop-2 ODS (`normalizeBarcodesFromOds` en services/feeds-ingest/apply-handlers.js),
 * que recomputa al-momento cuando cambia `kdii` (feedback_everything_derivable_from_ods). Este importer
 * es solo el reconciliador full-catálogo + la fuente Wincaja (que NO está en el ODS).
 *
 * Puebla `catalog.product_barcodes` (1 SKU → N barcodes) uniendo:
 *   - Kepler `kepler_ods.kdii` vía `computeBarcodes` (single source of truth del mapeo por unidad:
 *       BASE c11 = c7+c93 · U2 c80 = c82+c95 · U3 c83 = c85). Verificado 2026-08-25.
 *   - Wincaja `articulos.codigo_barras` (unidad_compra) → el de su unidad [source wincaja].
 *
 * Dedup por (sku, barcode): precedencia kepler_base > kepler_u2 > kepler_u3 > wincaja.
 * UPSERT churn-free (no borra por defecto; el hop-2 hace el soft-delete de stale por SKU).
 *
 *   DATABASE_URL_NEW = prod (kepler_ods + wincaja + catalog viven ahí mismo)
 *   node database/importers/kepler/import-product-barcodes.js            # DRY-RUN (cuenta, no escribe)
 *   node database/importers/kepler/import-product-barcodes.js --apply    # UPSERT
 *
 * Env: CRON_TENANT_ID (default mega_dulces).
 */
const { Client } = require('pg');
const { computeBarcodes, realBarcode } = require('../../../services/feeds-ingest/barcode-compute');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const SRC_RANK = { kepler_base: 0, kepler_u2: 1, kepler_u3: 2, wincaja: 3 };

async function q(c, sql, args) { return (await c.query(sql, args)).rows; }

(async () => {
  const c = new Client({ connectionString: DST, statement_timeout: 300000 });
  await c.connect();
  try {
    console.log(`=== import-product-barcodes RECONCILIADOR (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);

    // 1) Kepler por unidad — MISMA lógica que el hop-2 (single source of truth).
    const kepler = await computeBarcodes(c, { schema: 'kepler_ods' });

    // 2) Wincaja (NO está en ODS): barcode de su unidad de compra.
    const wc = await q(c, `
      SELECT DISTINCT ON (btrim(articulo)) btrim(articulo) sku,
             btrim(coalesce(codigo_barras,'')) bc, nullif(btrim(coalesce(unidad_compra,'')),'') u
        FROM wincaja.articulos WHERE btrim(coalesce(articulo,'')) <> ''`);
    const wincaja = [];
    for (const r of wc) {
      const bc = realBarcode(r.bc, r.sku);
      if (!bc) continue;
      wincaja.push({ sku: r.sku, barcode: bc, unit: (r.u || '?').toUpperCase(), factor: null, source: 'wincaja', is_primary: false });
    }

    // 3) Dedup por (sku, barcode) con precedencia.
    const seen = new Map();
    for (const b of [...kepler, ...wincaja]) {
      const k = `${b.sku} ${b.barcode}`;
      const cur = seen.get(k);
      if (!cur || SRC_RANK[b.source] < SRC_RANK[cur.source]) seen.set(k, b);
    }
    const rows = Array.from(seen.values());

    const byUnit = {}; const byN = {};
    for (const r of rows) byUnit[r.source] = (byUnit[r.source] || 0) + 1;
    const perSku = {};
    for (const r of rows) perSku[r.sku] = (perSku[r.sku] || 0) + 1;
    for (const n of Object.values(perSku)) byN[n] = (byN[n] || 0) + 1;
    console.log(`  filas: ${rows.length} · SKUs: ${Object.keys(perSku).length} · por fuente:`, byUnit);
    console.log('  SKUs por # de barcodes:', byN);

    if (!APPLY) {
      console.table(rows.filter((r) => perSku[r.sku] >= 2).slice(0, 16));
      console.log('\nDRY-RUN: nada escrito. Corré con --apply (requiere migración 20260818210000).');
      return;
    }

    const has = await q(c, `SELECT 1 FROM information_schema.tables WHERE table_schema='catalog' AND table_name='product_barcodes'`);
    if (!has.length) { console.error('ABORTA: falta catalog.product_barcodes (aplicá la migración 20260818210000).'); process.exit(2); }

    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${TENANT}'`);
    await c.query(`CREATE TEMP TABLE stg_bc (
      sku text, barcode text, unit text, factor numeric, source text, is_primary boolean) ON COMMIT DROP`);
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((r, ri) => {
        const b = ri * 6;
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(r.sku, r.barcode, r.unit, r.factor, r.source, r.is_primary);
      });
      await c.query(`INSERT INTO stg_bc VALUES ${vals.join(',')}`, params);
    }
    const up = await c.query(`
      INSERT INTO catalog.product_barcodes (id, tenant_id, sku, barcode, unit, factor, source, is_primary, synced_at, updated_at)
      SELECT gen_random_uuid(), $1, s.sku, s.barcode, s.unit, s.factor, s.source, s.is_primary, now(), now() FROM stg_bc s
      ON CONFLICT (tenant_id, sku, barcode) WHERE deleted_at IS NULL DO UPDATE SET
        unit=EXCLUDED.unit, factor=EXCLUDED.factor, source=EXCLUDED.source,
        is_primary=EXCLUDED.is_primary, synced_at=now(), updated_at=now()
      WHERE (catalog.product_barcodes.unit, catalog.product_barcodes.factor,
             catalog.product_barcodes.source, catalog.product_barcodes.is_primary)
            IS DISTINCT FROM (EXCLUDED.unit, EXCLUDED.factor, EXCLUDED.source, EXCLUDED.is_primary)`,
      [TENANT]);
    // Soft-delete global de kepler_* que ya no salen de Kepler (reconciliación full-catálogo).
    const del = await c.query(`
      UPDATE catalog.product_barcodes p SET deleted_at=now(), updated_at=now()
       WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.source LIKE 'kepler\\_%'
         AND NOT EXISTS (SELECT 1 FROM stg_bc s WHERE s.sku=btrim(p.sku) AND s.barcode=p.barcode)`,
      [TENANT]);
    await c.query('COMMIT');
    const tot = await q(c, `SELECT count(*)::int n, count(DISTINCT sku)::int skus FROM catalog.product_barcodes WHERE tenant_id=$1 AND deleted_at IS NULL`, [TENANT]);
    console.log(`\n✓ UPSERT ok (${up.rowCount} cambiadas, ${del.rowCount} stale soft-deleted). Total: ${tot[0].n} barcodes / ${tot[0].skus} SKUs.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('ERR', e.message); process.exitCode = 1;
  } finally { await c.end(); }
})();
