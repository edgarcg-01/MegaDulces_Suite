/* eslint-disable no-console */
/**
 * Nombre (y marca de una clave REUSADA) de `catalog.products` desde la identidad de `kepler_ods.kdii`.
 *
 * ⛔ RETIRADO del carril nocturno 2026-11-12 `[CANON.6.10]`. Lo mantiene el hop-2 de la ingesta AL LLEGAR
 * el cambio de `kdii` (`normalizeProductsFromOds` en `services/feeds-ingest/apply-handlers.js`), que ahora
 * hace lo que sólo hacía este barrido: mover la marca cuando Kepler reusa una clave para otra línea, y no
 * tumbar el lote cuando dos SKUs irían al mismo (marca, nombre). Un normalizador que falla ya no espera a un
 * barrido: se reintenta partiendo el lote (`reintentarPorPartes`).
 *
 * Lo medido antes de retirarlo (30 días, `master_data_history`): de 50 correcciones, 44 eran el pleito H12
 * (este barrido contra el hop-2 con CEDIS primero), cerrado por `[CANON.5.23]` el 6-nov; después, 0 casi
 * todas las noches y 3 claves reusadas el 10-nov (95340–95342) que el hop-2 no tomó el 9-nov por la tarde —
 * causa NO DEMOSTRABLE: su registro se perdió con el reinicio del 11-nov. Los 11 que difieren hoy los frena la
 * unique (Kepler los llamó «INHABILITADO»/«* DESCONTINUADO» y otro producto de la marca ya se llama así).
 *
 * Queda como herramienta MANUAL, con la MISMA función del hop-2 (la importa, no la copia):
 *   node database/importers/kepler/repoint-catalog-names.js           # sólo lectura: cuántos difieren y
 *                                                                      # cuántos frena la unique
 *   node database/importers/kepler/repoint-catalog-names.js --apply   # normaliza el catálogo completo
 * Se quitó `--source=kp` (leer `KP_CONCENTRADA` en el `.245`, que ya no se usa).
 */
const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { identitySnapshotSql } = require('../../../services/feeds-ingest/product-identity');
const { normalizeProductsFromOds } = require('../../../services/feeds-ingest/apply-handlers');
const { normalizePromo } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  // [VP.3.2] Quien escribe, declarado: el trigger de analytics.master_data_history lo lee
  // solo. Nunca lanza — el actor es metadata, un feed no se cae por no poder firmar.
  await declararActor(dst, 'repoint-catalog-names');
  try {
    console.log(`\n=== Nombres de catálogo desde kepler_ods.kdii (${APPLY ? 'APPLY' : 'SÓLO LECTURA'}) ===\n`);
    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    const { rows: [c] } = await dst.query(`
      WITH i AS (${identitySnapshotSql({})})
      SELECT count(*)::int AS skus,
             count(*) FILTER (WHERE p.nombre IS DISTINCT FROM i.nombre)::int AS difieren,
             count(*) FILTER (WHERE p.nombre IS DISTINCT FROM i.nombre AND EXISTS (
               SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1 AND p2.id<>p.id
                  AND p2.brand_id=p.brand_id AND p2.nombre=i.nombre))::int AS frenados_por_la_unique
        FROM i JOIN catalog.products p ON p.sku = i.sku AND p.tenant_id = $1 AND p.deleted_at IS NULL`, [M]);
    await dst.query('ROLLBACK');
    console.log(`  claves: ${c.skus} · nombre distinto al de Kepler: ${c.difieren} · de ésos, frenados por la unique (marca, nombre): ${c.frenados_por_la_unique}`);

    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const skus = (await dst.query(`SELECT sku FROM (${identitySnapshotSql({})}) i`)).rows.map((r) => r.sku);
    const n = await normalizeProductsFromOds(dst, M, skus);
    // El nombre es entrada de `is_promo` («= GRATIS»), como en la cadena del hop-2 de kdii.
    const np = await normalizePromo(dst, M, null);
    console.log(`\n[APPLY] COMMIT — ${n} productos (nombre, marca de clave reusada o código de barras) · is_promo: ${np}.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR:', e.message);
    process.exitCode = 1;
  } finally {
    await dst.end().catch(() => {});
  }
})();
