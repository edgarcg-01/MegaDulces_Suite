/* eslint-disable no-console */
/**
 * NORM (Fase 1.6, interino) — completa `inventory.products` (catálogo de escaneo del conteo físico,
 * ~13.8k SKUs) con los SKUs NUEVOS que ya existen en la maestra fresca `catalog.products`
 * (← kepler_ods.kdii) pero aún no en la tabla vieja alimentada por el FDW muerto `erp.catalogo_completo`.
 * Sin esto, los ~677 productos dados de alta en los últimos ~74d NO son escaneables en
 * inventory-count.service.ts (mismo bug que 00281/00295, pero del lado del conteo).
 *
 * INSERT-SOLO-NUEVOS (ON CONFLICT DO NOTHING). NO actualiza filas existentes a propósito:
 *   catalog.products es una proyección NORMALIZADA (product_line/department = NULL → la línea vive
 *   como brand_id uuid; sin subfamilia/categoria/imagen). Un UPDATE desde catalog NULEARÍA
 *   subfamilia+categoria+image_* de las 13.8k filas existentes (regresión vivida en products_active
 *   el 2026-08-17). Las existentes ya son escaneables; refrescar sus nombres es nice-to-have y va aparte.
 * Los nuevos entran con barcode+nombre+descripcion+unidades de catalog; subfamilia/categoria/imagen
 * quedan NULL (no los necesita el escaneo; enriquecer desde kepler_ods.kdii.c3 es un paso posterior).
 * Sin DELETE (append-only; propagación de bajas = Fase 0.2 aparte).
 *
 *   node database/importers/refresh-inventory-products.js --prod            # dry-run (cuenta) contra PROD
 *   node database/importers/refresh-inventory-products.js --prod --apply    # inserta los nuevos en PROD
 *   (sin --prod usa DATABASE_URL_NEW; OJO: el default de .env es la copia LOCAL stale)
 */
const { Client } = require('pg');
const fs = require('fs');
const M = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
function prodUrl() {
  const t = fs.readFileSync('C:/KeplerRunner/run-feeds.cmd', 'utf8');
  for (const m of t.matchAll(/(postgres(?:ql)?:\/\/[^\s"']+)/gi)) {
    try { const u = new URL(m[1]); if (/rlwy|railway|proxy/i.test(u.host)) return m[1]; } catch { /* skip */ }
  }
  throw new Error('no encontré URL Railway en el runner');
}
const DST = process.argv.includes('--prod') ? prodUrl()
  : (process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform');
const APPLY = process.argv.includes('--apply');

// SKUs en catalog que faltan en inventory.products (los nuevos, no escaneables).
const NEW_WHERE = `p.tenant_id=$1 AND btrim(coalesce(p.sku,''))<>''
  AND NOT EXISTS (SELECT 1 FROM inventory.products ip WHERE ip.sku = p.sku)`;

(async () => {
  const c = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await c.connect();
  try {
    const ver = (await c.query('SHOW server_version')).rows[0].server_version;
    console.log(`\n=== completar inventory.products con nuevos de catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}) · PG ${ver} ===\n`);

    const nuevos = Number((await c.query(`SELECT count(*)::int n FROM catalog.products p WHERE ${NEW_WHERE}`, [M])).rows[0].n);
    const invActual = Number((await c.query(`SELECT count(*)::int n FROM inventory.products`)).rows[0].n);
    console.log(`  inventory.products actual: ${invActual}`);
    console.log(`  SKUs nuevos a insertar (en catalog, faltan en inventory): ${nuevos}`);
    console.log(`  → NO se toca ninguna fila existente (subfamilia/categoria/image_* intactos).`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply --prod para escribir.'); return; }
    if (nuevos === 0) { console.log('\n[APPLY] 0 nuevos — nada que insertar.'); return; }

    await c.query('BEGIN');
    const ins = await c.query(`
      INSERT INTO inventory.products
        (sku, codigo_barras, nombre, descripcion, unidad_compra, unidad_venta, synced_at, synced_from)
      SELECT p.sku, NULLIF(btrim(p.barcode),''), p.nombre, p.description, p.unit_purchase, p.unit_sale, now(), 'catalog.products'
        FROM catalog.products p WHERE ${NEW_WHERE}
      ON CONFLICT (sku) DO NOTHING`, [M]);
    await c.query('COMMIT');
    const invFinal = Number((await c.query(`SELECT count(*)::int n FROM inventory.products`)).rows[0].n);
    console.log(`\n  ✓ insertados: ${ins.rowCount} nuevos. inventory.products: ${invActual}→${invFinal}. Existentes sin tocar.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await c.end(); }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
