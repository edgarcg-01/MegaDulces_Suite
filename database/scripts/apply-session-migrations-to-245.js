/**
 * Aplica a .245 las 4 migraciones de la sesión 2026-06-02:
 *   1. 20260602130000_add_product_image_columns
 *   2. 20260602140000_image_source_add_ml
 *   3. 20260602150000_brands_is_commercial_flag
 *   4. 20260602160000_products_views_active_topsellers
 *
 * Las 9 migraciones intermedias pendientes (pgvector/FDW/etc) NO se aplican —
 * quedan en .245 como pendientes. Por eso usamos el `.up()` de cada archivo
 * directo en lugar de `knex migrate:latest` (que correría todo en orden).
 *
 * Idempotente: cada migración usa `IF NOT EXISTS` / `DROP IF EXISTS`. Re-correr
 * el script es seguro. Registra cada una en `knex_migrations` con el batch real
 * para que `migrate:status` futuras las muestren como aplicadas.
 *
 * Uso:
 *   node database/scripts/apply-session-migrations-to-245.js
 */
require('dotenv').config();

const path = require('path');
const url = process.env.DATABASE_URL_REMOTE_SNAPSHOT;
if (!url) {
  console.error('DATABASE_URL_REMOTE_SNAPSHOT missing in env');
  process.exit(1);
}

const knex = require('knex')({
  client: 'pg',
  connection: url,
  pool: { min: 0, max: 2 },
});

const MIGRATIONS = [
  // Pendientes anteriores necesarias para que la MV products_top_sellers funcione:
  '20260601210000_mega_dulces_product_fields.js',
  '20260601200000_add_warehouses_ver_to_customer_b2b.js',
  '20260601220000_fdw_mega_dulces_ventas.js',
  '20260602100000_mega_dulces_full_enrichment.js',
  '20260602100001_fdw_mega_dulces_ranking.js',
  '20260602110000_cleanup_p1_backups_and_vendedores_naming.js',
  '20260602120000_promo_engine_applied_fields.js',
  // Migraciones de la sesión 2026-06-02:
  '20260602130000_add_product_image_columns.js',
  '20260602140000_image_source_add_ml.js',
  '20260602150000_brands_is_commercial_flag.js',
  '20260602160000_products_views_active_topsellers.js',
  '20260603100000_refactor_products_top_sellers_from_ranking_legacy.js',
  '20260603110000_fdw_productos_activos_and_refactor_view.js',
  '20260603120000_catalog_schema_with_views.js',
  '20260603130000_organize_schemas_identity_fieldops_scoring.js',
  '20260603140000_move_identity_tables_to_schema.js',
  '20260603150000_move_catalog_tables_to_schema.js',
  '20260603160000_create_erp_schema.js',
];

// Migraciones DELIBERADAMENTE skipeadas:
//   - pgvector: .245 no tiene la extensión instalada (Docker maneja AI)
const SKIP_REASONS = {
  '20260527120000_enable_pgvector_and_products_embedding.js': 'pgvector no instalado en .245 (Docker maneja AI)',
  '20260527150000_products_embedding_staleness_trigger.js': 'depende de pgvector (skip por la anterior)',
};

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations-newdb');

(async () => {
  console.log(`▶ Aplicando ${MIGRATIONS.length} migraciones a .245`);
  console.log(`  host: 192.168.0.245:5432`);
  console.log(`  db:   postgres_platform`);
  console.log('');

  // Próximo batch
  const [{ next_batch }] = (
    await knex.raw(`SELECT COALESCE(MAX(batch), 0) + 1 AS next_batch FROM knex_migrations`)
  ).rows;
  console.log(`  Batch a usar: ${next_batch}`);
  console.log('');

  const already = new Set(
    await knex('knex_migrations').pluck('name'),
  );

  for (const fname of MIGRATIONS) {
    if (already.has(fname)) {
      console.log(`  ⊘ ${fname} ya aplicada — skip`);
      continue;
    }

    const mod = require(path.join(MIGRATIONS_DIR, fname));
    if (typeof mod.up !== 'function') {
      console.log(`  ✗ ${fname} no exporta up() — skip`);
      continue;
    }

    console.log(`  → ${fname}`);
    const t0 = Date.now();
    try {
      await mod.up(knex);
      // Registrar en knex_migrations
      await knex('knex_migrations').insert({
        name: fname,
        batch: next_batch,
        migration_time: new Date(),
      });
      console.log(`    ✓ aplicada (${Date.now() - t0}ms)`);
    } catch (e) {
      console.error(`    ✗ FAIL: ${e.message}`);
      console.error(`    → ABORT — corregí y re-corré el script (es idempotente)`);
      await knex.destroy();
      process.exit(1);
    }
  }

  console.log('');
  console.log('▶ Migraciones skipeadas deliberadamente:');
  for (const [name, reason] of Object.entries(SKIP_REASONS)) {
    console.log(`  ⊘ ${name}`);
    console.log(`      → ${reason}`);
  }
  console.log('');
  console.log('▶ Verificación final:');
  const r = await knex.raw(`
    SELECT
      n.nspname AS schema,
      c.relname AS name,
      CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MV' END AS kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('products','products_active','products_top_sellers','brands')
    ORDER BY c.relname
  `);
  r.rows.forEach((x) => console.log(`  ${x.kind.padEnd(6)} ${x.schema}.${x.name}`));

  const cols = await knex.raw(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='products' AND column_name IN ('image_url','image_source','image_storage_key','image_updated_at')
    ORDER BY column_name
  `);
  console.log(`  products image cols: ${cols.rows.map((r) => r.column_name).join(', ') || 'NONE'}`);

  const brandFlag = await knex.raw(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='brands' AND column_name='is_commercial'
  `);
  console.log(`  brands.is_commercial: ${brandFlag.rows.length ? 'present' : 'MISSING'}`);

  const nonComm = await knex('brands').where({ is_commercial: false }).count('id as c').first();
  console.log(`  brands marcadas no-comerciales: ${nonComm.c}`);

  console.log('');
  console.log('✓ Listo. Conectá DBeaver/pgAdmin a 192.168.0.245:5432 → postgres_platform → public');
  await knex.destroy();
})().catch((e) => {
  console.error('fatal:', e);
  knex.destroy();
  process.exit(1);
});
