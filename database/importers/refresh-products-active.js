/* eslint-disable no-console */
/**
 * NORM (Fase 1.6, interino) — `inventory.products_active` desde `catalog.products` (maestra fresca),
 * NO desde el FDW legacy `erp.productos_activos` (stale/dormido → productos nuevos/reactivados
 * quedaban invisibles; ej. 00281/00295 no aparecían aunque estaban vivos en Kepler con precio+stock).
 *
 * Mantiene `products_active` como TABLA (0 riesgo para los ~6 lectores: search/pricing/portal/
 * ticket-extractor/AI-matcher — no toca RLS ni contexto de tenant). Refresca por TRUNCATE+INSERT
 * de los activos del catálogo. La conversión a VISTA `security_invoker` (Fase 1.6 completa) queda
 * para la sesión enfocada (requiere análisis de contexto-tenant de cada lector).
 *
 * Con --reactivate: además reactiva el DRIFT (source=kepler vivos en kepler_ods, activo=false, no
 * borrados, no DESCONTINUADO) → productos vivos en el ERP vuelven a estar activos.
 *
 *   node database/importers/refresh-products-active.js               # dry-run (cuenta)
 *   node database/importers/refresh-products-active.js --apply       # refresca products_active
 *   node database/importers/refresh-products-active.js --apply --reactivate   # + reactiva el drift
 */
const { Client } = require('pg');
const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const REACT = process.argv.includes('--reactivate');

const REACT_WHERE = `p.tenant_id=$1 AND p.source='kepler' AND p.deleted_at IS NULL AND p.activo=false
  AND p.nombre NOT ILIKE '%DESCONTINUADO%'
  AND EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE btrim(k.c1)=p.sku AND btrim(coalesce(k.c2,'')) <> '')`;

(async () => {
  const c = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await c.connect();
  try {
    console.log(`\n=== refresh products_active desde catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}${REACT ? ' +reactivate' : ''}) ===\n`);

    const reactN = Number((await c.query(`SELECT count(*)::int n FROM catalog.products p WHERE ${REACT_WHERE}`, [M])).rows[0].n);
    console.log(`  drift a reactivar (kepler vivo, activo=false, no descontinuado): ${reactN}`);
    const activos = Number((await c.query(`SELECT count(*)::int n FROM catalog.products WHERE tenant_id=$1 AND activo AND deleted_at IS NULL AND btrim(coalesce(sku,''))<>''`, [M])).rows[0].n);
    const paActual = Number((await c.query(`SELECT count(*)::int n FROM inventory.products_active`)).rows[0].n);
    console.log(`  catalog activos con sku: ${activos}  ·  products_active actual (congelada): ${paActual}`);
    console.log(`  → products_active quedaría con ${REACT ? activos + reactN : activos} filas (activos${REACT ? ' + reactivados' : ''})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await c.query('BEGIN');
    await c.query(`SET LOCAL app.tenant_id = '${M}'`);
    if (REACT) {
      const r = await c.query(`UPDATE catalog.products p SET activo=true, updated_at=now() WHERE ${REACT_WHERE}`, [M]);
      console.log(`\n  ✓ reactivados: ${r.rowCount}`);
    }
    // El FK a inventory.products (tabla paralela frozen-FDW) es obsoleto: ahora derivamos de
    // catalog.products (maestra). Sin dropearlo, los SKUs nuevos del catálogo violan el FK.
    await c.query(`ALTER TABLE inventory.products_active DROP CONSTRAINT IF EXISTS fk_inventory_products_active_sku`);
    await c.query(`TRUNCATE inventory.products_active`);
    const ins = await c.query(`
      INSERT INTO inventory.products_active
        (sku, codigo_barras, subfamilia, nombre, descripcion, unidad_compra, unidad_venta, categoria, synced_at, image_url, image_source, image_storage_key, image_updated_at)
      SELECT sku, barcode, product_line, nombre, description, unit_purchase, unit_sale, department, now(), image_url, image_source, image_storage_key, image_updated_at
        FROM catalog.products WHERE tenant_id=$1 AND activo AND deleted_at IS NULL AND btrim(coalesce(sku,''))<>''`, [M]);
    await c.query('COMMIT');
    console.log(`  ✓ products_active refrescada: ${ins.rowCount} filas (desde catalog.products).`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await c.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
