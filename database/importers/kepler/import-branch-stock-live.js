/* eslint-disable no-console */
/**
 * Stock VIVO multi-sucursal → commercial.stock, en MODO BULK (rápido vs prod).
 *
 * Reemplaza/generaliza import-ph-stock-live.js (que era PH solo + per-fila).
 * Lee kdil de cada sucursal (READ-ONLY platform_ro), arma staging y hace UN
 * merge server-side por almacén (reset a 0 + upsert). De ~3h a <1 min en prod.
 *
 * Mapeo code→sucursal (prod usa 01/02/03 = las operativas):
 *   01 Padre Hidalgo (PH) ← md_01 · 02 La Piedad Abastos ← md_02 · 03 8ESQ ← md_03
 * Override con env STOCK_BRANCH_MAP (JSON [{code,url}]).
 *
 *   node database/importers/kepler/import-branch-stock-live.js          # dry-run
 *   node database/importers/kepler/import-branch-stock-live.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Stock vivo multi-sucursal → commercial.stock (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const prods = (await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo prod con sku: ${skuToId.size}`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_stock (code text, product_id uuid, quantity numeric) ON COMMIT DROP`);

    const summary = [];
    for (const m of MAP) {
      const whr = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [M, m.code])).rows;
      if (!whr.length) { console.log(`  ⚠ warehouse ${m.code} no existe — skip`); continue; }

      const src = new Client({ connectionString: m.url });
      await src.connect();
      let matched = 0, unmatched = 0;
      try {
        const stock = (await src.query(`SELECT c3 AS sku, GREATEST(c9,0)::numeric AS qty FROM md.kdil WHERE c3 IS NOT NULL`)).rows;
        const rows = [];
        for (const r of stock) {
          const pid = skuToId.get(r.sku);
          if (!pid) { unmatched++; continue; }
          rows.push([m.code, pid, r.qty]); matched++;
        }
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH);
          const vals = [], params = [];
          chunk.forEach((row, ri) => { vals.push(`($${ri*3+1},$${ri*3+2},$${ri*3+3})`); params.push(row[0], row[1], row[2]); });
          await db.query(`INSERT INTO stg_stock (code, product_id, quantity) VALUES ${vals.join(',')}`, params);
        }
        summary.push({ code: m.code, matched, unmatched, conStock: rows.filter((r) => Number(r[2]) > 0).length });
      } finally { await src.end(); }
    }
    console.table(summary);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    // Merge server-side: reset a 0 los almacenes tocados + upsert desde staging.
    await db.query(`
      UPDATE commercial.stock s SET quantity=0, updated_at=now()
      FROM commercial.warehouses w
      WHERE s.tenant_id=$1 AND s.warehouse_id=w.id AND w.code IN (SELECT DISTINCT code FROM stg_stock) AND s.quantity<>0`, [M]);
    // Sumar existencia por (almacén, producto) — kdil puede tener varias filas
    // por SKU (sub-ubicaciones) → evita "ON CONFLICT affect row twice".
    const up = await db.query(`
      INSERT INTO commercial.stock (id, tenant_id, warehouse_id, product_id, quantity, updated_at)
      SELECT gen_random_uuid(), $1, w.id, agg.product_id, agg.qty, now()
      FROM (SELECT code, product_id, sum(quantity) AS qty FROM stg_stock GROUP BY code, product_id) agg
      JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.code=agg.code
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas de stock upserted (${summary.length} almacenes).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
