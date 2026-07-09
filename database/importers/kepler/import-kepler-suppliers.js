/* eslint-disable no-console */
/**
 * Importer Kepler → catalog.suppliers + products.supplier_id (BULK).
 *
 * Siembra proveedores desde kdig (código=c1, nombre=c2) y enlaza cada producto
 * a su proveedor real vía kdii.c3 → kdig. No toca category_id (deprecado).
 * kdig/kdii son catálogos por-branch SIN columna sucursal (no aplica el gotcha
 * de réplicas de kdil); se lee del branch más completo (md_03 default).
 *
 * BULK: staging temp + merge server-side (per-fila contra Railway ~1.2s/query).
 *
 *   node database/importers/kepler/import-kepler-suppliers.js          # dry-run
 *   node database/importers/kepler/import-kepler-suppliers.js --apply
 *
 * Env: DATABASE_URL_NEW (destino), SUPPLIERS_BRANCH_URL (fuente Kepler).
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.SUPPLIERS_BRANCH_URL || 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

async function stage(db, table, cols, rows) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((row, ri) => {
      vals.push(`(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
      params.push(...row);
    });
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${vals.join(',')}`, params);
  }
}

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();

  try {
    console.log(`\n=== Import proveedores Kepler → suppliers + products.supplier_id (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: kg } = await src.query(`SELECT btrim(c1) AS code, btrim(c2) AS name FROM md.kdig WHERE c2 <> '' ORDER BY c1`);
    const { rows: link } = await src.query(`SELECT c1 AS sku, btrim(c3) AS prov_code FROM md.kdii WHERE NULLIF(btrim(c3),'') IS NOT NULL`);
    console.log(`  kdig proveedores: ${kg.length} · kdii enlaces sku→prov: ${link.length}`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_sup (code text, name text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_link (sku text, prov_code text) ON COMMIT DROP`);
    await stage(db, 'stg_sup', ['code', 'name'], kg.map((g) => [g.code, g.name]));
    await stage(db, 'stg_link', ['sku', 'prov_code'], link.map((l) => [l.sku, l.prov_code]));

    // 1) Upsert proveedores (server-side)
    const up = await db.query(`
      INSERT INTO catalog.suppliers (tenant_id, code, name)
      SELECT $1, s.code, max(s.name) FROM stg_sup s GROUP BY s.code
      ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`, [M]);

    // 2) Enlazar products.supplier_id (server-side, solo cambios)
    const ln = await db.query(`
      UPDATE catalog.products p
         SET supplier_id = s.id, updated_at = now()
        FROM stg_link l
        JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.code=l.prov_code
       WHERE p.tenant_id=$1 AND p.sku=l.sku
         AND p.supplier_id IS DISTINCT FROM s.id`, [M]);

    console.log(`  proveedores upsert: ${up.rowCount} · productos (re)enlazados: ${ln.rowCount}`);
    const { rows: top } = await db.query(
      `SELECT s.name, count(*) n FROM catalog.products p JOIN catalog.suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
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
