/* eslint-disable no-console */
/**
 * RA-PRO.39 — Precio de LISTA de la CAJA (CJA) por producto → analytics.product_box_price.
 * Fuente kdpv_prod_util: precio de la presentación 'CJA' en el tier de menor volumen (list = min c4);
 * fallback PAQ×factor_sale. Base de `cajas = revenue / cja_price` del sell-out.
 *
 * BACKSTOP nocturno (full-catálogo). La frescura AL-MOMENTO la da el hop-2 `normalizeBoxPrice` en
 * services/feeds-ingest/apply-handlers.js (dispara al llegar un cambio de kdpv al ODS). Ambos comparten la
 * MISMA computación: services/feeds-ingest/ods-derived (single source of truth). Lee `kepler_ods` (ya NO
 * per-branch). Ver feedback_ods_derived_realtime_no_batch_lag.
 *
 *   node database/importers/kepler/import-box-price.js            # dry-run
 *   node database/importers/kepler/import-box-price.js --apply
 */
const { Client } = require('pg');
const { normalizeBoxPrice } = require('../../../services/feeds-ingest/ods-derived');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await db.connect();
  try {
    console.log(`\n=== PRECIO CAJA (kdpv CJA) → analytics.product_box_price (${APPLY ? 'APPLY' : 'DRY-RUN'}) — vía ods-derived (al-momento share) ===`);
    if (!APPLY) { console.log('DRY-RUN: delega el full-catálogo en normalizeBoxPrice(null). Corré --apply.'); return; }
    const n = await normalizeBoxPrice(db, M, null);
    console.log(`[APPLY] ${n} filas escritas/cambiadas (churn-free, full).`);
  } catch (e) { console.error('\nERROR:', e.message); process.exitCode = 1; }
  finally { await db.end().catch(() => {}); }
})();
