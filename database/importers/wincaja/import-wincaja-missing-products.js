/* eslint-disable no-console */
/**
 * RS.8 — Productos de Wincaja faltantes en el catálogo → catalog.products.
 *
 * ~1,219 SKUs se venden en Wincaja (Morelia/Canindo/legacy) pero NO existen en
 * catalog.products (`in_kepler_catalog=false`) → el feed de ventas los DESCARTA en el
 * JOIN (product_id requerido) → ~$9.26M de venta que no aparece en sell-out.
 *
 * Este importer los crea desde wincaja.articulos: sku=articulo, nombre, barcode (codigo
 * _barras si es EAN válido), unit_sale/factor_sale de la ficha, marca fallback = "PRODUCTOS
 * VARIOS" (997) — reclasificables luego. Idempotente (solo crea los que faltan). Tras
 * correrlo, re-correr import-wincaja-analytics para que los levante (matchea por sku).
 *
 *   node database/importers/wincaja/import-wincaja-missing-products.js          # dry-run
 *   node database/importers/wincaja/import-wincaja-missing-products.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const eanOk = (v) => { const s = String(v || '').trim(); return /^\d{13}$/.test(s) || /^\d{12}$/.test(s) || /^\d{8}$/.test(s); };

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Productos Wincaja faltantes → catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const brand = (await db.query(`SELECT id FROM catalog.brands WHERE tenant_id=$1 AND code='997' AND deleted_at IS NULL`, [M])).rows[0];
    if (!brand) throw new Error('marca fallback "PRODUCTOS VARIOS" (997) no existe');

    // SKUs vendidos en Wincaja SIN producto en catálogo + su ficha (dedup por articulo).
    // Scope = el MISMO del feed de ventas (wincaja_only + blends PH/LP/Yure/Zamora) y solo
    // SKUs con venta real → creamos exactamente los que el feed descarta (~$9.26M), sin basura.
    const rows = (await db.query(`
      WITH sold AS (
        SELECT sku, sum(importe) rev FROM wincaja.v_sales_lines
         WHERE tenant_id=$1 AND ( wincaja_only=true
               OR (source_branch='10' AND business_date < DATE '2026-07-01')
               OR (source_branch='42' AND business_date < DATE '2025-10-01')
               OR (source_branch='44' AND business_date < DATE '2026-02-18')
               OR (source_branch='54' AND business_date < DATE '2026-03-16') )
         GROUP BY sku HAVING sum(importe) > 0),
      art AS (SELECT DISTINCT ON (articulo) articulo, btrim(nombre) nombre, btrim(codigo_barras) barcode,
                     upper(btrim(coalesce(unidad_venta,''))) unidad, factor_venta
                FROM wincaja.articulos WHERE tenant_id=$1 ORDER BY articulo, source_dataset DESC)
      SELECT s.sku, a.nombre, a.barcode, a.unidad, a.factor_venta, round(s.rev) rev
        FROM sold s
        JOIN art a ON a.articulo = s.sku
       WHERE btrim(coalesce(a.nombre,'')) <> ''
         AND NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1 AND p.sku = s.sku AND p.deleted_at IS NULL)
       ORDER BY s.rev DESC`, [M])).rows;
    const totalRev = rows.reduce((a, r) => a + Number(r.rev || 0), 0);
    console.log(`  venta que recuperan estos productos: $${Math.round(totalRev).toLocaleString()}`);
    console.log(`  candidatos a crear: ${rows.length}`);
    if (rows.length) console.table(rows.slice(0, 8).map((r) => ({ sku: r.sku, nombre: (r.nombre || '').slice(0, 34), u: r.unidad, fac: r.factor_venta })));

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    let n = 0, skip = 0;
    for (const r of rows) {
      const barcode = eanOk(r.barcode) ? String(r.barcode).trim() : null;
      const factor = Number(r.factor_venta) > 1 ? Math.round(Number(r.factor_venta)) : null;
      const res = await db.query(`
        INSERT INTO catalog.products (id, tenant_id, brand_id, sku, nombre, barcode, unit_sale, factor_sale, is_promo, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, false, now(), now())
        ON CONFLICT (tenant_id, brand_id, nombre) DO NOTHING`,
        [M, brand.id, r.sku, r.nombre, barcode, r.unidad || null, factor]);
      if (res.rowCount) n++; else skip++;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${n} productos creados (${skip} saltados por nombre duplicado).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
