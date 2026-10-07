#!/usr/bin/env node
/**
 * Aplica el subset mínimo de migraciones MT necesario para que pgvector + AI
 * matching de productos funcione en una DB Railway aislada.
 *
 * Migraciones aplicadas (en orden):
 *   1. 20260526000001 — extensions (pgcrypto) + tabla `tenants` + current_tenant_id()
 *   2. 20260526000002 — core identity (users, role_permissions, etc.)
 *   3. 20260526000003 — rol `app_runtime` + grants
 *   4. 20260526000004 — product catalog (brands, products, product_categories)
 *   5. 20260527120000 — CREATE EXTENSION vector + ALTER products ADD embedding + HNSW
 *   6. 20260527150000 — trigger staleness embedding al cambiar nombre/brand_id
 *
 * Skipea todo lo demás (commercial.*, analytics.*, logistics.*, captures, scoring,
 * televenta, shims K-debt para tablas que no aplicamos).
 *
 * Marca cada migración aplicada en `knex_migrations` para que un futuro
 * `migrate:latest` desde CLI detecte estas como ya hechas y aplique solo el
 * delta.
 *
 * Usage:
 *   $env:RAILWAY_PGVECTOR_URL = "postgresql://..."
 *   node database/scripts/railway-pgvector-minimal-migrate.js
 */

const path = require('path');
const knex = require('knex');

const URL = process.env.RAILWAY_PGVECTOR_URL || process.env.NEW_DATABASE_URL;
if (!URL) {
  console.error('Setea RAILWAY_PGVECTOR_URL o NEW_DATABASE_URL antes de correr');
  process.exit(1);
}

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations-newdb');
const MIGRATIONS = [
  '20260526000001_init_tenants_and_extensions.js',
  '20260526000002_core_identity.js',
  '20260526000003_create_app_runtime_role.js',
  '20260526000004_product_catalog.js',
  '20260527120000_enable_pgvector_and_products_embedding.js',
  '20260527150000_products_embedding_staleness_trigger.js',
];

(async () => {
  const db = knex({
    client: 'pg',
    connection: URL,
    pool: { min: 0, max: 2 },
  });

  try {
    console.log('→ Conectado:', (await db.raw('SELECT version()')).rows[0].version.split(' on ')[0]);

    await db.raw(`
      CREATE TABLE IF NOT EXISTS knex_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        batch INTEGER,
        migration_time TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.raw(`
      CREATE TABLE IF NOT EXISTS knex_migrations_lock (
        index INTEGER PRIMARY KEY,
        is_locked INTEGER
      )
    `);

    const alreadyApplied = new Set(
      (await db('knex_migrations').select('name')).map((r) => r.name),
    );

    const batchRow = await db('knex_migrations').max('batch as max').first();
    const nextBatch = (batchRow?.max || 0) + 1;

    let appliedCount = 0;
    for (const file of MIGRATIONS) {
      if (alreadyApplied.has(file)) {
        console.log('· skip (already applied):', file);
        continue;
      }
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const migration = require(fullPath);
      const start = Date.now();
      await db.transaction(async (trx) => {
        await migration.up(trx);
        await trx('knex_migrations').insert({
          name: file,
          batch: nextBatch,
          migration_time: new Date(),
        });
      });
      console.log(`✓ ${file} (${Date.now() - start}ms)`);
      appliedCount++;
    }

    // Verificación final
    const [ext] = (
      await db.raw(`SELECT extname, extversion FROM pg_extension WHERE extname='vector'`)
    ).rows;
    const [productsCols] = (
      await db.raw(`
        SELECT count(*) FILTER (WHERE column_name = 'embedding') as has_embedding,
               count(*) FILTER (WHERE column_name = 'activo') as has_activo
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='products'
      `)
    ).rows;

    console.log('');
    console.log(`──── Resumen ────`);
    console.log(`Migraciones aplicadas: ${appliedCount} (skipeadas previas: ${MIGRATIONS.length - appliedCount})`);
    console.log(`pgvector: ${ext ? `v${ext.extversion} ✓` : 'NO INSTALADA ✗'}`);
    console.log(`products.embedding column: ${productsCols.has_embedding > 0 ? '✓' : '✗'}`);
    console.log(`products.activo column: ${productsCols.has_activo > 0 ? '✓' : '✗'}`);
  } catch (err) {
    console.error('FAILED:', err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
