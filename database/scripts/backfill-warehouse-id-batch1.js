/* eslint-disable no-console */
/**
 * Normalización ALMACÉN — Paso 2 BATCH 1: backfill de `warehouse_id` (uuid) desde `warehouse_code`
 * (texto) para las tablas de la migración 20260818140000. Aditivo, idempotente (solo toca filas con
 * warehouse_id NULL). Dry-run default (reporta cobertura); `--apply` escribe.
 *
 * Resolución: commercial.warehouses por `code` OR `kepler_code`, scoped por tenant_id, con el caso
 * Canindo (kepler '06' = wincaja '50' = code MD-50) explícito. En --apply además parcha el crosswalk
 * (kepler_code='06' → MD-50) para otros consumidores (store poller, joins futuros).
 *
 *   node database/scripts/backfill-warehouse-id-batch1.js            # dry-run (cobertura)
 *   DST_URL=... node database/scripts/backfill-warehouse-id-batch1.js --apply
 *
 * Sin DST_URL/DATABASE_URL_NEW usa la prod del runner (C:\KeplerRunner, patrón prodUrl, no la imprime).
 */
const { Client } = require('pg'); const fs = require('fs');
function prodUrl() {
  for (const f of ['C:/KeplerRunner/run-livefast-loop.cmd', 'C:/KeplerRunner/run-feeds.cmd']) {
    try { const t = fs.readFileSync(f, 'utf8'); const m = t.match(/set\s+"?DATABASE_URL_NEW=([^"\r\n]+)"?/i); if (m && /rlwy|proxy/.test(m[1])) return m[1].trim(); } catch { /* next */ }
  }
  throw new Error('no encontré la URL de prod');
}
const APPLY = process.argv.includes('--apply');
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW_FORCE || prodUrl();
const TABLES = [
  ['analytics', 'cash_cuts'], ['analytics', 'cash_sessions'], ['analytics', 'erp_promotions'],
  ['analytics', 'erp_shipments'], ['analytics', 'pos_cashiers'], ['analytics', 'pos_ticket_sales'],
  ['analytics', 'store_live_tickets'], ['analytics', 'stock_ledger'], ['identity', 'users'],
];
// Resolución (incluye el caso Canindo explícito → robusto pre/post patch crosswalk).
const RESOLVE = `w.tenant_id = t.tenant_id AND w.deleted_at IS NULL AND (
    w.code = btrim(t.warehouse_code) OR w.kepler_code = btrim(t.warehouse_code)
    OR (w.code = 'MD-50' AND btrim(t.warehouse_code) = '06'))`;

(async () => {
  const p = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await p.connect();
  console.log(`\n=== Backfill warehouse_id BATCH 1 (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

  if (APPLY) {
    // Patch crosswalk Canindo: kepler_code='06' → MD-50 (guard: no colisiona con el UNIQUE parcial).
    const patch = await p.query(`UPDATE commercial.warehouses SET kepler_code='06', updated_at=now()
        WHERE code='MD-50' AND (kepler_code IS NULL OR kepler_code='')
          AND NOT EXISTS (SELECT 1 FROM commercial.warehouses w2 WHERE w2.tenant_id=commercial.warehouses.tenant_id AND w2.kepler_code='06')`);
    console.log(`  crosswalk Canindo: ${patch.rowCount} fila(s) MD-50 → kepler_code='06'\n`);
  }

  let totalW = 0, totalM = 0;
  for (const [sch, tbl] of TABLES) {
    const reg = await p.query(`SELECT to_regclass($1) t`, [`${sch}.${tbl}`]);
    if (!reg.rows[0].t) { console.log(`  ${sch}.${tbl}: tabla no existe — skip`); continue; }
    // cobertura
    const cov = (await p.query(`SELECT count(*) FILTER (WHERE w.id IS NOT NULL)::bigint ok,
             count(*) FILTER (WHERE w.id IS NULL AND t.warehouse_code IS NOT NULL)::bigint miss,
             count(*) FILTER (WHERE t.warehouse_code IS NULL)::bigint nullc, count(*)::bigint total
        FROM "${sch}"."${tbl}" t LEFT JOIN commercial.warehouses w ON ${RESOLVE}`)).rows[0];
    const miss = Number(cov.miss);
    const missVals = miss ? (await p.query(`SELECT DISTINCT btrim(t.warehouse_code) v FROM "${sch}"."${tbl}" t
        LEFT JOIN commercial.warehouses w ON ${RESOLVE} WHERE w.id IS NULL AND t.warehouse_code IS NOT NULL ORDER BY 1 LIMIT 15`)).rows.map((r) => r.v) : [];
    console.log(`  ${(`${sch}.${tbl}`).padEnd(28)} total=${String(cov.total).padStart(9)} resuelve=${String(cov.ok).padStart(9)} NO=${String(miss).padStart(7)} null=${cov.nullc}${miss ? '  ⚠ ' + missVals.join(',') : '  ✅'}`);
    totalW += Number(cov.ok); totalM += miss;

    if (APPLY) {
      const has = (await p.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name='warehouse_id'`, [sch, tbl])).rowCount;
      if (!has) { console.log(`     ⚠ falta columna warehouse_id — ¿corriste la migración 20260818140000? — skip write`); continue; }
      const upd = await p.query(`UPDATE "${sch}"."${tbl}" t SET warehouse_id = w.id
          FROM commercial.warehouses w WHERE ${RESOLVE} AND t.warehouse_id IS NULL`);
      console.log(`     → ${upd.rowCount} filas backfilleadas`);
    }
  }
  console.log(`\n  TOTAL: ${totalW.toLocaleString()} resuelven · ${totalM.toLocaleString()} no resuelven`);
  console.log(APPLY ? '\nAPPLY hecho.' : '\nDRY-RUN — corré la migración + este script con --apply para escribir.');
  await p.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
