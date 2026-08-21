/* eslint-disable no-console */
/**
 * CANON.0.1 — REPOINT de COSTO desde `kepler_ods` (kdik.c16 mediana retail anclada a kdii.c90) →
 * catalog.products.cost_base/with_tax/per_case. Clamp in-band [1/3,3]× anti-unidad-caja, UPDATE-only,
 * churn-free.
 *
 * BACKSTOP nocturno (full-catálogo). La frescura AL-MOMENTO la da el hop-2 `normalizeCost` en
 * services/feeds-ingest/apply-handlers.js (dispara al llegar un cambio de kdii o kdik al ODS). Ambos
 * comparten la MISMA computación: services/feeds-ingest/ods-derived (single source of truth).
 * Ver feedback_ods_derived_realtime_no_batch_lag.
 *
 *   node database/importers/kepler/repoint-catalog-cost.js            # dry-run
 *   node database/importers/kepler/repoint-catalog-cost.js --apply
 */
const { Client } = require('pg');
const { normalizeCost } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== REPOINT costo kepler_ods → catalog.products (${APPLY ? 'APPLY' : 'DRY-RUN'}) — vía ods-derived (al-momento share) ===`);
    const ok = (await db.query(`SELECT to_regclass('kepler_ods.kdik') a, to_regclass('kepler_ods.kdii') b`)).rows[0];
    if (!ok.a || !ok.b) { console.error('❌ kepler_ods.kdik/kdii ausente — abortando (¿DST sin ODS?)'); process.exitCode = 1; return; }
    if (!APPLY) { console.log('DRY-RUN: delega el full-catálogo en normalizeCost(null). Corré --apply.'); return; }
    const n = await normalizeCost(db, M, null);
    console.log(`[APPLY] ${n} costos actualizados (en banda, churn-free, full).`);
  } catch (e) {
    console.error('\nERROR:', e.message);
    if (e.detail) console.error('  detail:', e.detail);
    process.exitCode = 1;
  } finally { await db.end().catch(() => {}); }
})();
