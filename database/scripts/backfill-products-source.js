/* eslint-disable no-console */
/**
 * BACKFILL de catalog.products.source (normalización PRODUCTO clase A, paso 1).
 * Clasifica cada producto por su origen real. Idempotente (solo SET). Dry-run default.
 *
 *   kepler  = sku vive en kepler_ods.kdii (con nombre)  → el feed lo gobierna
 *   wincaja = sku vive en wincaja.articulos (y no kdii)  → POS-only, no lo toca el feed Kepler
 *   manual  = ninguno de los dos                          → curado/huérfano, nunca auto-borrar
 *
 * Uso:  node database/scripts/backfill-products-source.js            # DRY-RUN (cuenta, no escribe)
 *       node database/scripts/backfill-products-source.js --apply    # escribe
 * Requiere que la migración 20260815140000 (columna source) esté aplicada. Conexión DATABASE_URL_NEW.
 */
const { Client } = require('pg');
const APPLY = process.argv.includes('--apply');
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

const CLASSIFY = `CASE
  WHEN EXISTS (SELECT 1 FROM kepler_ods.kdii k WHERE k.c1 = p.sku AND btrim(coalesce(k.c2,'')) <> '') THEN 'kepler'
  WHEN EXISTS (SELECT 1 FROM wincaja.articulos w WHERE w.articulo = p.sku) THEN 'wincaja'
  ELSE 'manual' END`;

(async () => {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) { console.error('falta DATABASE_URL_NEW'); process.exit(2); }
  const ssl = /rlwy|railway/.test(cs) ? { rejectUnauthorized: false } : false;
  const c = new Client({ connectionString: cs, ssl, statement_timeout: 120000 });
  await c.connect();

  const hasCol = (await c.query(`SELECT 1 FROM information_schema.columns
     WHERE table_schema='catalog' AND table_name='products' AND column_name='source'`)).rows.length;
  if (!hasCol) {
    if (APPLY) { console.error('✗ falta columna catalog.products.source — aplicar migración 20260815140000 primero'); process.exit(3); }
    console.warn('  (aviso: columna source aún no existe — dry-run solo cuenta la clasificación)\n');
  }

  // Distribución que resultaría de la clasificación (activos + inactivos).
  const dist = (await c.query(`
    SELECT ${CLASSIFY} AS src, p.activo, count(*)::int n
    FROM catalog.products p WHERE p.tenant_id = $1
    GROUP BY 1, 2 ORDER BY 1, 2`, [TENANT])).rows;
  console.log(`=== Clasificación de catalog.products.source (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  const by = {};
  dist.forEach((r) => { by[r.src] = by[r.src] || { activo: 0, inactivo: 0 }; by[r.src][r.activo ? 'activo' : 'inactivo'] = r.n; });
  let total = 0;
  for (const [src, v] of Object.entries(by)) { console.log(`  ${src.padEnd(9)} activos ${String(v.activo).padStart(5)} · inactivos ${String(v.inactivo).padStart(5)}`); total += v.activo + v.inactivo; }
  console.log(`  ${'TOTAL'.padEnd(9)} ${total}`);

  if (APPLY && hasCol) {
    const r = await c.query(`UPDATE catalog.products p SET source = ${CLASSIFY}, updated_at = now() WHERE p.tenant_id = $1`, [TENANT]);
    console.log(`\n✅ UPDATE ${r.rowCount} productos con source.`);
  } else {
    console.log('\n  → correr con --apply para escribir.');
  }
  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
