/* eslint-disable no-console */
/**
 * RA.2 — Umbrales de reorden Kepler (kdii c33=mín/c34=reorden/c35=máx, en PIEZAS) → commercial.reorder_policy
 * (warehouse×product, source='kepler'). Ladder sano (c34<>0, c35>1, c35>=c34). sucursal → warehouses.kepler_code.
 *
 * BACKSTOP nocturno (full-catálogo). La frescura AL-MOMENTO la da el hop-2 `normalizeReorder` en
 * services/feeds-ingest/apply-handlers.js (dispara al llegar un cambio de kdii al ODS). Ambos comparten la
 * MISMA computación: services/feeds-ingest/ods-derived (single source of truth). Lee `kepler_ods` (ya NO
 * per-branch — mata la dependencia de las 6 conexiones .245/remotas). NUNCA pisa source='manual'.
 * Ver feedback_ods_derived_realtime_no_batch_lag.
 *
 *   node database/importers/kepler/import-reorder-policy.js          # dry-run
 *   node database/importers/kepler/import-reorder-policy.js --apply
 */
const { Client } = require('pg');
const { normalizeReorder } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== Reorden kepler_ods.kdii → commercial.reorder_policy (${APPLY ? 'APPLY' : 'DRY-RUN'}) — vía ods-derived (al-momento share) ===`);
    if (!APPLY) { console.log('DRY-RUN: delega el full-catálogo en normalizeReorder(null). Corré --apply.'); return; }
    const n = await normalizeReorder(db, M, null);
    console.log(`[APPLY] ${n} filas de reorden upserted (churn-free, full).`);
  } catch (e) { console.error('\nERROR:', e.message); process.exitCode = 1; }
  finally { await db.end().catch(() => {}); }
})();
