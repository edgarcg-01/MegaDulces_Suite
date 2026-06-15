/* eslint-disable no-console */
/**
 * Importer Kepler → catalog.suppliers + products.supplier_id.
 *
 * Siembra proveedores desde kdig (código=c1, nombre=c2) y enlaza cada producto
 * a su proveedor real vía kdii.c3 → kdig. No toca category_id (deprecado).
 *
 *   node database/importers/kepler/import-kepler-suppliers.js          # dry-run
 *   node database/importers/kepler/import-kepler-suppliers.js --apply
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const APPLY = process.argv.includes('--apply');

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Import proveedores Kepler → suppliers + products.supplier_id (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: kg } = await src.query(`SELECT c1 AS code, c2 AS name FROM md.kdig WHERE c2 <> '' ORDER BY c1`);
    const { rows: link } = await src.query(`SELECT c1 AS sku, NULLIF(c3,'') AS prov_code FROM md.kdii WHERE NULLIF(c3,'') IS NOT NULL`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);

    // 1) Upsert proveedores
    let sup = 0;
    for (const g of kg) {
      await db.query(
        `INSERT INTO catalog.suppliers (tenant_id, code, name) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`,
        [M, g.code.trim(), g.name.trim()]);
      sup++;
    }
    // code → supplier_id
    const { rows: sids } = await db.query(`SELECT id, code FROM catalog.suppliers WHERE tenant_id=$1`, [M]);
    const codeToSid = new Map(sids.map((s) => [s.code, s.id]));

    // sku → product_id
    const { rows: prods } = await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1`, [M]);
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));

    // 2) Enlazar products.supplier_id
    let linked = 0, noProd = 0, noSup = 0;
    for (const l of link) {
      const pid = skuToId.get(l.sku);
      if (!pid) { noProd++; continue; }
      const sid = codeToSid.get(l.prov_code.trim());
      if (!sid) { noSup++; continue; }
      const r = await db.query(`UPDATE catalog.products SET supplier_id=$1, updated_at=now() WHERE id=$2 AND tenant_id=$3`, [sid, pid, M]);
      if (r.rowCount) linked++;
    }

    console.log(`Proveedores upsert: ${sup}`);
    console.log(`Productos enlazados a proveedor: ${linked} (sin producto: ${noProd}, sin proveedor en catálogo: ${noSup})`);
    const { rows: top } = await db.query(
      `SELECT s.name, count(*) n FROM catalog.products p JOIN catalog.suppliers s ON s.id=p.supplier_id
        WHERE p.tenant_id=$1 GROUP BY s.name ORDER BY n DESC LIMIT 8`, [M]);
    console.log('\nTop proveedores por # productos:');
    top.forEach((r) => console.log(`  ${String(r.n).padStart(5)}  ${r.name}`));

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
