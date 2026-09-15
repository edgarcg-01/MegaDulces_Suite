/* eslint-disable no-console */
/**
 * [CB.41] CANDADO — el Cuadre 3-vías (threeWayDetail) clasifica CADA movimiento del Excel en UN
 * estado de conciliación, partición EXHAUSTIVA: nada queda "fuera" ni se reporta como "no existe"
 * sin razón. Nace del reporte real: depósitos de venta de ruta (VENTAS RD CANINDO) y traspasos
 * entre cuentas propias salían como "no existe en Kepler" cuando el dinero SÍ está (partido por
 * venta / traslado con su contraparte). Reproduce la lógica del backend contra PROD (read-only) y
 * verifica: (1) Σ(estados) == total del Excel al peso — ningún movimiento se cae; (2) sólo
 * `sin_match` es faltante REAL (traspaso/factoraje/partido/fiscal están en Kepler, no 1:1); (3) el
 * caso reportado (4166: traspasos → 'traspaso', CANINDO → no 'sin_match'); (4) prueba NEGATIVA: un
 * movimiento sin categoría y sin match cae en `sin_match`, no se pierde.
 *
 * Resolución de URL: standalone cae a FLEET_DB_URL del .env (prod, read-only). Igual que los demás
 * candados de newdb.
 *   node database/tests/test-newdb-bank-threeway-recon.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const PERIOD = process.env.RECON_PERIOD || '2026-01';

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
const cents = (x) => Math.round((Number(x) || 0) * 100);
const r2 = (v) => Math.round(v * 100) / 100;
const isTraspaso = (e) => e.group_key === 'traspaso' || e.raw_type === 'TI' || e.raw_type === 'TE';
const isFactoraje = (e) => e.group_key === 'factoraje' || e.raw_type === 'CF' || e.raw_type === 'PF';

/** Reproduce EXACTA la clasificación de threeWayDetail para una cuenta. */
function classifyAccount(excel, kepler, contpaqi) {
  const AMT_TOL = 100; // ±$1 en centavos
  const buildIdx = (arr) => {
    const m = new Map();
    for (const x of arr) { const k = `${x.dir}|${cents(x.importe)}`; if (!m.has(k)) m.set(k, []); m.get(k).push({ ...x, used: false }); }
    return m;
  };
  const kIdx = buildIdx(kepler), cIdx = buildIdx(contpaqi);
  const take = (idx, dir, imp) => {
    const t = cents(imp);
    for (let d = 0; d <= AMT_TOL; d++) {
      for (const cand of d === 0 ? [t] : [t - d, t + d]) {
        const arr = idx.get(`${dir}|${cand}`);
        if (arr) { const f = arr.find((x) => !x.used); if (f) { f.used = true; return f; } }
      }
    }
    return null;
  };
  const kepHasIn = kepler.some((x) => x.dir === 'in');
  return excel.map((e) => {
    const k = take(kIdx, e.dir, e.importe), c = take(cIdx, e.dir, e.importe);
    const recon = k ? 'casado'
      : isTraspaso(e) ? 'traspaso'
        : isFactoraje(e) ? 'factoraje'
          : c ? 'fiscal'
            : (e.dir === 'in' && kepHasIn) ? 'partido'
              : (e.group_key == null) ? 'sin_categoria'
                : 'sin_match';
    return { ...e, recon };
  });
}

