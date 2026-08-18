/* eslint-disable no-console */
/**
 * Normalización ALMACÉN — Paso 2 BATCH 2: backfill de `warehouse_id` (uuid) desde `sucursal` (texto)
 * para las tablas de la migración 20260818160000. Aditivo, idempotente (solo filas warehouse_id NULL).
 * Dry-run default; `--apply` escribe. Lee prod del runner (patrón prodUrl, no la imprime).
 *
 * Resolución: commercial.warehouses por `code` OR `kepler_code` OR `wincaja_source_branch`, scoped
 * por tenant (Kepler 00-05 → code; Canindo 06 → kepler_code→MD-50; wincaja 30/32/50 → MD-XX).
 *
 *   node database/scripts/backfill-warehouse-id-batch2.js            # dry-run (cobertura)
 *   node database/scripts/backfill-warehouse-id-batch2.js --apply
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
const TABLES = [
  ['analytics', 'ap_provider'], ['analytics', 'bank_postings'], ['analytics', 'erp_collections'],
  ['analytics', 'erp_goods_receipt_lines'], ['analytics', 'erp_goods_receipts'], ['analytics', 'erp_purchase_adjustments'],
  ['analytics', 'erp_supplier_payments'], ['analytics', 'expense_doc_chain'], ['analytics', 'expense_document_lines'],
  ['analytics', 'expense_documents'], ['analytics', 'expense_entries'], ['analytics', 'expense_findings'],
  ['analytics', 'expense_requests'], ['analytics', 'gl_poliza_lines'], ['analytics', 'gl_polizas'],
  ['analytics', 'kepler_bank_movements'], ['analytics', 'ledger_monthly'], ['analytics', 'sales_by_channel_monthly'],
  ['finance', 'expense_comprobaciones'], ['finance', 'goods_receipt_proofs'], ['finance', 'supplier_payment_proofs'],
];
const RESOLVE = `w.tenant_id = t.tenant_id AND w.deleted_at IS NULL AND (
    w.code = btrim(t.sucursal) OR w.kepler_code = btrim(t.sucursal) OR w.wincaja_source_branch = btrim(t.sucursal))`;

(async () => {
  const p = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 180000 });
  await p.connect();
  console.log(`\n=== Backfill warehouse_id BATCH 2 (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
  let totalW = 0, totalM = 0;
  for (const [sch, tbl] of TABLES) {
    const reg = await p.query(`SELECT to_regclass($1) t`, [`${sch}.${tbl}`]);
    if (!reg.rows[0].t) { console.log(`  ${sch}.${tbl}: no existe — skip`); continue; }
    const cov = (await p.query(`SELECT count(*) FILTER (WHERE w.id IS NOT NULL)::bigint ok,
             count(*) FILTER (WHERE w.id IS NULL AND t.sucursal IS NOT NULL)::bigint miss, count(*)::bigint total
        FROM "${sch}"."${tbl}" t LEFT JOIN commercial.warehouses w ON ${RESOLVE}`)).rows[0];
    const miss = Number(cov.miss);
    const missVals = miss ? (await p.query(`SELECT DISTINCT btrim(t.sucursal) v FROM "${sch}"."${tbl}" t
        LEFT JOIN commercial.warehouses w ON ${RESOLVE} WHERE w.id IS NULL AND t.sucursal IS NOT NULL ORDER BY 1 LIMIT 12`)).rows.map((r) => r.v) : [];
    console.log(`  ${(`${sch}.${tbl}`).padEnd(34)} total=${String(cov.total).padStart(8)} resuelve=${String(cov.ok).padStart(8)} NO=${String(miss).padStart(6)}${miss ? '  ⚠ ' + missVals.join(',') : '  ✅'}`);
    totalW += Number(cov.ok); totalM += miss;

    if (APPLY) {
      const has = (await p.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='warehouse_id'`, [sch, tbl])).rowCount;
      if (!has) { console.log(`     ⚠ falta columna warehouse_id (¿corriste la migración 20260818160000?) — skip`); continue; }
      const upd = await p.query(`UPDATE "${sch}"."${tbl}" t SET warehouse_id = w.id
          FROM commercial.warehouses w WHERE ${RESOLVE} AND t.warehouse_id IS NULL`);
      console.log(`     → ${upd.rowCount} filas backfilleadas`);
    }
  }
  console.log(`\n  TOTAL: ${totalW.toLocaleString()} resuelven · ${totalM.toLocaleString()} no resuelven`);
  console.log(APPLY ? '\nAPPLY hecho.' : '\nDRY-RUN — migración + este script con --apply para escribir.');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
