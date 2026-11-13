/* eslint-disable no-console */
/**
 * CANON.0.1 — REPOINT de COSTO desde `kepler_ods` (kdik.c16 mediana retail anclada a kdii.c90) →
 * catalog.products.cost_base/with_tax/per_case. Clamp in-band [1/3,3]× anti-unidad-caja, UPDATE-only,
 * churn-free.
 *
 * ⛔ RETIRADO del carril nocturno 2026-11-13 `[CANON.6.17]`. Lo mantiene el hop-2 `normalizeCost` AL LLEGAR un cambio de
 * `kdii` (ancla) o `kdik` (costo) — y desde `[CANON.6.14]` también al BORRARSE una de sus filas (la llave de `kdik`
 * incluye el SKU, `c2`). Medido antes de retirarlo: 3 correcciones en 14 noches contra 12–102 diarias del hop-2, y las
 * 3 explicadas por huecos ya cerrados (95341/95342: la falla sin registro del 9-nov, hoy reintentada y en
 * `hop2_fallas`; 26019: editado en Kepler entre reconciliaciones con borrados, que no recalculaban). El árbitro
 * `catalogo_costo_evento` de db-health vigila lo que el evento no vea.
 *
 * Queda como herramienta MANUAL, con la MISMA regla (`costoNetoCte` de ods-derived, que usa normalizeCost):
 *   node database/importers/kepler/repoint-catalog-cost.js            # sólo lectura: cuántos cambiaría
 *   node database/importers/kepler/repoint-catalog-cost.js --apply    # catálogo entero (+ is_promo)
 */
const { Client } = require('pg');
const { declararActor } = require('../lib/declare-actor');
const { normalizeCost, normalizePromo, costoPendienteSql } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  // [VP.3.2] Quien escribe, declarado: el trigger de analytics.master_data_history lo lee
  // solo. Nunca lanza — el actor es metadata, un feed no se cae por no poder firmar.
  await declararActor(db, 'repoint-catalog-cost');
  try {
    console.log(`\n=== REPOINT costo kepler_ods → catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}) — vía ods-derived (al-momento share) ===`);
    const ok = (await db.query(`SELECT to_regclass('kepler_ods.kdik') a, to_regclass('kepler_ods.kdii') b`)).rows[0];
    if (!ok.a || !ok.b) { console.error('❌ kepler_ods.kdik/kdii ausente — abortando (¿DST sin ODS?)'); process.exitCode = 1; return; }
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    const [pend] = (await db.query(costoPendienteSql(), [M])).rows;
    await db.query('ROLLBACK');
    console.log(`  costos que cambiaría: ${pend.pendientes} (de ésos, sin costo hoy: ${pend.sin_costo})`);
    if (!APPLY) { console.log('\n[SÓLO LECTURA] nada cambió.'); return; }
    const n = await normalizeCost(db, M, null);
    console.log(`[APPLY] ${n} costos actualizados (en banda, churn-free, full).`);
    // `[CANON.6.9]` El costo es entrada de `is_promo` (costo en (0, $0.05] = clave de regalo). Quien
    // cambia el costo recalcula la marca; antes lo hacía `repoint-catalog-prices` cada 30 min.
    const np = await normalizePromo(db, M, null);
    console.log(`[APPLY] is_promo: ${np} productos cambiaron de marca.`);
  } catch (e) {
    console.error('\nERROR:', e.message);
    if (e.detail) console.error('  detail:', e.detail);
    process.exitCode = 1;
  } finally { await db.end().catch(() => {}); }
})();