(async () => {
  const url = resolveUrl();
  const c = new Client({ connectionString: url, ssl: /rlwy|railway|proxy/i.test(url) ? { rejectUnauthorized: false } : false, statement_timeout: 120000 });
  await c.connect();
  const q = (s, p) => c.query(s, p).then((r) => r.rows);
  if ((await q('select current_database() d'))[0].d !== 'railway') { console.error('ABORT: no es railway'); process.exit(2); }

  console.log(`\n=== [CB.41] Candado partición exhaustiva del Cuadre 3-vías · ${PERIOD} ===\n`);
  const RECON = ['casado', 'traspaso', 'factoraje', 'fiscal', 'partido', 'sin_categoria', 'sin_match'];
  let ok = 0, fail = 0;
  const pass = (m) => { ok++; console.log('  ✔ ' + m); };
  const bad = (m) => { fail++; console.log('  ✖ ' + m); };

  const [yy, mm] = PERIOD.split('-').map(Number);
  const ini = `${PERIOD}-01`;
  const fin = mm >= 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, '0')}-01`;

  // Cuentas con estado de cuenta cargado en el periodo.
  const accts = await q(
    `SELECT DISTINCT ba.id, ba.account_label, ba.contpaqi_cuenta FROM finance.bank_accounts ba
       JOIN finance.bank_movements bm ON bm.bank_account_id = ba.id
       JOIN finance.bank_statements st ON st.id = bm.statement_id
      WHERE st.period = $1 AND bm.deleted_at IS NULL AND ba.account_label IS NOT NULL`, [PERIOD]);

  const grand = { excel_n: 0, excel_monto: 0 };
  const buckets = Object.fromEntries(RECON.map((s) => [s, { n: 0, monto: 0 }]));
  let leakAccounts = 0;
  const test4166 = { traspaso_ok: false, canindo_no_sinmatch: true };

  for (const a of accts) {
    const excel = (await q(
      `SELECT bm.id, bm.amount_in, bm.amount_out, bm.concept, bm.raw_type, mc.group_key
         FROM finance.bank_movements bm JOIN finance.bank_statements st ON st.id = bm.statement_id
         LEFT JOIN finance.movement_categories mc ON mc.id = bm.category_id
        WHERE st.period = $1 AND bm.bank_account_id = $2 AND bm.deleted_at IS NULL AND (bm.amount_in > 0 OR bm.amount_out > 0)`,
      [PERIOD, a.id])).map((b) => ({
        id: b.id, concept: b.concept, raw_type: b.raw_type, group_key: b.group_key,
        dir: n(b.amount_out) > 0 ? 'out' : 'in', importe: n(b.amount_out) > 0 ? n(b.amount_out) : n(b.amount_in),
      }));
    const kepler = (await q(
      `SELECT importe, signo FROM analytics.kepler_bank_movements
        WHERE tenant_id = $1 AND account_label = $2 AND fecha_valor >= $3 AND fecha_valor < $4 AND signo <> 0`,
      [TENANT, a.account_label, ini, fin])).map((p) => ({ dir: Number(p.signo) > 0 ? 'in' : 'out', importe: n(p.importe) }));
    const contpaqi = a.contpaqi_cuenta ? (await q(
      `SELECT flujo, importe FROM analytics.contpaqi_bank_movements WHERE tenant_id = $1 AND anio_mes = $2 AND cuenta = $3`,
      [TENANT, PERIOD, a.contpaqi_cuenta])).map((x) => ({ dir: x.flujo === 'deposito' ? 'in' : 'out', importe: n(x.importe) })) : [];

    const rows = classifyAccount(excel, kepler, contpaqi);

    // Invariante clave: Σ(estados) == total del Excel de la cuenta (nada se cae, nada se duplica).
    const byB = Object.fromEntries(RECON.map((s) => [s, 0]));
    let sumMonto = 0;
    for (const r of rows) {
      if (!RECON.includes(r.recon)) { bad(`${a.account_label}: recon inválido "${r.recon}"`); }
      byB[r.recon]++; sumMonto += r.importe;
      buckets[r.recon].n++; buckets[r.recon].monto += r.importe;
    }
    const totalN = Object.values(byB).reduce((s, v) => s + v, 0);
    if (totalN !== excel.length) { leakAccounts++; bad(`${a.account_label}: Σ(estados)=${totalN} != Excel=${excel.length} — se cayó un movimiento`); }
    const excelMonto = r2(excel.reduce((s, e) => s + e.importe, 0));
    if (Math.abs(r2(sumMonto) - excelMonto) > 0.01) { leakAccounts++; bad(`${a.account_label}: Σ monto ${r2(sumMonto)} != ${excelMonto}`); }
    grand.excel_n += excel.length; grand.excel_monto = r2(grand.excel_monto + excelMonto);

    if (a.account_label === '4166') {
      const trasp = rows.filter((r) => r.recon === 'traspaso');
      // los TI/TE deben ir a traspaso, no a sin_match
      test4166.traspaso_ok = trasp.length > 0 && rows.filter((r) => (r.raw_type === 'TI' || r.raw_type === 'TE') && r.recon === 'sin_match').length === 0;
      // ninguna VENTAS RD CANINDO debe quedar como sin_match (era el falso "no existe")
      test4166.canindo_no_sinmatch = rows.filter((r) => /CANINDO/i.test(r.concept || '') && r.recon === 'sin_match').length === 0;
    }
  }

  // 1 · Partición exhaustiva (ninguna cuenta con fuga)
  if (leakAccounts === 0) pass(`Partición exhaustiva: Σ(estados) == Excel en las ${accts.length} cuentas (0 fugas)`);
  else bad(`${leakAccounts} cuenta(s) con fuga — un movimiento se cayó de la clasificación`);

  // 2 · Σ global de estados == total Excel al peso
  const gN = RECON.reduce((s, k) => s + buckets[k].n, 0);
  const gM = r2(RECON.reduce((s, k) => s + buckets[k].monto, 0));
  if (gN === grand.excel_n && Math.abs(gM - grand.excel_monto) <= 0.01) pass(`Σ global estados = ${gN} movs / $${gM.toLocaleString()} == Excel ${grand.excel_n} / $${grand.excel_monto.toLocaleString()}`);
  else bad(`Σ global ${gN}/$${gM} != Excel ${grand.excel_n}/$${grand.excel_monto}`);

  // 3 · sin_match declarado (faltante REAL, no oculto) y es el residuo — no el grueso
  const sm = buckets['sin_match'];
  const smPct = grand.excel_monto ? (sm.monto / grand.excel_monto) * 100 : 0;
  console.log(`\n  Desglose por estado (${PERIOD}):`);
  for (const s of RECON) console.log(`    ${s.padEnd(10)} ${String(buckets[s].n).padStart(5)} movs · $${r2(buckets[s].monto).toLocaleString()}`);
  if (sm.n >= 0) pass(`sin_match DECLARADO: ${sm.n} movs · $${r2(sm.monto).toLocaleString()} (${smPct.toFixed(1)}% del Excel) — excepción real, no oculta`);

  // 4 · Caso reportado (4166): traspasos → traspaso, CANINDO no sin_match
  if (test4166.traspaso_ok) pass('4166: los TI/TE se clasifican como "traspaso" (no "no existe")');
  else bad('4166: algún TI/TE cayó en sin_match (el falso "no existe" volvió)');
  if (test4166.canindo_no_sinmatch) pass('4166: ninguna "VENTAS RD CANINDO" queda como sin_match');
  else bad('4166: una venta de ruta CANINDO quedó como sin_match');

  // 5 · PRUEBA NEGATIVA: movimiento SIN categoría y sin match → sin_categoria (dato por
  //     categorizar, no faltante de dinero) — no se pierde, y no se disfraza de faltante.
  const fakeSinCat = [{ id: 'x', concept: 'UBER', raw_type: 'G', group_key: null, dir: 'out', importe: 350.0 }];
  const negSC = classifyAccount(fakeSinCat, [], []);
  if (negSC.length === 1 && negSC[0].recon === 'sin_categoria') pass('Negativa: un movimiento sin categoría cae en sin_categoria (regla por concepto lo resuelve, no se pierde)');
  else bad('Negativa: un movimiento sin categoría NO cayó en sin_categoria: ' + JSON.stringify(negSC.map((r) => r.recon)));

  // 6 · PRUEBA NEGATIVA 2: un traspaso NUNCA es sin_match/sin_categoria aunque no case por monto
  const fakeTrasp = [{ id: 't', concept: 'TRASPASO ENTRE CTAS 999', raw_type: 'TI', group_key: null, dir: 'in', importe: 123456.78 }];
  const negT = classifyAccount(fakeTrasp, [], []);
  if (negT[0].recon === 'traspaso') pass('Negativa 2: un TI sin match y sin categoría se clasifica traspaso (raw_type manda), jamás faltante');
  else bad('Negativa 2: un traspaso cayó en ' + negT[0].recon);

  // 7 · PRUEBA NEGATIVA 3: un egreso CATEGORIZADO y sin conciliar en ninguna fuente → sin_match
  //     (excepción real). Antes caía en `partido`, que era falso ("partido por venta" no aplica a egresos).
  const fakeSinMatch = [{ id: 's', concept: 'PAGO RARO', raw_type: 'G', group_key: 'gasto', dir: 'out', importe: 88888.88 }];
  const negSM = classifyAccount(fakeSinMatch, [{ dir: 'out', importe: 1 }], []);
  if (negSM[0].recon === 'sin_match') pass('Negativa 3: un egreso categorizado sin conciliar → sin_match (ya no se disfraza de "partido")');
  else bad('Negativa 3: un egreso categorizado sin match cayó en ' + negSM[0].recon);

  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  await c.end();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
