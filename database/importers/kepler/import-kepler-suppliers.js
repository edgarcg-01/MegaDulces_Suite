/* eslint-disable no-console */
/**
 * Importer Kepler → catalog.suppliers + products.supplier_id (BULK).
 *
 * FUENTE CORRECTA (fix 2026-07-17): el PROVEEDOR REAL vive en
 *   - `md.kdxd`          = catálogo de proveedores (c2=código, c3=nombre, c10=RFC)
 *   - `md.kdpv_prov_prod` = relación proveedor→producto (c1=código prov, c2=SKU)
 *
 * ANTES (bug): leía `md.kdig` (c1/c2) que es el catálogo de **LÍNEAS** (=marca), y
 * enlazaba por `kdii.c3` (la línea del producto). Como import-brands-lineas.js usa
 * la MISMA kdig, el "proveedor" salía IDÉNTICO a la marca (supplier_id==brand_id en
 * 78% del catálogo). Ej: SKU 24007 (YOHARI) → proveedor real CP033 = "PRODUCTOS
 * TECHANI", pero el catálogo lo ponía en la línea 015 "Dulces Chompys".
 *
 * kdpv_prov_prod es ~1:1 (9,346 SKUs, solo 3 con >1 proveedor → gana el 1º). El
 * proveedor "00001" = "PRODUCTOS SIN PROVEEDOR ASIGNADO" (marcador Kepler; se
 * importa tal cual, es más honesto que dejar un proveedor equivocado).
 *
 * MULTI-BRANCH: kdxd/kdpv_prov_prod son por-sucursal (catálogos sin columna
 * sucursal). Se recorren las 6 y se UNEN: un código de proveedor toma el primer
 * nombre no vacío; un SKU toma el primer proveedor no vacío que aparezca.
 *
 * NO toca products sin entrada en kdpv_prov_prod (conservan su supplier_id actual;
 * se reporta el conteo). NO borra los suppliers viejos huérfanos (quedan con 0
 * productos; su limpieza es decisión aparte).
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
    console.log(`\n=== Import PROVEEDOR REAL Kepler (kdxd + kdpv_prov_prod) → suppliers + products.supplier_id (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${BRANCHES.length} sucursal(es) ===\n`);

    const supMap = new Map();   // code -> name (proveedor real, kdxd)
    const linkMap = new Map();  // sku  -> prov_code (kdpv_prov_prod)
    let conflicts = 0, reached = 0;
    for (const url of BRANCHES) {
      const src = new Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
      const tag = (url.match(/@([^/]+)\/(\w+)/) || [, url, ''])[2] || url;
      try {
        await src.connect();
        const { rows: xd } = await src.query(
          `SELECT btrim(c2) AS code, btrim(c3) AS name FROM md.kdxd
            WHERE btrim(coalesce(c2,'')) <> '' AND btrim(coalesce(c3,'')) <> ''`);
        const { rows: link } = await src.query(
          `SELECT btrim(c2) AS sku, btrim(c1) AS prov_code FROM md.kdpv_prov_prod
            WHERE NULLIF(btrim(c1),'') IS NOT NULL AND NULLIF(btrim(c2),'') IS NOT NULL`);
        for (const g of xd) if (!supMap.has(g.code)) supMap.set(g.code, g.name);
        for (const l of link) {
          const prev = linkMap.get(l.sku);
          if (prev == null) linkMap.set(l.sku, l.prov_code);
          else if (prev !== l.prov_code) conflicts++;
        }
        reached++;
        console.log(`  ✅ ${tag}: ${xd.length} proveedores · ${link.length} enlaces prov→sku`);
      } catch (e) {
        console.log(`  ⚠ ${tag}: sin conexión (${e.message}) — skip`);
      } finally {
        await src.end().catch(() => {});
      }
    }
    if (!reached) throw new Error('Ninguna sucursal Kepler alcanzable — abort.');
    const xd = [...supMap].map(([code, name]) => ({ code, name }));
    const link = [...linkMap].map(([sku, prov_code]) => ({ sku, prov_code }));
    console.log(`\n  UNION (${reached}/${BRANCHES.length} sucursales): ${xd.length} proveedores · ${link.length} SKUs enlazados${conflicts ? ` · ⚠ ${conflicts} SKUs con proveedor divergente entre sucursales (gana el 1º)` : ''}`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_sup (code text, name text) ON COMMIT DROP`);
    await db.query(`CREATE TEMP TABLE stg_link (sku text, prov_code text) ON COMMIT DROP`);
    await stage(db, 'stg_sup', ['code', 'name'], xd.map((g) => [g.code, g.name]));
    await stage(db, 'stg_link', ['sku', 'prov_code'], link.map((l) => [l.sku, l.prov_code]));

    // 1) Upsert proveedores reales
    const up = await db.query(`
      INSERT INTO catalog.suppliers (tenant_id, code, name)
      SELECT $1, s.code, max(s.name) FROM stg_sup s GROUP BY s.code
      ON CONFLICT (tenant_id, code) DO UPDATE SET name=EXCLUDED.name, updated_at=now()`, [M]);

    // 2) Re-enlazar products.supplier_id al proveedor REAL (solo cambios)
    const ln = await db.query(`
      UPDATE catalog.products p
         SET supplier_id = s.id, updated_at = now()
        FROM stg_link l
        JOIN catalog.suppliers s ON s.tenant_id=$1 AND s.code=l.prov_code
       WHERE p.tenant_id=$1 AND p.sku=l.sku
         AND p.supplier_id IS DISTINCT FROM s.id`, [M]);

    console.log(`  proveedores upsert: ${up.rowCount} · productos (re)enlazados: ${ln.rowCount}`);

    // Diagnóstico: SKUs del catálogo SIN entrada en kdpv_prov_prod (conservan supplier viejo)
    const { rows: [cov] } = await db.query(`
      SELECT count(*) FILTER (WHERE l.sku IS NULL) sin_link, count(*) total
      FROM catalog.products p LEFT JOIN stg_link l ON l.sku=p.sku
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.activo=true AND btrim(coalesce(p.sku,''))<>''`, [M]);
    console.log(`  cobertura: ${cov.total - cov.sin_link}/${cov.total} SKUs con proveedor real · ${cov.sin_link} sin enlace (conservan supplier previo)`);

    // Verificación puntual: los YOHARI que reportó el usuario
    const { rows: chk } = await db.query(`
      SELECT p.sku, s.code, s.name FROM catalog.products p
      LEFT JOIN catalog.suppliers s ON s.id=p.supplier_id
      WHERE p.tenant_id=$1 AND p.sku IN ('24007','30070','30084') ORDER BY p.sku`, [M]);
    console.log('  check YOHARI:');
    chk.forEach((r) => console.log(`    ${r.sku} → ${r.code} "${r.name}"`));

    const { rows: top } = await db.query(
      `SELECT s.code, s.name, count(*) n FROM catalog.products p JOIN catalog.suppliers s ON s.tenant_id=p.tenant_id AND s.id=p.supplier_id
        WHERE p.tenant_id=$1 AND p.deleted_at IS NULL GROUP BY s.code, s.name ORDER BY n DESC LIMIT 10`, [M]);
    console.log('\nTop proveedores por # productos:');
    top.forEach((r) => console.log(`  ${String(r.n).padStart(5)}  ${r.code}  ${r.name}`));

    if (APPLY) { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
    else { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — usar --apply para aplicar.'); }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
