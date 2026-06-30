/* eslint-disable no-console */
/**
 * Sync de PRECIOS Kepler → commercial.product_prices, MODO BULK (rápido vs prod).
 *
 * Réplica del scope `prices` de mega_dulces_sync pero staging+merge (per-fila
 * contra prod = ~14h; bulk = <2min). Fuente: catalogo_etiquetas ⋈ productos_activos
 * (solo activos). 5 listas: MAYOREO←precio_mayoreo, P1..P4←p_1..p_4 (+ p_X_ca = min_qty).
 * tax_rate = products.iva_rate (default 0.16). Constraint (tenant,price_list,product).
 *
 *   node database/importers/import-prices-bulk.js          # dry-run
 *   node database/importers/import-prices-bulk.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.MEGA_DULCES_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/Mega_Dulces';
const DST = process.env.DATABASE_URL_NEW;
const APPLY = process.argv.includes('--apply');
const BATCH = 2000;
const PLS = [
  { code: 'MAYOREO', col: 'precio_mayoreo', qcol: null },
  { code: 'P1', col: 'p_1', qcol: 'p_1_ca' },
  { code: 'P2', col: 'p_2', qcol: 'p_2_ca' },
  { code: 'P3', col: 'p_3', qcol: 'p_3_ca' },
  { code: 'P4', col: 'p_4', qcol: 'p_4_ca' },
];

(async () => {
  if (!DST) throw new Error('DATABASE_URL_NEW obligatorio.');
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect(); await db.connect();
  try {
    console.log(`\n=== Precios Kepler → product_prices (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const { rows: et } = await src.query(`
      SELECT et.articulo, et.precio_mayoreo, et.p_1, et.p_1_ca, et.p_2, et.p_2_ca,
             et.p_3, et.p_3_ca, et.p_4, et.p_4_ca
      FROM catalogo_etiquetas et JOIN productos_activos pa ON pa.articulo = et.articulo`);
    console.log(`  source .245: ${et.length} etiquetas (activos)`);

    const plById = new Map();
    for (const pl of (await db.query(`SELECT id, code FROM commercial.price_lists WHERE tenant_id=$1`, [M])).rows) plById.set(pl.code, pl.id);
    const prodBySku = new Map();
    for (const p of (await db.query(`SELECT id, sku, iva_rate FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows) prodBySku.set(p.sku, p);
    console.log(`  lookup prod: ${plById.size} price_lists × ${prodBySku.size} products`);

    const num = (v) => (v == null || v === '' ? 0 : Number(v));
    const rows = []; let skip = 0;
    for (const r of et) {
      const p = prodBySku.get(String(r.articulo).trim());
      if (!p) { skip++; continue; }
      const tax = p.iva_rate != null ? Number(p.iva_rate) : 0.16;
      for (const pl of PLS) {
        const price = num(r[pl.col]);
        if (price <= 0) continue;
        const plId = plById.get(pl.code);
        if (!plId) continue;
        const minQty = pl.qcol && r[pl.qcol] != null ? Math.max(1, num(r[pl.qcol])) : 1;
        rows.push([plId, p.id, price, tax, minQty]);
      }
    }
    console.log(`  filas de precio a cargar: ${rows.length} (skip ${skip} sin producto en prod)`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_px (price_list_id uuid, product_id uuid, price numeric, tax_rate numeric, min_qty numeric) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => { vals.push(`($${ri*5+1},$${ri*5+2},$${ri*5+3},$${ri*5+4},$${ri*5+5})`); params.push(...row); });
      await db.query(`INSERT INTO stg_px VALUES ${vals.join(',')}`, params);
    }
    console.log(`  staging cargado: ${rows.length}`);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK.'); return; }

    const up = await db.query(`
      INSERT INTO commercial.product_prices (id, tenant_id, price_list_id, product_id, price, tax_rate, min_qty, created_at, updated_at)
      SELECT gen_random_uuid(), $1, s.price_list_id, s.product_id, s.price, s.tax_rate, s.min_qty, now(), now()
      FROM (SELECT DISTINCT ON (price_list_id, product_id) * FROM stg_px ORDER BY price_list_id, product_id) s
      ON CONFLICT (tenant_id, price_list_id, product_id)
      DO UPDATE SET price=EXCLUDED.price, tax_rate=EXCLUDED.tax_rate, min_qty=EXCLUDED.min_qty, updated_at=now(), deleted_at=NULL`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} precios upserted.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await src.end(); await db.end(); }
})();
