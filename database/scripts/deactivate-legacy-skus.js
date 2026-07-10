/* eslint-disable no-console */
/**
 * Higiene de catálogo — soft-delete de SKUs LEGACY fantasma.
 *
 * Un SKU es "legacy fantasma" si cumple TODO (guardas conservadoras):
 *   1) está activo (deleted_at IS NULL),
 *   2) NO aparece en el maestro de productos (kdii.c1) de NINGUNA sucursal viva,
 *   3) NO tiene existencia en commercial.stock (sum = 0 o sin fila),
 *   4) NO tiene venta en analytics.product_sales_monthly/daily,
 *   5) supplier_id IS NULL (los que sí tienen proveedor no se tocan).
 * Con las 5, es un código que sólo vive en el catálogo agregado de .245 y no
 * existe en el ERP vivo → clutter. Se soft-deletea (deleted_at=now()); `activo`
 * es GENERATED y se apaga solo. Reversible (deleted_at=NULL).
 *
 * DESTRUCTIVO → dry-run por default; exige --apply Y correr on-prem (las
 * sucursales live 192.168.x deben ser alcanzables para el criterio (2)).
 *
 *   node database/scripts/deactivate-legacy-skus.js            # dry-run (reporte)
 *   node database/scripts/deactivate-legacy-skus.js --apply    # soft-delete
 *
 * Env: DATABASE_URL_NEW (destino). Fuente kdii: SUPPLIERS_BRANCH_MAP >
 * STOCK_BRANCH_MAP > default 6 sucursales (mismo patrón que import-kepler-suppliers).
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const BRANCHES = process.env.SUPPLIERS_BRANCH_MAP
  ? JSON.parse(process.env.SUPPLIERS_BRANCH_MAP)
  : process.env.STOCK_BRANCH_MAP
    ? JSON.parse(process.env.STOCK_BRANCH_MAP).map((b) => b.url)
    : [
        'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00',
        'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01',
        'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02',
        'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03',
        'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04',
        'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05',
      ];

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Higiene: soft-delete SKUs legacy (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${BRANCHES.length} sucursal(es) ===\n`);

    // (2) SKUs vivos = union de kdii.c1 de TODAS las sucursales alcanzables.
    const liveSkus = new Set();
    let reached = 0;
    for (const url of BRANCHES) {
      const src = new Client({ connectionString: url, connectionTimeoutMillis: 8000, statement_timeout: 120000 });
      const tag = (url.match(/@([^/]+)\/(\w+)/) || [, url, ''])[2] || url;
      try {
        await src.connect();
        const { rows } = await src.query(`SELECT DISTINCT btrim(c1) AS sku FROM md.kdii WHERE btrim(coalesce(c1,'')) <> ''`);
        for (const r of rows) liveSkus.add(r.sku);
        reached++;
        console.log(`  ✅ ${tag}: ${rows.length} SKUs en kdii`);
      } catch (e) {
        console.log(`  ⚠ ${tag}: sin conexión (${e.message}) — skip`);
      } finally {
        await src.end().catch(() => {});
      }
    }
    // Guarda dura: sin TODAS las sucursales no clasificamos (un SKU podría vivir
    // en la sucursal que no alcanzamos → falso positivo → borraríamos algo vivo).
    if (reached < BRANCHES.length) {
      throw new Error(`Solo ${reached}/${BRANCHES.length} sucursales alcanzables. Abort: correr on-prem con TODAS arriba para no soft-deletear un SKU que vive en la sucursal faltante.`);
    }
    console.log(`\n  SKUs vivos (union kdii): ${liveSkus.size}`);

    // Candidatos: activo + sin proveedor + sin stock + sin venta.
    const { rows: cand } = await db.query(`
      SELECT p.id, p.sku, p.nombre
      FROM catalog.products p
      WHERE p.tenant_id = $1 AND p.deleted_at IS NULL AND p.supplier_id IS NULL
        AND btrim(coalesce(p.sku,'')) <> ''
        AND NOT EXISTS (SELECT 1 FROM commercial.stock s WHERE s.tenant_id=$1 AND s.product_id=p.id AND s.quantity <> 0)
        AND NOT EXISTS (SELECT 1 FROM analytics.product_sales_monthly m WHERE m.tenant_id=$1 AND m.product_id=p.id)
        AND NOT EXISTS (SELECT 1 FROM analytics.product_sales_daily d WHERE d.tenant_id=$1 AND d.product_id=p.id)`, [M]);

    // (2) filtrar los que NO están en ningún kdii vivo.
    const legacy = cand.filter((p) => !liveSkus.has(p.sku));
    console.log(`  candidatos (activo+sin prov+sin stock+sin venta): ${cand.length}`);
    console.log(`  → LEGACY (además ausentes de kdii vivo): ${legacy.length}`);
    console.log('\n  Muestra (primeros 15):');
    legacy.slice(0, 15).forEach((p) => console.log(`    ${p.sku}  ${p.nombre}`));

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Revisá el listado antes de --apply.'); return; }
    if (!legacy.length) { console.log('\nNada que hacer.'); return; }

    const ids = legacy.map((p) => p.id);
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const res = await db.query(
      `UPDATE catalog.products SET deleted_at = now(), updated_at = now()
        WHERE tenant_id=$1 AND id = ANY($2) AND deleted_at IS NULL`, [M, ids]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${res.rowCount} productos soft-deleted (reversible: deleted_at=NULL).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
