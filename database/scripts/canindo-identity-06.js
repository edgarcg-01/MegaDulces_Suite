/* eslint-disable no-console */
/**
 * Canindo — migración de IDENTIDAD MD-50 → 06 (simetría total con las hermanas Kepler 01-05).
 *
 * Canindo migró su POS de Wincaja a Kepler. Su warehouse tenía code='MD-50' (legacy Wincaja) con
 * kepler_code='06'; el resto de las sucursales Kepler tienen code==kepler_code. Esta migración
 * alinea Canindo: code MD-50 → 06. El warehouse_id (uuid) NO cambia → todo lo que referencia por
 * uuid queda intacto; solo se actualiza el CODE texto y el histórico de tickets que quedó bajo 'MD-50'.
 *
 * Inventario de 'MD-50' texto en datos (scan 2026-08-18): SOLO 2 lugares →
 *   - commercial.warehouses.code (1 fila = el warehouse)
 *   - analytics.store_live_tickets.warehouse_code (1940 filas = histórico Wincaja de Canindo)
 * (users/stock_movements/etc. NO tienen 'MD-50' texto → sin más UPDATEs.)
 *
 * Idempotente (WHERE code='MD-50' → si ya migró, no toca). Dry-run default; --apply escribe.
 * OJO ORDEN: correr ESTE script ANTES de la próxima corrida de importers (varios mapean b.code
 * → warehouse por `code`; con code='06' resuelven Canindo directo).
 *
 *   node database/scripts/canindo-identity-06.js            # dry-run
 *   node database/scripts/canindo-identity-06.js --apply    # commit
 */
const { Client } = require('pg'); const fs = require('fs');
function prodUrl() {
  for (const f of ['C:/KeplerRunner/run-livefast-loop.cmd', 'C:/KeplerRunner/run-feeds.cmd']) {
    try { const t = fs.readFileSync(f, 'utf8'); const m = t.match(/set\s+"?DATABASE_URL_NEW=([^"\r\n]+)"?/i); if (m && /rlwy|proxy/.test(m[1])) return m[1].trim(); } catch { /* next */ }
  }
  throw new Error('no encontré la URL de prod');
}
const APPLY = process.argv.includes('--apply');
const DST = process.env.DST_URL || prodUrl();
const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  const p = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await p.connect();
  console.log(`\n=== Canindo identidad MD-50 → 06 (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  // Estado actual
  const wh = (await p.query(`SELECT id, code, name, kepler_code, wincaja_source_branch FROM commercial.warehouses
      WHERE tenant_id=$1 AND (code='MD-50' OR code='06')`, [TENANT])).rows;
  console.log('  warehouse:'); wh.forEach((r) => console.log(`    code=${r.code} name=${r.name} kepler=${r.kepler_code} wincaja=${r.wincaja_source_branch} id=${String(r.id).slice(0, 8)}`));
  const already = wh.some((r) => r.code === '06');
  const hasMd50 = wh.some((r) => r.code === 'MD-50');

  // guard: no colisión (no debe existir OTRO warehouse code='06')
  if (hasMd50 && already) { console.log('\n  ⚠ Ya existe un warehouse code=06 distinto de MD-50 — abortar (colisión).'); await p.end(); return; }
  if (!hasMd50) { console.log('\n  ✅ Nada que migrar (no hay warehouse code=MD-50). Idempotente.'); }

  const tk = (await p.query(`SELECT warehouse_code, count(*)::int n FROM analytics.store_live_tickets
      WHERE warehouse_code IN ('MD-50','06') GROUP BY 1 ORDER BY 1`)).rows;
  console.log('\n  store_live_tickets:'); tk.forEach((r) => console.log(`    ${r.warehouse_code}: ${r.n}`));

  if (!APPLY) { console.log('\n  DRY-RUN — corré con --apply para escribir.'); await p.end(); return; }

  await p.query('BEGIN');
  try {
    const u1 = await p.query(`UPDATE commercial.warehouses SET code='06', name='Canindo', updated_at=now()
        WHERE tenant_id=$1 AND code='MD-50'`, [TENANT]);
    const u2 = await p.query(`UPDATE analytics.store_live_tickets SET warehouse_code='06'
        WHERE warehouse_code='MD-50'`);
    // Crosswalk Wincaja: Canindo '50' ahora mapea a Kepler '06'. Efecto: los importers Wincaja
    // que filtran por `kepler_code IS NULL` (ej. import-wincaja-receipts) dejan de procesar
    // Canindo — sus recepciones ya vienen de Kepler (import-goods-receipts incluye '06').
    const u3 = await p.query(`UPDATE wincaja.branches SET kepler_code='06'
        WHERE tenant_id=$1 AND source_branch='50' AND coalesce(kepler_code,'')<>'06'`, [TENANT]);
    await p.query('COMMIT');
    console.log(`\n  ✅ APPLY: warehouse ${u1.rowCount} (code→06, name→Canindo) · store_live_tickets ${u2.rowCount} (MD-50→06) · wincaja.branches ${u3.rowCount} (kepler_code→06)`);
  } catch (e) { await p.query('ROLLBACK').catch(() => {}); console.error('\n  ERROR (rollback):', e.message); process.exitCode = 1; }
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
