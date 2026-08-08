/* eslint-disable no-console */
/**
 * Fase PP.0 — Importer del "PROGRAMA PAGOS 2026" (Tesorería, Excel) → finance.payment_program
 * + términos en catalog.suppliers. Read-first, idempotente por client_uuid (hash de fila), SIN
 * delete (regla anti-churn). Headers del Excel CAMBIAN mes a mes → mapeo por NOMBRE, no posición.
 *
 * Uso (desde database/):
 *   node importers/finance/import-payment-program.js                 # dry-run (parse + reporte)
 *   node importers/finance/import-payment-program.js --apply
 *   FILE="C:/ruta/PROGRAMA PAGOS 2026.xlsx" node importers/finance/import-payment-program.js --apply
 *
 * Env: DATABASE_URL_NEW (destino). finance.payment_program tiene RLS FORZADO → se setea
 * app.tenant_id (aplica aun al owner). analytics/catalog: sin RLS problemático aquí.
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env'), quiet: true });
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const RECON_ONLY = process.argv.includes('--recon-only');   // PP.4: solo re-derivar kepler_matched
const M = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const FILE = process.env.FILE || 'C:/Users/Sistemas/Downloads/PROGRAMA PAGOS 2026 (1).xlsx';

// ── helpers de celda / normalización ──────────────────────────────────────────
const cellVal = (c) => { let v = c ? c.value : null; if (v && typeof v === 'object') { v = v.result ?? v.text ?? v.hyperlink ?? v; } return v; };
const S = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const num = (v) => { if (v == null || v === '') return 0; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const toIso = (v) => {
  if (!v) return null;
  if (v instanceof Date) { const mm = String(v.getUTCMonth() + 1).padStart(2, '0'); const dd = String(v.getUTCDate()).padStart(2, '0'); return `${v.getUTCFullYear()}-${mm}-${dd}`; }
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(S(v)); return m ? m[0] : null;
};
// clave de match de nombre (espejo de suppliers-normalize): sin acentos/puntuación/sufijos legales.
const LEGAL = new Set(['sa', 's', 'a', 'de', 'cv', 'c', 'v', 'rl', 'r', 'l', 'sc', 'sapi', 'p', 'i', 'sab', 'sofom', 'enr', 'dc', 'mx', 'mexico', 'the', 'y', 'compañias', 'compañia', 'compania', 'company', 'grupo', 'comercializadora', 'distribuidora', 'compra', 'comercial']);
const normTokens = (s) => S(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[.,*'`´¨\-\/&()]/g, ' ').replace(/\s+/g, ' ').trim()
  .split(' ').filter((w) => w && !LEGAL.has(w) && w.length > 1);

// banco Excel → canónico de finance.bank_accounts.bank
function bankCanon(t) {
  const u = S(t).toUpperCase();
  if (!u) return null;
  if (/BBVA/.test(u)) return 'BBVA';
  if (/BAJ/.test(u)) return 'BBAJIO';
  if (/BANORTE|BTE/.test(u)) return 'BANORTE';
  if (/SANT/.test(u)) return 'SANTANDER';
  if (/FACTORAJE/.test(u)) return 'FACTORAJE';
  if (/BANAMEX|BNMX/.test(u)) return 'BANAMEX';
  if (/CAJA/.test(u)) return 'CAJA';
  if (/BAJIO|BBAJIO/.test(u)) return 'BBAJIO';
  return u;
}
// método de pago desde MOVIM/TRANFER (+ folios para anticipo, banco para factoraje)
function methodOf(movim, folios, bankC) {
  const mm = S(movim).toLowerCase(); const ff = S(folios).toLowerCase();
  if (bankC === 'FACTORAJE') return { method: 'factoraje', ref: S(movim) };
  if (ff === 'anticipo') return { method: 'anticipo', ref: S(movim) };
  if (/^auto/.test(mm)) return { method: 'auto', ref: S(movim) };
  if (/^ch/.test(mm)) return { method: 'cheque', ref: S(movim) };
  if (/^trans/.test(mm)) return { method: 'transfer', ref: '' };
  if (/^\d{3,}$/.test(mm)) return { method: 'cheque', ref: S(movim) };  // 5019 / 16991 = folio de cheque
  return { method: mm ? 'otro' : null, ref: S(movim) };
}
const tipoOf = (t) => { const u = S(t).toUpperCase(); if (u === 'C') return 'compra'; if (u === 'G') return 'gasto'; if (!u) return null; return 'otro'; };
const monthOf = (sheet) => {
  const n = S(sheet).toUpperCase();
  const MN = { ENERO: '01', FEBRERO: '02', MARZO: '03', ABRIL: '04', MAYO: '05', JUNIO: '06', JULIO: '07', AGOSTO: '08', SEPTIEMBRE: '09', OCTUBRE: '10', NOVIEMBRE: '11', DICIEMBRE: '12' };
  for (const [k, v] of Object.entries(MN)) if (n.includes(k)) { const y = /(\d{4})/.exec(n); return `${y ? y[1] : '2026'}-${v}`; }
  const m = /^(\d{2})(\d{2})$/.exec(n); if (m) return `20${m[2]}-${m[1]}`;   // '0126' → 2026-01
  return null;
};
// mapea headers de una hoja → índices de columna (por nombre, tolerante)
function mapHeaders(ws) {
  const H = {}; ws.getRow(1).eachCell((c, i) => { H[S(cellVal(c)).toUpperCase().replace(/\.$/, '').trim()] = i; });
  const pick = (...names) => { for (const n of names) if (H[n]) return H[n]; return null; };
  return {
    fecha: pick('FECHA'), almc: pick('ALMC', 'ALMACEN'), tipo: pick('TIPO'),
    movim: pick('MOVIM', 'TRANFER', 'TRANSFER'), supplier: pick('PROVEEDOR', 'CONCEPTO'),
    factura: pick('F. FACTURA', 'FACTURA', 'F FACTURA', 'FOLIO'), amount: pick('$TOTAL', '$ TOTAL', '$ VALOR', '$VALOR', 'VALOR', 'TOTAL'),
    banco: pick('BANCO'), clearing: pick('FECHA COBRO', 'FECHA PAGO'), kepler: pick('KEPLER'), recibio: pick('RECIBIO'),
  };
}

// PP.4 — deriva kepler_matched: ¿existe en Kepler un pago 201 (XD2601/XD2501) que empate este pago
// del programa? Match por (mes + monto ±$1 + solapamiento de tokens proveedor↔referencia). Robusto y
// full-cobertura (todos los meses, no solo los que traen la columna KEPLER en el Excel).
async function reconKepler(db) {
  const kp = (await db.query(
    `SELECT anio_mes, referencia, round(importe::numeric) amt FROM analytics.gl_poliza_lines
      WHERE tenant_id=$1 AND source='kepler' AND cuenta_mayor='201' AND tipo_pol IN ('XD2601','XD2501') AND anio_mes >= '2026-01'`, [M])).rows;
  const idx = new Map();
  for (const r of kp) { const k = `${r.anio_mes}|${Number(r.amt)}`; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(new Set(normTokens(r.referencia))); }
  const pp = (await db.query(`SELECT id, source_month, amount, supplier_text FROM finance.payment_program WHERE tenant_id=$1`, [M])).rows;
  const yes = [], no = [];
  for (const p of pp) {
    const amt = Math.round(Number(p.amount) || 0); const ptok = new Set(normTokens(p.supplier_text)); let ok = false;
    for (const d of [0, 1, -1]) {
      const bucket = idx.get(`${p.source_month}|${amt + d}`); if (!bucket) continue;
      for (const rtok of bucket) {
        if (!ptok.size) { ok = true; break; }
        let inter = 0; for (const w of ptok) if (rtok.has(w)) inter++;
        if (inter / Math.max(1, Math.min(ptok.size, rtok.size)) >= 0.4) { ok = true; break; }
      }
      if (ok) break;
    }
    (ok ? yes : no).push(p.id);
  }
  const upd = async (ids, val) => { for (let i = 0; i < ids.length; i += 1000) { const c = ids.slice(i, i + 1000); await db.query(`UPDATE finance.payment_program SET kepler_matched=$2, updated_at=now() WHERE tenant_id=$1 AND id = ANY($3::uuid[])`, [M, val, c]); } };
  await upd(yes, true); await upd(no, false);
  console.log(`  recon Kepler: ${yes.length} con registro · ${no.length} SIN registro en Kepler (de ${pp.length})`);
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW || '') ? false : { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`select set_config('app.tenant_id',$1,false)`, [M]);
  if (RECON_ONLY) { console.log('\n=== PP.4 recon Kepler (solo re-derivar kepler_matched) ==='); await reconKepler(db); await db.end(); return; }
  console.log(`\n=== Import PROGRAMA PAGOS → finance.payment_program (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n  archivo: ${FILE}`);

  // catálogo de proveedores para resolver (index por token)
  const sup = (await db.query(`SELECT id, name, code FROM catalog.suppliers WHERE tenant_id=$1 AND deleted_at IS NULL`, [M])).rows;
  const supIdx = sup.map((s) => ({ id: s.id, name: s.name, toks: new Set(normTokens(s.name)) }));
  const resolveSupplier = (txt) => {
    const t = normTokens(txt); if (!t.length) return null;
    const tset = new Set(t); let best = null, bestScore = 0;
    for (const s of supIdx) {
      if (!s.toks.size) continue;
      let inter = 0; for (const w of tset) if (s.toks.has(w)) inter++;
      const score = inter / Math.max(1, Math.min(tset.size, s.toks.size));
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return bestScore >= 0.5 ? best : null;
  };
  // cuentas bancarias: banco → [id]; resoluble solo si el banco tiene UNA cuenta
  const banks = (await db.query(`SELECT id, bank FROM finance.bank_accounts WHERE tenant_id=$1 AND active`, [M])).rows;
  const bankMap = new Map(); for (const b of banks) { const k = bankCanon(b.bank); if (!bankMap.has(k)) bankMap.set(k, []); bankMap.get(k).push(b.id); }
  const resolveBank = (bankC) => { const a = bankMap.get(bankC); return a && a.length === 1 ? a[0] : null; };

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  // ── PROVEEDORES: términos ──
  const terms = [];
  const pv = wb.getWorksheet('PROVEEDORES');
  if (pv) {
    const H = {}; pv.getRow(1).eachCell((c, i) => { H[S(cellVal(c)).toUpperCase()] = i; });
    const cN = H['NOMBRE'], cFR = H['FISCAL/REMISON'] || H['FISCAL/REMISION'], cCr = H['DIAS DE CREDITO'], cPP = H['DESCUENTO PP'];
    for (let r = 2; r <= pv.rowCount; r++) {
      const name = S(cellVal(pv.getRow(r).getCell(cN))); if (!name) continue;
      const fr = S(cellVal(pv.getRow(r).getCell(cFR))).toUpperCase();
      terms.push({ name, invoice_type: fr.startsWith('FISCAL') ? 'fiscal' : fr.startsWith('REMIS') ? 'remision' : null,
        credit_days: cCr ? (num(cellVal(pv.getRow(r).getCell(cCr))) || null) : null,
        pp: cPP ? (num(cellVal(pv.getRow(r).getCell(cPP))) || null) : null });
    }
  }

  // ── hojas mensuales → pagos ──
  const payments = []; const perMonth = {};
  const seen = new Map(); // client_uuid dedupe con contador de ocurrencia
  for (const ws of wb.worksheets) {
    const month = monthOf(ws.name); if (!month) continue; // PROVEEDORES u otras
    const cols = mapHeaders(ws); if (!cols.amount && !cols.supplier) continue;
    let n = 0, sumAmt = 0, resolved = 0;
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const supplier_text = cols.supplier ? S(cellVal(row.getCell(cols.supplier))) : '';
      const amount = cols.amount ? num(cellVal(row.getCell(cols.amount))) : 0;
      if (!supplier_text && !amount) continue;
      const bank_text = cols.banco ? S(cellVal(row.getCell(cols.banco))) : '';
      const bankC = bankCanon(bank_text);
      const folios = cols.factura ? S(cellVal(row.getCell(cols.factura))) : '';
      const { method, ref } = methodOf(cols.movim ? S(cellVal(row.getCell(cols.movim))) : '', folios, bankC);
      const pay_date = cols.fecha ? toIso(cellVal(row.getCell(cols.fecha))) : null;
      const clearing_date = cols.clearing ? toIso(cellVal(row.getCell(cols.clearing))) : null;
      const kraw = cols.kepler ? S(cellVal(row.getCell(cols.kepler))).toLowerCase() : '';
      const kepler_flag = kraw === 'true' ? true : kraw === 'false' ? false : null;
      const sup1 = resolveSupplier(supplier_text); if (sup1) resolved++;
      // client_uuid: hash de contenido + ocurrencia (posición-independiente, estable en re-run)
      const base = `${month}|${pay_date || ''}|${supplier_text.toLowerCase()}|${amount}|${ref}|${folios.toLowerCase()}`;
      const occ = (seen.get(base) || 0) + 1; seen.set(base, occ);
      const client_uuid = crypto.createHash('sha1').update(`${base}|${occ}`).digest('hex');
      payments.push({
        source_month: month, client_uuid, pay_date, clearing_date,
        supplier_id: sup1 ? sup1.id : null, supplier_text,
        sucursal_code: cols.almc ? S(cellVal(row.getCell(cols.almc))) : null,
        tipo: cols.tipo ? tipoOf(cellVal(row.getCell(cols.tipo))) : null,
        method, method_ref: ref || null, bank_account_id: resolveBank(bankC), bank_text: bankC || bank_text || null,
        amount, invoice_folios: folios || null, kepler_flag,
        concepto: supplier_text, recibio: cols.recibio ? S(cellVal(row.getCell(cols.recibio))) : null,
      });
      n++; sumAmt += amount;
    }
    perMonth[ws.name] = { month, n, sumAmt, resolved };
  }

  console.log('\n=== PAGOS por hoja ===');
  for (const [sheet, x] of Object.entries(perMonth)) console.log(`  ${sheet.padEnd(12)} ${x.month}  pagos=${String(x.n).padStart(4)}  $${Math.round(x.sumAmt).toLocaleString().padStart(13)}  resueltos=${x.resolved}/${x.n} (${Math.round(100 * x.resolved / Math.max(1, x.n))}%)`);
  console.log(`\n  TOTAL: ${payments.length} pagos · ${terms.length} proveedores con términos`);
  console.log('  muestra pagos:');
  console.table(payments.slice(0, 8).map((p) => ({ mes: p.source_month, fecha: p.pay_date, prov: (p.supplier_text || '').slice(0, 22), sup_id: p.supplier_id ? '✓' : '—', tipo: p.tipo, method: p.method, banco: p.bank_text, monto: Math.round(p.amount), kepler: p.kepler_flag })));

  if (!APPLY) { console.log('\n[DRY-RUN] usar --apply para escribir.'); await db.end(); return; }

  // ── APPLY: UPSERT payment_program (sin delete) + UPDATE términos suppliers ──
  await db.query('BEGIN');
  try {
    let up = 0;
    for (let i = 0; i < payments.length; i += 500) {
      const chunk = payments.slice(i, i + 500);
      const cols = ['tenant_id', 'source_month', 'client_uuid', 'pay_date', 'clearing_date', 'supplier_id', 'supplier_text', 'sucursal_code', 'tipo', 'method', 'method_ref', 'bank_account_id', 'bank_text', 'amount', 'invoice_folios', 'kepler_flag', 'concepto', 'recibio', 'updated_at'];
      const vals = []; const params = [];
      chunk.forEach((p, ri) => {
        const base = ri * 18;
        vals.push(`(${Array.from({ length: 18 }, (_, k) => `$${base + k + 1}`).join(',')}, now())`);
        params.push(M, p.source_month, p.client_uuid, p.pay_date, p.clearing_date, p.supplier_id, p.supplier_text, p.sucursal_code, p.tipo, p.method, p.method_ref, p.bank_account_id, p.bank_text, p.amount, p.invoice_folios, p.kepler_flag, p.concepto, p.recibio);
      });
      const res = await db.query(`
        INSERT INTO finance.payment_program (${cols.join(',')}) VALUES ${vals.join(',')}
        ON CONFLICT (tenant_id, client_uuid) DO UPDATE SET
          pay_date=EXCLUDED.pay_date, clearing_date=EXCLUDED.clearing_date, supplier_id=EXCLUDED.supplier_id,
          supplier_text=EXCLUDED.supplier_text, sucursal_code=EXCLUDED.sucursal_code, tipo=EXCLUDED.tipo,
          method=EXCLUDED.method, method_ref=EXCLUDED.method_ref, bank_account_id=EXCLUDED.bank_account_id,
          bank_text=EXCLUDED.bank_text, amount=EXCLUDED.amount, invoice_folios=EXCLUDED.invoice_folios,
          kepler_flag=EXCLUDED.kepler_flag, concepto=EXCLUDED.concepto, recibio=EXCLUDED.recibio, updated_at=now()`, params);
      up += res.rowCount;
    }
    // términos → suppliers (match por nombre; solo donde resuelve). El DESCUENTO PP NO se escribe
    // aquí: vive en commercial.supplier_discount_policy (evita duplicar la política de descuento).
    let tset = 0;
    for (const t of terms) {
      const s = resolveSupplier(t.name); if (!s) continue;
      await db.query(`UPDATE catalog.suppliers SET credit_days=COALESCE($2,credit_days), invoice_type=COALESCE($3,invoice_type), updated_at=now() WHERE tenant_id=$1 AND id=$4`,
        [M, t.credit_days, t.invoice_type, s.id]);
      tset++;
    }
    await db.query('COMMIT');
    console.log(`\n[APPLY] payment_program upsert=${up} · términos aplicados a ${tset} proveedores.`);
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  // NOTA PP.4: NO se auto-deriva kepler_matched — el match per-pago vs Kepler 201 resultó poco
  // confiable (pagos batcheados / monto posteado distinto / cruce de mes → falsos "sin registro",
  // validado contra el flag propio del Excel jul/ago). La señal confiable es la columna KEPLER de
  // Tesorería. `--recon-only` deja la heurística disponible como experimento, no como control.
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
