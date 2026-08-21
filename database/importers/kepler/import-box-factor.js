/* eslint-disable no-console */
/**
 * RA-PRO.37 — Factor de caja AUTORITATIVO desde Kepler `kdii.c84` (piezas por caja, MAX>1 retail) →
 * analytics.product_box_factor. `import-replenishment-plan.js` lo usa como tope del uxc.
 *
 * BACKSTOP nocturno (full-catálogo). La frescura AL-MOMENTO la da el hop-2 `normalizeBoxFactor` en
 * services/feeds-ingest/apply-handlers.js (dispara al llegar un cambio de kdii al ODS). Ambos comparten la
 * MISMA computación: services/feeds-ingest/ods-derived (single source of truth). Lee `kepler_ods` (ya NO
 * per-branch). Ver feedback_ods_derived_realtime_no_batch_lag.
 *
 *   node database/importers/kepler/import-box-factor.js            # dry-run
 *   node database/importers/kepler/import-box-factor.js --apply
 */
const { Client } = require('pg');
const { normalizeBoxFactor } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== BOX FACTOR (kdii.c84) → analytics.product_box_factor (${APPLY ? 'APPLY' : 'DRY-RUN'}) — vía ods-derived (al-momento share) ===`);
    if (!APPLY) { console.log('DRY-RUN: delega el full-catálogo en normalizeBoxFactor(null). Corré --apply.'); return; }
    const n = await normalizeBoxFactor(db, M, null);
    console.log(`[APPLY] ${n} filas escritas/cambiadas (churn-free, full).`);
  } catch (e) { console.error('\nERROR:', e.message); process.exitCode = 1; }
  finally { await db.end().catch(() => {}); }
})();
