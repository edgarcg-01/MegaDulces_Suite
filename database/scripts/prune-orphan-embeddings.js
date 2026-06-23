#!/usr/bin/env node
/**
 * Purga puntual de embeddings HUÉRFANOS del vector store (Fase K).
 *
 * Contexto: el sync runtime (EmbeddingSyncService) borra del store los
 * product_ids que ya no están activos en la fuente, PERO tiene una guarda
 * anti-wipe que salta el borrado si eliminaría >30% del store. Cuando el store
 * quedó genuinamente stale en mayor proporción (ej: el catálogo se recreó con
 * UUIDs nuevos en un re-import y el store conservó los ids viejos), la guarda
 * bloquea para siempre y el corpus queda contaminado con huérfanos que el
 * matcher KNN devuelve pero el catálogo ya no puede resolver.
 *
 * Este script hace ESE borrado, deliberado y una sola vez, SIN la guarda.
 * Borra exactamente lo mismo que el sync quería: store ids que NO están en
 * `public.products WHERE activo=true`.
 *
 * Seguro por diseño:
 *   - DRY-RUN por default. Solo borra con `--apply`.
 *   - Reporta el desglose (huérfanos reales vs soft-deleted) y una muestra.
 *   - NO toca la DB transaccional (solo lee la lista de activos).
 *
 * Env (mismas que load-vector-db.js):
 *   VECTOR_DATABASE_URL   destino (vector store, requerido)
 *   PRODUCT_SOURCE_URL    fuente del catálogo (default = DATABASE_URL)
 *
 * Uso:
 *   node database/scripts/prune-orphan-embeddings.js            # dry-run
 *   node database/scripts/prune-orphan-embeddings.js --apply    # ejecuta el borrado
 */
require('dotenv').config();
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const APPLY = process.argv.includes('--apply');
const VECTOR_URL = process.env.VECTOR_DATABASE_URL;
const SOURCE_URL = process.env.PRODUCT_SOURCE_URL || process.env.DATABASE_URL;

if (!VECTOR_URL) { console.error('ERROR: falta VECTOR_DATABASE_URL'); process.exit(1); }
if (!SOURCE_URL) { console.error('ERROR: falta PRODUCT_SOURCE_URL (o DATABASE_URL)'); process.exit(1); }

const ssl = (u) => (/rlwy|railway|proxy|amazonaws|render|supabase/i.test(u) ? { rejectUnauthorized: false } : false);
const src = knex({ client: 'pg', connection: { connectionString: SOURCE_URL, ssl: ssl(SOURCE_URL) }, pool: { min: 0, max: 3 } });
const vec = knex({ client: 'pg', connection: { connectionString: VECTOR_URL, ssl: ssl(VECTOR_URL) }, pool: { min: 0, max: 3 } });

(async () => {
  try {
    const activeIds = new Set((await src('products').where('activo', true).select('id')).map((r) => r.id));
    const storeIds = (await vec('product_embeddings').select('product_id')).map((r) => r.product_id);
    const toDelete = storeIds.filter((id) => !activeIds.has(id));

    const pct = storeIds.length ? Math.round((toDelete.length / storeIds.length) * 100) : 0;
    console.log(`Fuente activos:   ${activeIds.size}`);
    console.log(`Vector store:     ${storeIds.length}`);
    console.log(`A purgar:         ${toDelete.length} (${pct}% del store)`);

    if (toDelete.length === 0) {
      console.log('Nada que purgar — el store ya está alineado.');
      return;
    }

    // Desglose: de los huérfanos, ¿cuántos existen en products (soft-deleted) vs ya no existen?
    const sample = toDelete.slice(0, 60000);
    const existInProducts = (await src('products').whereIn('id', sample).select('id')).map((r) => r.id);
    const existSet = new Set(existInProducts);
    console.log(`  ├─ existen en products (soft-deleted): ${existInProducts.length}`);
    console.log(`  └─ ya NO existen en products (huérfanos por re-import): ${toDelete.length - existInProducts.filter((id)=>existSet.has(id)).length}`);

    // Muestra de 8 nombres que se borrarían (desde el store denormalizado).
    const muestra = await vec('product_embeddings').whereIn('product_id', toDelete.slice(0, 8)).select('product_id', 'product_name', 'brand_name');
    console.log('\nMuestra a borrar:');
    muestra.forEach((m) => console.log(`  - ${m.brand_name ?? '—'} / ${m.product_name}  [${m.product_id}]`));

    if (!APPLY) {
      console.log('\nDRY-RUN. Nada borrado. Re-corré con --apply para ejecutar el borrado.');
      return;
    }

    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += 500) {
      deleted += await vec('product_embeddings').whereIn('product_id', toDelete.slice(i, i + 500)).del();
    }
    const total = await vec('product_embeddings').count('* as n').first();
    console.log(`\n✓ Purgados ${deleted}. Total restante en store: ${total.n}.`);
    console.log('El sync runtime ahora opera normal (gap < 30%).');
  } catch (e) {
    console.error('\n✗ Error:', e.message);
    process.exitCode = 1;
  } finally {
    await src.destroy();
    await vec.destroy();
  }
})();
