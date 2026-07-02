/* eslint-disable no-console */
/**
 * SAL.5.2 — Feed de VENTA REAL por producto × sucursal × DÍA → Railway
 * (analytics.product_sales_daily). Habilita el modo RANGO del reporte
 * /comercial/salidas (Últimos 7/15/30 días + personalizado).
 *
 * MISMO join + filtro que import-product-sales-monthly.js (para que el diario
 * sume EXACTO al mensual): venta = `c2='U' c3='D' c4=10`, unidades = kdm2.c9,
 * join (c1,c4,c5,c6). Lee los 6 servidores Kepler de sucursal EN VIVO.
 *
 * UPSERT acumulativo con GREATEST — las sucursales purgan historia (PH ~días);
 * un día ya cerrado es estable, el día en curso solo sube. Ventana por lookback
 * (default 180 días) para acotar volumen; el modo Año del reporte sigue usando
 * product_sales_monthly para historia completa.
 *
 *   DST_URL=…railway node database/importers/kepler/import-product-sales-daily.js            # dry-run (180d)
 *   DST_URL=…         node database/importers/kepler/import-product-sales-daily.js --apply    # commit
 *   ... [--days 180]
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const di = process.argv.indexOf('--days');
const DAYS = di !== -1 ? Number(process.argv[di + 1]) : 180;

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
    const from = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
    console.log(`\n=== VENTA diaria por producto → analytics.product_sales_daily (${APPLY ? 'APPLY' : 'DRY-RUN'}, desde ${from}, ${DAYS}d) ===\n`);

    await db.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await db.query(`CREATE TABLE IF NOT EXISTS analytics.product_sales_daily (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
      product_id uuid NOT NULL, warehouse_id uuid NOT NULL, sale_date date NOT NULL,
      units numeric NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now())`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_psd ON analytics.product_sales_daily (tenant_id, product_id, warehouse_id, sale_date)`);

    const prods = (await db.query(`SELECT id, sku FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuTo = new Map(prods.map((p) => [p.sku, p.id]));
    const whs = (await db.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));
    console.log(`  lookup: ${skuTo.size} products c/sku · ${whTo.size} warehouses`);

    const all = []; // [product_id, warehouse_id, sale_date, units]
    let noSku = 0;

    for (const b of BRANCHES) {
      const wid = whTo.get(b.code);
      if (!wid) { console.log(`  ⚠️  sucursal ${b.code} sin warehouse en destino — skip`); continue; }
      const src = new Client({ host: b.host, port: b.port, database: b.db, user: 'platform_ro', password: 'kepler123', connectionTimeoutMillis: 8000, statement_timeout: 180000 });
      const t0 = Date.now();
      try {
        await src.connect();
        const { rows } = await src.query(
          `SELECT d.c8 AS sku, h.c9::date AS dia, sum(d.c9)::numeric AS units
             FROM md.kdm2 d JOIN md.kdm1 h ON h.c1=d.c1 AND h.c4=d.c4 AND h.c5=d.c5 AND h.c6=d.c6
            WHERE ${SALES} AND h.c9 >= $1
              AND d.c8 NOT IN ('00001','00002') AND btrim(d.c8) <> ''
            GROUP BY d.c8, 2`, [from]);
        let matched = 0;
        for (const r of rows) {
          const pid = skuTo.get(r.sku);
          if (!pid) { noSku++; continue; }
          all.push([pid, wid, r.dia, r.units]);
          matched++;
        }
        console.log(`  ✅ ${b.db} (${b.code}): ${rows.length} filas sku×día → ${matched} match (${Date.now() - t0}ms)`);
      } catch (e) {
        console.log(`  ❌ ${b.db} (${b.code}): ${e.message}`);
      } finally {
        try { await src.end(); } catch { /* noop */ }
      }
    }
    console.log(`\n  total a upsert: ${all.length} (sku sin catálogo: ${noSku})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const BATCH = 1000;
    let up = 0;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      // 5 params por fila: tenant + [product_id, warehouse_id, sale_date, units]
      const vals = chunk.map((_, ri) => { const b = ri * 5; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`; });
      const params = []; chunk.forEach((row) => params.push(M, row[0], row[1], row[2], row[3]));
      const res = await db.query(
        `INSERT INTO analytics.product_sales_daily (tenant_id, product_id, warehouse_id, sale_date, units)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, product_id, warehouse_id, sale_date) DO UPDATE SET
           units = GREATEST(analytics.product_sales_daily.units, EXCLUDED.units),
           updated_at = now()`, params);
      up += res.rowCount;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up} filas upserted en analytics.product_sales_daily.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
