/* eslint-disable no-console */
/**
 * CB.1 — Importer del estado de cuenta bancario (workbook Excel "CUENTAS …") →
 * finance.bank_statements + finance.bank_movements (ADR-033).
 *
 * Lee el .xlsx con exceljs (19 cuentas de banco + FACTORAJE; CAJA GENERAL tiene otro
 * layout → se salta con aviso, CB.1.1). Por cada hoja:
 *   - resuelve la cuenta (finance.bank_accounts por alias = nombre de hoja),
 *   - crea/actualiza el bank_statement del periodo (totales in/out),
 *   - traduce cada línea (M + C + concepto) → categoría LIMPIA (finance.movement_categories)
 *     desenredando los códigos sobrecargados del Excel (612=SUA/comisión/capital/…),
 *   - UPSERT de cada movimiento por client_uuid (hash de contenido) — NO DELETE.
 *
 * Validación: totales por cuenta (depósitos) vs la hoja CONCENTRADO (INGRESOS).
 *
 *   node database/importers/kepler/import-bank-statement.js --file "01 ENERO 2026.xlsx"            # dry-run
 *   node database/importers/kepler/import-bank-statement.js --file "01 ENERO 2026.xlsx" --apply
 *   ... --period 2026-01     # override (default: se deriva del nombre del archivo)
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');
const { Client } = require('pg');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 500;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const FILE = arg('file', '01 ENERO 2026.xlsx');

const MONTHS_ES = { ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06', JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12' };
function derivePeriod(file) {
  const m = file.toUpperCase().match(/(ENERO|FEBRERO|MARZO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)\s+(\d{4})/);
  return m ? `${m[2]}-${MONTHS_ES[m[1]]}` : null;
}
const PERIOD = arg('period', derivePeriod(FILE));

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const normKey = (s) => norm(s).toUpperCase();
const money = (v) => { if (typeof v === 'number') return v; const t = String(v ?? '').replace(/[$,\s]/g, '').trim(); const n = Number(t); return Number.isFinite(n) ? n : 0; };
const cellVal = (row, i) => { if (!i) return null; const v = row.getCell(i).value; return v && typeof v === 'object' && v.result !== undefined ? v.result : v; };
function excelDate(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// Traduce (M, C, concepto) del Excel → código de categoría limpia. Lo ambiguo → sin_clasificar.
function classify(M, C, concept) {
  const m = normKey(M), c = normKey(C), t = normKey(concept);
  if (m === 'TE' || m === 'TI' || c === '-') return 'traspaso_entre_cuentas';
  if (m === 'CF') return 'compra_factoraje';
  if (m === 'PF') return 'pago_factoraje';
  if (m === 'DS') return 'devolucion_spei';
  if (m === 'ID') return 'ingreso_devolucion';
  if (m === 'I') return /\bDEV|DEVOLUC/.test(t) ? 'ingreso_devolucion' : 'cobranza';
  if (c === '102') return 'cobranza';
  if (m === 'C' || c === '510' || c === '501') return 'compra_mercancia';
  if (c === '610') return 'nomina';
  if (c === '147') return 'iva_acreditable';
  if (c === '631') return 'pension_alimenticia';
  if (c === '621') return 'gasto_admin';
  if (c === '612') {
    if (/SUA|IMSS/.test(t)) return 'imss_sua';
    if (/COMISI|COMISION|MEMBRES|COBRO/.test(t)) return 'comision_bancaria';
    if (/CAPITAL|CREDITO|CRÉDITO|PRESTAMO|PRÉSTAMO/.test(t)) return 'pago_credito';
    if (/ARRENDA/.test(t)) return 'renta';
    if (/PAN AMERICANO|TRASLADO|VALORES/.test(t)) return 'traslado_valores';
    return 'sin_clasificar';
  }
  if (c === '613') {
    if (/CAJA DE AHORRO|CAJA AHORRO/.test(t)) return 'caja_ahorro';
    if (/NOMINA|NÓMINA|\bNOM\b/.test(t)) return 'nomina';
    return 'sin_clasificar';
  }
  return 'sin_clasificar';
}

async function bulkUpsertMovements(db, rows) {
  const cols = ['tenant_id', 'statement_id', 'bank_account_id', 'movement_date', 'category_id', 'raw_type', 'raw_code', 'sucursal', 'concept', 'amount_in', 'amount_out', 'running_balance', 'client_uuid', 'source_file'];
  const N = cols.length;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((r, ri) => { vals.push(`(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`); params.push(...r); });
    await db.query(
      `INSERT INTO finance.bank_movements (${cols.join(',')}) VALUES ${vals.join(',')}
       ON CONFLICT (tenant_id, client_uuid) DO UPDATE SET
         statement_id=EXCLUDED.statement_id, bank_account_id=EXCLUDED.bank_account_id, movement_date=EXCLUDED.movement_date,
         category_id=EXCLUDED.category_id, raw_type=EXCLUDED.raw_type, raw_code=EXCLUDED.raw_code, sucursal=EXCLUDED.sucursal,
         concept=EXCLUDED.concept, amount_in=EXCLUDED.amount_in, amount_out=EXCLUDED.amount_out,
         running_balance=EXCLUDED.running_balance, source_file=EXCLUDED.source_file, updated_at=now()`,
      params);
  }
}

(async () => {
  if (!fs.existsSync(FILE)) { console.error(`No existe el archivo: ${FILE}`); process.exit(2); }
  if (!PERIOD) { console.error('No pude derivar el periodo; pasá --period YYYY-MM'); process.exit(2); }
  console.log(`\n=== CB.1 Import banco (${APPLY ? 'APPLY' : 'DRY-RUN'}) — ${FILE} · periodo ${PERIOD} ===\n`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);
  const sheets = wb.worksheets.filter((s) => !/TOTAL MOV|CONCENTRADO|FilterDatabase/i.test(s.name));

  const db = new Client({ connectionString: DST });
  await db.connect();
  await db.query('BEGIN');
  await db.query(`SET LOCAL app.tenant_id = '${MEGA}'`);

  // catálogos desde DB
  const catMap = new Map((await db.query(`SELECT id, code, group_key FROM finance.movement_categories WHERE tenant_id=$1`, [MEGA])).rows.map((r) => [r.code, { id: r.id, group: r.group_key }]));
  const acctMap = new Map((await db.query(`SELECT id, alias, account_label, kind FROM finance.bank_accounts WHERE tenant_id=$1`, [MEGA])).rows.map((r) => [normKey(r.alias), r]));

  const summary = [];
  const byGroup = {}; // group_key → { in, out, n }
  let grandIn = 0, grandOut = 0, grandUncat = 0, grandRows = 0;

  for (const ws of sheets) {
    // header
    let hRow = 0, col = {};
    for (let r = 1; r <= 8; r++) { const u = ws.getRow(r).values.map((v) => normKey(v)); if (u.some((v) => v === 'FECHA')) { hRow = r; u.forEach((v, i) => { if (v) col[v] = i; }); break; } }
    const acct = acctMap.get(normKey(ws.name));
    if (!hRow || !col['FECHA'] || (!col['RETIRO'] && !col['DEPOSITO'])) { summary.push({ hoja: ws.name, nota: 'layout no estándar — skip' }); continue; }
    if (!acct) { summary.push({ hoja: ws.name, nota: 'cuenta no seedeada — skip' }); continue; }
    const ci = { fecha: col['FECHA'], m: col['M'], s: col['S'], c: col['C'], prov: col['PROVEEDOR'], ret: col['RETIRO'], dep: col['DEPOSITO'], saldo: col['SALDO'] };

    const movRows = [];
    const seen = new Map();
    let tin = 0, tout = 0, uncat = 0, lastBal = null;
    for (let r = hRow + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const date = excelDate(cellVal(row, ci.fecha));
      if (!date) continue;
      const amtIn = money(cellVal(row, ci.dep)), amtOut = money(cellVal(row, ci.ret));
      if (amtIn === 0 && amtOut === 0) continue;
      const M = norm(cellVal(row, ci.m)), C = norm(cellVal(row, ci.c)), S = norm(cellVal(row, ci.s));
      const concept = norm(cellVal(row, ci.prov));
      const bal = ci.saldo ? money(cellVal(row, ci.saldo)) : null;
      const catCode = classify(M, C, concept);
      const cat = catMap.get(catCode);
      const catId = catCode === 'sin_clasificar' ? null : (cat ? cat.id : null);
      const group = catCode === 'sin_clasificar' ? 'sin_clasificar' : (cat ? cat.group : '?');
      if (!catId) uncat++;
      (byGroup[group] ||= { in: 0, out: 0, n: 0 }); byGroup[group].in += amtIn; byGroup[group].out += amtOut; byGroup[group].n++;
      tin += amtIn; tout += amtOut; if (bal !== null) lastBal = bal;

      const contentKey = `${acct.account_label}|${PERIOD}|${date}|${M}|${C}|${concept}|${amtIn}|${amtOut}`;
      const occ = (seen.get(contentKey) || 0) + 1; seen.set(contentKey, occ);
      const clientUuid = crypto.createHash('sha1').update(`${contentKey}|${occ}`).digest('hex');

      movRows.push([MEGA, null /*statement_id set on apply*/, acct.id, date, catId, M || null, C || null, S || null, concept || null, amtIn, amtOut, bal, clientUuid, FILE]);
    }

    grandIn += tin; grandOut += tout; grandUncat += uncat; grandRows += movRows.length;
    summary.push({ hoja: ws.name, movs: movRows.length, depositos: Math.round(tin), retiros: Math.round(tout), sin_clasif: uncat });

    if (APPLY) {
      const st = await db.query(
        `INSERT INTO finance.bank_statements (tenant_id, bank_account_id, period, closing_balance, total_in, total_out, source_file, status, imported_at, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'imported',now(),'import-bank-statement')
         ON CONFLICT (tenant_id, bank_account_id, period) DO UPDATE SET
           closing_balance=EXCLUDED.closing_balance, total_in=EXCLUDED.total_in, total_out=EXCLUDED.total_out,
           source_file=EXCLUDED.source_file, imported_at=now(), updated_at=now()
         RETURNING id`,
        [MEGA, acct.id, PERIOD, lastBal ?? 0, Math.round(tin * 100) / 100, Math.round(tout * 100) / 100, FILE]);
      const stmtId = st.rows[0].id;
      for (const mr of movRows) mr[1] = stmtId;
      await bulkUpsertMovements(db, movRows);
    }
  }

  console.table(summary);
  const f0 = (n) => Math.round(n).toLocaleString('en');
  console.log('\n=== DESGLOSE POR GRUPO (valida parse + clasificación vs CONCENTRADO) ===');
  console.table(Object.fromEntries(Object.entries(byGroup).sort((a, b) => (b[1].in + b[1].out) - (a[1].in + a[1].out))
    .map(([k, v]) => [k, { movs: v.n, depositos: '$' + f0(v.in), retiros: '$' + f0(v.out) }])));
  console.log('  Referencia CONCENTRADO enero 2026: ingreso $52,949,859 · compra $43,534,807 · gasto $6,584,511 · traspaso TI=TE $25,400,000 c/u.');
  console.log(`\nTOTAL: ${grandRows} movs · depósitos $${f0(grandIn)} · retiros $${f0(grandOut)} · sin_clasificar ${grandUncat} (${(100 * grandUncat / Math.max(1, grandRows)).toFixed(1)}%)`);

  if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); }
  else { await db.query('COMMIT'); console.log('\n[APPLY] COMMIT.'); }
  await db.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
