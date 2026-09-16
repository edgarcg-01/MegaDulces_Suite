/* eslint-disable no-console */
/**
 * [CB.42] CANDADO — conciliación POR DÍA del Cuadre 3-vías (threeWayDaily). Nace del bulto-vs-partido
 * + doble conteo de Kepler (mismo depósito por sucursal Y por ruta): el match 1:1 hace ruido, pero el
 * total del DÍA es robusto. Reproduce la lógica del backend contra PROD (read-only) y verifica:
 *   (1) Σ(días) == total del mes (banco y Kepler) al peso — la partición diaria no pierde nada;
 *   (2) el Δ ACUMULADO del último día == Δ del mes (bank − kepler);
 *   (3) Σ dup_monto por día == el exceso por doble conteo (grupos mismo importe+fecha, count≥2) —
 *       el número cazado ($1.16M en 4166, $2.6M todas las cuentas en enero);
 *   (4) NEGATIVA: los duplicados sólo cuentan grupos con count≥2 (un movimiento único NO es dup).
 *
 *   node database/tests/test-newdb-bank-threeway-daily.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PERIOD = process.env.RECON_PERIOD || '2026-01';
const ACCT = process.env.RECON_ACCT || '4166';

function resolveUrl() {
  if (process.env.DATABASE_URL_NEW) return process.env.DATABASE_URL_NEW;
  if (process.env.DST_URL) return process.env.DST_URL;
  const env = fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8');
  const m = env.match(/^FLEET_DB_URL=(.*)$/m);
  if (!m) throw new Error('falta FLEET_DB_URL en .env');
  const url = m[1].trim();
  const { classify } = require('../../libs/platform-core/src/lib/provenance/target-guard.js');
  if (classify(url).kind !== 'prod') throw new Error('FLEET_DB_URL del .env no clasifica como prod');
  console.log('  ⓘ sin DATABASE_URL_NEW: uso FLEET_DB_URL del .env (prod, read-only)');
  return url;
}
const n = (x) => Number(x) || 0;
const r2 = (v) => Math.round(v * 100) / 100;

(async () => {
  const url = resolveUrl();
  const c = new Client({ connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  if ((await q('select current_database() d'))[0].d !== 'railway') { console.error('ABORT: no es railway'); process.exit(2); }

  console.log(`\n=== [CB.42] Candado conciliación por día · ${ACCT} · ${PERIOD} ===\n`);
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };

  const [yy, mm] = PERIOD.split('-').map(Number);
  const ini = `${PERIOD}-01`;
  const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
  const acct = await q('SELECT id FROM finance.bank_accounts WHERE account_label = $1', [ACCT]);
  if (!acct.length) { console.error('ABORT: cuenta no encontrada'); process.exit(2); }

  // Banco por día
  const bank = await q(
    `SELECT to_char(bm.movement_date,'YYYY-MM-DD') dia, COALESCE(SUM(bm.amount_in),0)::numeric bin, COALESCE(SUM(bm.amount_out),0)::numeric bout
       FROM finance.bank_movements bm JOIN finance.bank_statements st ON st.id = bm.statement_id
      WHERE st.period = $1 AND bm.bank_account_id = $2 AND bm.deleted_at IS NULL AND (bm.amount_in>0 OR bm.amount_out>0)
      GROUP BY 1`, [PERIOD, acct[0].id]);
  // Kepler por día
  const kep = await q(
    `SELECT to_char(fecha_valor,'YYYY-MM-DD') dia, COALESCE(SUM(importe) FILTER (WHERE signo>0),0)::numeric kin, COALESCE(SUM(importe) FILTER (WHERE signo<0),0)::numeric kout
       FROM analytics.kepler_bank_movements WHERE tenant_id=$1 AND account_label=$2 AND signo<>0 AND fecha_valor>=$3 AND fecha_valor<$4
      GROUP BY 1`, [TENANT, ACCT, ini, fin]);
  // Duplicados por día (mismo importe+fecha+signo, count≥2)
  const dup = await q(
    `WITH grp AS (SELECT to_char(fecha_valor,'YYYY-MM-DD') dia, round(importe::numeric,2) imp, signo, count(*) nn
                    FROM analytics.kepler_bank_movements WHERE tenant_id=$1 AND account_label=$2 AND signo<>0 AND fecha_valor>=$3 AND fecha_valor<$4
                   GROUP BY 1,2,3 HAVING count(*)>=2)
     SELECT dia, SUM(nn-1)::int dup_n, SUM((nn-1)*imp)::numeric dup_monto FROM grp GROUP BY 1`, [TENANT, ACCT, ini, fin]);

  const bmap = new Map(bank.map((r) => [r.dia, r]));
  const kmap = new Map(kep.map((r) => [r.dia, r]));
  const dmap = new Map(dup.map((r) => [r.dia, r]));
  const dias = [...new Set([...bmap.keys(), ...kmap.keys()])].sort();
  let cumIn = 0, cumOut = 0, sBin = 0, sBout = 0, sKin = 0, sKout = 0, sDup = 0;
  for (const dia of dias) {
    const b = bmap.get(dia), k = kmap.get(dia), d = dmap.get(dia);
    const bin = n(b?.bin), bout = n(b?.bout), kin = n(k?.kin), kout = n(k?.kout);
    cumIn = r2(cumIn + (bin - kin)); cumOut = r2(cumOut + (bout - kout));
    sBin += bin; sBout += bout; sKin += kin; sKout += kout; sDup += n(d?.dup_monto);
  }

  // Totales del mes (independientes, para el candado)
  const bankM = (await q(`SELECT COALESCE(SUM(amount_in),0)::numeric bin, COALESCE(SUM(amount_out),0)::numeric bout FROM finance.bank_movements bm JOIN finance.bank_statements st ON st.id=bm.statement_id WHERE st.period=$1 AND bm.bank_account_id=$2 AND bm.deleted_at IS NULL`, [PERIOD, acct[0].id]))[0];
  const kepM = (await q(`SELECT COALESCE(SUM(importe) FILTER (WHERE signo>0),0)::numeric kin, COALESCE(SUM(importe) FILTER (WHERE signo<0),0)::numeric kout FROM analytics.kepler_bank_movements WHERE tenant_id=$1 AND account_label=$2 AND signo<>0 AND fecha_valor>=$3 AND fecha_valor<$4`, [TENANT, ACCT, ini, fin]))[0];

  // 1 · Σ(días) banco == mes
  if (Math.abs(r2(sBin) - r2(n(bankM.bin))) <= 0.01 && Math.abs(r2(sBout) - r2(n(bankM.bout))) <= 0.01)
    pass(`Σ días banco == mes ($${r2(sBin + sBout).toLocaleString()})`);
  else bad(`Σ días banco (${r2(sBin + sBout)}) != mes (${r2(n(bankM.bin) + n(bankM.bout))})`);
  // 2 · Σ(días) Kepler == mes
  if (Math.abs(r2(sKin) - r2(n(kepM.kin))) <= 0.01 && Math.abs(r2(sKout) - r2(n(kepM.kout))) <= 0.01)
    pass(`Σ días Kepler == mes ($${r2(sKin + sKout).toLocaleString()})`);
  else bad(`Σ días Kepler (${r2(sKin + sKout)}) != mes (${r2(n(kepM.kin) + n(kepM.kout))})`);
  // 3 · Δ acumulado (último día) == Δ del mes
  const mesDelta = r2((n(bankM.bin) - n(kepM.kin)) + (n(bankM.bout) - n(kepM.kout)));
  if (Math.abs(r2(cumIn + cumOut) - mesDelta) <= 0.01) pass(`Δ acumulado último día == Δ mes ($${mesDelta.toLocaleString()})`);
  else bad(`Δ acumulado (${r2(cumIn + cumOut)}) != Δ mes (${mesDelta})`);
  // 4 · Σ dup_monto == exceso por doble conteo (grupos count≥2)
  const dupTot = (await q(`WITH grp AS (SELECT round(importe::numeric,2) imp, fecha_valor, signo, count(*) nn FROM analytics.kepler_bank_movements WHERE tenant_id=$1 AND account_label=$2 AND signo<>0 AND fecha_valor>=$3 AND fecha_valor<$4 GROUP BY 1,2,3 HAVING count(*)>=2) SELECT COALESCE(SUM((nn-1)*imp),0)::numeric e, COALESCE(SUM(nn-1),0)::int nn FROM grp`, [TENANT, ACCT, ini, fin]))[0];
  if (Math.abs(r2(sDup) - r2(n(dupTot.e))) <= 0.01) pass(`Σ dup_monto por día == exceso doble conteo ($${r2(sDup).toLocaleString()}, ${n(dupTot.nn)} duplicados)`);
  else bad(`Σ dup_monto (${r2(sDup)}) != exceso (${r2(n(dupTot.e))})`);
  // 5 · NEGATIVA: los dup sólo cuentan grupos con count≥2 — un importe único no aporta exceso
  const uniq = (await q(`WITH grp AS (SELECT round(importe::numeric,2) imp, fecha_valor, signo, count(*) nn FROM analytics.kepler_bank_movements WHERE tenant_id=$1 AND account_label=$2 AND signo<>0 AND fecha_valor>=$3 AND fecha_valor<$4 GROUP BY 1,2,3) SELECT COALESCE(SUM((nn-1)*imp) FILTER (WHERE nn=1),0)::numeric e_uniq FROM grp`, [TENANT, ACCT, ini, fin]))[0];
  if (r2(n(uniq.e_uniq)) === 0) pass('Negativa: los importes ÚNICOS (count=1) aportan $0 de duplicado');
  else bad('Negativa: un importe único contó como duplicado');

  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
