/* eslint-disable no-console */
/**
 * Importer Kepler → catalog.suppliers + products.supplier_id (BULK).
 *
 * Siembra proveedores desde kdig (código=c1, nombre=c2) y enlaza cada producto
 * a su proveedor real vía kdii.c3 → kdig. No toca category_id (deprecado).
 * kdig/kdii son catálogos por-branch SIN columna sucursal (no aplica el gotcha
 * de réplicas de kdil).
 *
 * MULTI-BRANCH (fix): antes leía SOLO md_03 → ~800 productos quedaban sin
 * proveedor porque su ficha (kdii.c3) vive en OTRA sucursal. Ahora recorre las
 * 6 sucursales y UNE: un SKU toma el primer c3 no vacío que encuentre. Reusa el
 * mismo `STOCK_BRANCH_MAP` que stock/reorden ("regla de oro": misma fuente).
 *
 * BULK: staging temp + merge server-side (per-fila contra Railway ~1.2s/query).
 *
 *   node database/importers/kepler/import-kepler-suppliers.js          # dry-run
 *   node database/importers/kepler/import-kepler-suppliers.js --apply
 *
 * Env: DATABASE_URL_NEW (destino). Fuente Kepler (prioridad):
 *   SUPPLIERS_BRANCH_MAP  = JSON ["postgresql://…/md_01", …]  (override explícito)
 *   STOCK_BRANCH_MAP      = JSON [{code,url}, …]              (reuso, recomendado)
 *   SUPPLIERS_BRANCH_URL  = <una sola url>                    (legacy, back-compat)
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

// Lista de sucursales a unir. Prioridad: SUPPLIERS_BRANCH_MAP > STOCK_BRANCH_MAP
// > SUPPLIERS_BRANCH_URL (legacy, una sola) > default 6 sucursales.
const BRANCHES = process.env.SUPPLIERS_BRANCH_MAP
  ? JSON.parse(process.env.SUPPLIERS_BRANCH_MAP)
  : process.env.STOCK_BRANCH_MAP
    ? JSON.parse(process.env.STOCK_BRANCH_MAP).map((b) => b.url)
    : process.env.SUPPLIERS_BRANCH_URL
      ? [process.env.SUPPLIERS_BRANCH_URL]
      : [
          'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00',
          'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01',
          'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02',
          'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03',
          'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04',
          'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05',
        ];

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
  const db = new Client({ connectionString: DST });
  await db.connect();

  try {
    console.log(`\n=== Import proveedores Kepler → suppliers + products.supplier_id (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${BRANCHES.length} sucursal(es) ===\n`);

    // Union de las sucursales alcanzables. supMap: code→name (cualquiera no
    // vacío). linkMap: sku→prov_code (primer c3 no vacío gana; un SKU con c3
    // distinto entre sucursales es raro y se loguea como conflicto).
    const supMap = new Map();
    const linkMap = new Map();
    let conflicts = 0, reached = 0;
    for (const url of BRANCHES) {
      const src = new Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
      const tag = (url.match(/@([^/]+)\/(\w+)/) || [, url, ''])[2] || url;
      try {
        await src.connect();
        const { rows: kg } = await src.query(`SELECT btrim(c1) AS code, btrim(c2) AS name FROM md.kdig WHERE btrim(coalesce(c2,'')) <> ''`);
        const { rows: link } = await src.query(`SELECT c1 AS sku, btrim(c3) AS prov_code FROM md.kdii WHERE NULLIF(btrim(c3),'') IS NOT NULL`);
        for (const g of kg) if (!supMap.has(g.code)) supMap.set(g.code, g.name);
        for (const l of link) {
          const prev = linkMap.get(l.sku);
          if (prev == null) linkMap.set(l.sku, l.prov_code);
          else if (prev !== l.prov_code) conflicts++;
        }
        reached++;
        console.log(`  ✅ ${tag}: ${kg.length} líneas · ${link.length} enlaces sku→prov`);
      } catch (e) {
        console.log(`  ⚠ ${tag}: sin conexión (${e.message}) — skip`);
      } finally {
        await src.end().catch(() => {});
      }
    }
    if (!reached) throw new Error('Ninguna sucursal Kepler alcanzable — abort.');
    const kg = [...supMap].map(([code, name]) => ({ code, name }));
    const link = [...linkMap].map(([sku, prov_code]) => ({ sku, prov_code }));
    console.log(`\n  UNION (${reached}/${BRANCHES.length} sucursales): ${kg.length} proveedores · ${link.length} SKUs enlazados${conflicts ? ` · ⚠ ${conflicts} SKUs con c3 divergente entre sucursales (gana el 1º)` : ''}`);

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
    await db.end();
  }
})();
