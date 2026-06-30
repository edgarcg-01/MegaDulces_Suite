/* eslint-disable no-console */
/**
 * Stock VIVO de PH (Sucursal Hidalgo, md_01) → commercial.stock MD-10.
 *
 * Los vendedores se surten SOLO de PH; necesitan disponibilidad real para no
 * prometer lo que no hay. Esta es la fuente autoritativa de MD-10 (el nightly
 * mega_dulces_sync ya NO escribe MD-10 — ver WAREHOUSE_COLUMN_MAP).
 *
 * Fuente: md_01.kdil (c3=sku, c9=existencia). READ-ONLY (rol platform_ro).
 * Destino: commercial.stock (tenant mega_dulces, warehouse MD-10).
 * Reset atómico a 0 + upsert desde kdil → refleja exacto el PH vivo.
 *
 *   node database/importers/kepler/import-ph-stock-live.js          # dry-run
 *   node database/importers/kepler/import-ph-stock-live.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
// Código del almacén PH varía por entorno: local dev usa 'MD-10', prod usa '01'.
const WH_CODE = process.env.PH_WAREHOUSE_CODE || 'MD-10';
const SRC = process.env.PH_BRANCH_URL || 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Stock vivo PH (md_01) → ${WH_CODE} (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Existencia viva por SKU en PH (clamp a 0; nunca negativo).
    const { rows: stock } = await src.query(
      `SELECT c3 AS sku, GREATEST(c9, 0)::numeric AS qty FROM md.kdil WHERE c3 IS NOT NULL`,
    );
    console.log(`SKUs en PH (kdil): ${stock.length}`);

    const { rows: whr } = await db.query(
      `SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [M, WH_CODE]);
    if (!whr.length) throw new Error(`Warehouse ${WH_CODE} no existe en commercial.warehouses`);
    const whId = whr[0].id;

    const { rows: prods } = await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1`, [M]);
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // Reset a 0 lo existente de MD-10 (lo que ya no esté en kdil queda en 0).
    const { rowCount: reset } = await db.query(
      `UPDATE commercial.stock SET quantity=0, updated_at=now() WHERE tenant_id=$1 AND warehouse_id=$2 AND quantity<>0`,
      [M, whId]);

    let upserted = 0, unmatched = 0, conStock = 0;
    for (const r of stock) {
      const pid = skuToId.get(r.sku);
      if (!pid) { unmatched++; continue; }
      if (Number(r.qty) > 0) conStock++;
      await db.query(
        `INSERT INTO commercial.stock (id, tenant_id, warehouse_id, product_id, quantity, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, now())
         ON CONFLICT (tenant_id, warehouse_id, product_id)
         DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`,
        [M, whId, pid, r.qty]);
      upserted++;
    }

    console.log(`Reset a 0: ${reset} · Upserted: ${upserted} (con stock>0: ${conStock} · sin match catálogo: ${unmatched})`);

    if (APPLY) {
      await db.query('COMMIT');
      console.log(`\n[APPLY] COMMIT — ${WH_CODE} refleja el PH vivo.`);
    } else {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
