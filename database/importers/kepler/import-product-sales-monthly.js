/* eslint-disable no-console */
/**
 * SAL.1 — Feed de VENTA REAL por producto × sucursal × mes → Railway
 * (analytics.product_sales_monthly). Base del reporte /comercial/salidas.
 *
 * Lee los 6 servidores Kepler de sucursal EN VIVO (192.168.x) — NO el snapshot
 * localhost:5433 (desfasado) ni mart.ventas (duplica ×2 por el fanout c4=6/10).
 * Venta = docs `c2='U' c3='D' c4=10`, cantidad = kdm2.c9 (unidades), mes =
 * kdm1.c9. Agrega por (sucursal, sku, mes) y hace DELETE-año + INSERT en Railway.
 *
 *   DST_URL=postgresql://…railway node database/importers/kepler/import-product-sales-monthly.js          # dry-run
 *   DST_URL=…                     node database/importers/kepler/import-product-sales-monthly.js --apply   # commit
 *   ... [--year 2026]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

// code = code de commercial.warehouses/dim.sucursales (00..05)
const BRANCHES = process.env.SALES_BRANCH_MAP
  ? JSON.parse(process.env.SALES_BRANCH_MAP)
  : [
      { code: '00', host: '192.168.9.95', port: 5432, db: 'md_00' },
      { code: '01', host: '192.168.10.10', port: 1977, db: 'md_01' },
      { code: '02', host: '192.168.42.42', port: 5432, db: 'md_02' },
      { code: '03', host: '192.168.40.40', port: 5432, db: 'md_03' },
      { code: '04', host: '192.168.44.44', port: 5432, db: 'md_04' },
      { code: '05', host: '192.168.54.54', port: 5432, db: 'md_05' },
    ];

const SALES = `h.c2='U' AND h.c3='D' AND h.c4=10`;

(async () => {
  const db = new Client({
    connectionString: DST,
    ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false,
  });
  await db.connect();
  try {
    console.log(`\n=== VENTA mensual por producto → analytics.product_sales_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);

    // Tabla (idempotente) — permite correr antes de aplicar la migración formal.
    await db.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await db.query(`CREATE TABLE IF NOT EXISTS analytics.product_sales_monthly (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      product_id uuid NOT NULL, warehouse_id uuid NOT NULL, month date NOT NULL,
      units numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_psm ON analytics.product_sales_monthly (tenant_id, product_id, warehouse_id, month)`);

    // Lookups destino.
    const prods = (await db.query(`SELECT id, sku FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuTo = new Map(prods.map((p) => [p.sku, p.id]));
    const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));
    console.log(`  lookup: ${skuTo.size} products c/sku · ${whTo.size} warehouses`);

    const from = `${YEAR}-01-01`;
    const to = `${YEAR + 1}-01-01`;
    const all = []; // [product_id, warehouse_id, month(date), units]
    let noSku = 0;

    for (const b of BRANCHES) {
      const wid = whTo.get(b.code);
      if (!wid) { console.log(`  ⚠️  sucursal ${b.code} sin warehouse en destino — skip`); continue; }
      const src = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 8000, statement_timeout: 120000 });
      const t0 = Date.now();
      try {
        await src.connect();
        const { rows } = await src.query(
          `SELECT d.c8 AS sku, date_trunc('month', h.c9)::date AS mes, sum(d.c9)::numeric AS units
             FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
            WHERE ${SALES} AND h.c9 >= $1 AND h.c9 < $2
            GROUP BY d.c8, 2`, [from, to]);
        let matched = 0;
        for (const r of rows) {
          const pid = skuTo.get(r.sku);
          if (!pid) { noSku++; continue; }
          all.push([pid, wid, r.mes, r.units]);
          matched++;
        }
        console.log(`  ✅ ${b.db} (${b.code}): ${rows.length} filas sku×mes → ${matched} match (${Date.now() - t0}ms)`);
      } catch (e) {
        console.log(`  ❌ ${b.db} (${b.code}): ${e.message}`);
      } finally {
        try { await src.end(); } catch { /* noop */ }
      }
    }
    console.log(`\n  total a cargar: ${all.length} (sku sin catálogo: ${noSku})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_psm (product_id uuid, warehouse_id uuid, month date, units numeric) ON COMMIT DROP`);
    const BATCH = 2000;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => { const b = ri * 4; vals.push(`($${b+1},$${b+2},$${b+3},$${b+4})`); params.push(...row); });
      await db.query(`INSERT INTO stg_psm VALUES ${vals.join(',')}`, params);
    }
    // El DELETE NO debe tocar las tiendas SOLO-Wincaja (MD-30/32/50): las alimenta
    // import-wincaja-product-sales.js (aditivo, Kepler ciego a ellas). Sin esta
    // exclusión, este feed Kepler las borraba en cada corrida → desaparecían de /salidas.
    await db.query(
      `DELETE FROM analytics.product_sales_monthly WHERE tenant_id=$1 AND month >= $2 AND month < $3
         AND warehouse_id NOT IN (
           SELECT id FROM commercial.warehouses
           WHERE tenant_id=$1 AND code IN ('MD-30','MD-32','MD-50') AND deleted_at IS NULL)`,
      [M, from, to]);
    const up = await db.query(
      `INSERT INTO analytics.product_sales_monthly (id, tenant_id, product_id, warehouse_id, month, units, updated_at)
       SELECT gen_random_uuid(), $1, product_id, warehouse_id, month, sum(units), now()
         FROM stg_psm GROUP BY product_id, warehouse_id, month`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas en analytics.product_sales_monthly.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
