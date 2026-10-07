/* eslint-disable no-console */
/**
 * Herramienta de VALIDACIÓN del Programa de Pagos (Fase PP). Read-only, reutilizable.
 * Cruza finance.payment_program (Excel Tesorería) contra TODO: Kepler (erp_supplier_payments +
 * gl 201 XD2601/XD2501), bancos (CB), política de descuento y términos de proveedor. Desglosa por
 * mes, banco, método, tipo, proveedor, y aísla el valor único (pagos ejecutados no posteados).
 *
 * Uso (desde database/):
 *   DATABASE_URL_NEW=<prod> node scripts/validate-payment-program.js               # todo
 *   DATABASE_URL_NEW=<prod> node scripts/validate-payment-program.js --month 2026-08
 *   DATABASE_URL_NEW=<prod> node scripts/validate-payment-program.js --supplier mondelez
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { Client } = require('pg');

const M = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const ONLY_MONTH = arg('month');
const ONLY_SUP = arg('supplier');
const N = (v) => Number(v || 0);
const $ = (v) => '$' + Math.round(N(v)).toLocaleString();

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW || '') ? false : { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`select set_config('app.tenant_id',$1,false)`, [M]);
  const q = async (sql, params = []) => { try { return (await db.query(sql, params)).rows; } catch (e) { console.log('  ⚠ ' + e.message); return []; } };
  const mFilt = ONLY_MONTH ? ` AND source_month='${ONLY_MONTH}'` : '';
  const mFiltErp = ONLY_MONTH ? ` AND to_char(pago_date,'YYYY-MM')='${ONLY_MONTH}'` : '';
  console.log(`\n############ VALIDACIÓN PROGRAMA DE PAGOS ############${ONLY_MONTH ? ' · mes ' + ONLY_MONTH : ''}${ONLY_SUP ? ' · prov ~' + ONLY_SUP : ''}\n`);

  // ── A. COBERTURA DE FUENTES ──
  console.log('=== A. COBERTURA DE FUENTES ===');
  const cov = [];
  cov.push(['payment_program (Excel Tesorería)', ...Object.values((await q(`SELECT count(*) n, round(sum(amount),0) monto, min(source_month) desde, max(source_month) hasta FROM finance.payment_program WHERE tenant_id=$1`, [M]))[0] || {})]);
  cov.push(['erp_supplier_payments (Kepler CC)', ...Object.values((await q(`SELECT count(*) n, round(sum(monto::numeric),0) monto, min(to_char(pago_date,'YYYY-MM')) desde, max(to_char(pago_date,'YYYY-MM')) hasta FROM analytics.erp_supplier_payments WHERE tenant_id=$1`, [M]))[0] || {})]);
  cov.push(['gl 201 pagos XD2601/XD2501', ...Object.values((await q(`SELECT count(*) n, round(sum(importe::numeric),0) monto, min(anio_mes) desde, max(anio_mes) hasta FROM analytics.gl_poliza_lines WHERE tenant_id=$1 AND source='kepler' AND cuenta_mayor='201' AND tipo_pol IN ('XD2601','XD2501')`, [M]))[0] || {})]);
  cov.push(['bank_movements egresos (CB)', ...Object.values((await q(`SELECT count(*) n, round(sum(amount_out),0) monto, min(to_char(movement_date,'YYYY-MM')) desde, max(to_char(movement_date,'YYYY-MM')) hasta FROM finance.bank_movements WHERE tenant_id=$1 AND amount_out>0`, [M]))[0] || {})]);
  cov.push(['supplier_discount_policy', ...Object.values((await q(`SELECT count(*) n, null monto, null desde, null hasta FROM commercial.supplier_discount_policy WHERE tenant_id=$1`, [M]))[0] || {})]);
  console.table(cov.map((r) => ({ fuente: r[0], filas: N(r[1]), monto: r[2] != null ? $(r[2]) : '—', desde: r[3] || '—', hasta: r[4] || '—' })));

  // ── B. CONTROL 3-VÍAS POR MES ──
  console.log('\n=== B. CONTROL 3-VÍAS POR MES (programa / erp CC / gl201 / bancos) ===');
  const prog = await q(`SELECT source_month ym, count(*) n, round(sum(amount),0) monto FROM finance.payment_program WHERE tenant_id=$1${mFilt} GROUP BY 1 ORDER BY 1`, [M]);
  const erp = await q(`SELECT to_char(pago_date,'YYYY-MM') ym, count(*) n, round(sum(monto::numeric),0) monto FROM analytics.erp_supplier_payments WHERE tenant_id=$1 AND pago_date>=date '2026-01-01'${mFiltErp} GROUP BY 1 ORDER BY 1`, [M]);
  const gl = await q(`SELECT anio_mes ym, round(sum(importe::numeric),0) monto FROM analytics.gl_poliza_lines WHERE tenant_id=$1 AND source='kepler' AND cuenta_mayor='201' AND tipo_pol IN ('XD2601','XD2501') AND anio_mes>='2026-01' GROUP BY 1`, [M]);
  const bk = await q(`SELECT to_char(movement_date,'YYYY-MM') ym, round(sum(amount_out),0) monto FROM finance.bank_movements WHERE tenant_id=$1 AND amount_out>0 GROUP BY 1`, [M]);
  const glM = new Map(gl.map((r) => [r.ym, N(r.monto)])), bkM = new Map(bk.map((r) => [r.ym, N(r.monto)])), erpM = new Map(erp.map((r) => [r.ym, r]));
  console.table(prog.map((p) => ({ mes: p.ym, prog_n: N(p.n), prog_$: $(p.monto), erp_n: N(erpM.get(p.ym)?.n), erp_$: $(erpM.get(p.ym)?.monto), gl201_$: $(glM.get(p.ym)), bancos_$: bkM.has(p.ym) ? $(bkM.get(p.ym)) : '—', gap_prog_erp: $(N(p.monto) - N(erpM.get(p.ym)?.monto)) })));

  // ── C. POR BANCO × MES (programa) ──
  console.log('\n=== C. PROGRAMA POR BANCO × MES ===');
  const byBank = await q(`SELECT source_month ym, coalesce(bank_text,'—') banco, count(*) n, round(sum(amount),0) monto FROM finance.payment_program WHERE tenant_id=$1${mFilt} GROUP BY 1,2 ORDER BY 1, monto DESC`, [M]);
  console.table(byBank.map((r) => ({ mes: r.ym, banco: r.banco, pagos: N(r.n), monto: $(r.monto) })));

  // ── D. POR MÉTODO ──
  console.log('\n=== D. PROGRAMA POR MÉTODO ===');
  console.table((await q(`SELECT coalesce(method,'—') metodo, count(*) n, round(sum(amount),0) monto FROM finance.payment_program WHERE tenant_id=$1${mFilt} GROUP BY 1 ORDER BY monto DESC`, [M])).map((r) => ({ metodo: r.metodo, pagos: N(r.n), monto: $(r.monto) })));

  // ── E. POR TIPO ──
  console.log('\n=== E. PROGRAMA POR TIPO (compra/gasto) ===');
  console.table((await q(`SELECT coalesce(tipo,'—') tipo, count(*) n, round(sum(amount),0) monto FROM finance.payment_program WHERE tenant_id=$1${mFilt} GROUP BY 1 ORDER BY monto DESC`, [M])).map((r) => ({ tipo: r.tipo, pagos: N(r.n), monto: $(r.monto) })));

  // ── F. VALIDACIÓN DEL FLAG KEPLER (jul/ago) ──
  console.log('\n=== F. FLAG KEPLER declarado por Tesorería (jul/ago) ===');
  console.table((await q(`SELECT source_month ym, kepler_flag, count(*) n, round(sum(amount),0) monto FROM finance.payment_program WHERE tenant_id=$1 AND source_month IN ('2026-07','2026-08')${ONLY_MONTH ? ` AND source_month='${ONLY_MONTH}'` : ''} GROUP BY 1,2 ORDER BY 1,2`, [M])).map((r) => ({ mes: r.ym, en_kepler: r.kepler_flag === null ? 's/dato' : r.kepler_flag, pagos: N(r.n), monto: $(r.monto) })));

  // ── G. TOP PROVEEDORES (programa resuelto) vs erp ──
  console.log('\n=== G. TOP 20 PROVEEDORES (programa, resueltos) ===');
  console.table((await q(`SELECT coalesce(s.name, pp.supplier_text) prov, count(*) n, round(sum(pp.amount),0) monto, bool_or(pp.supplier_id IS NOT NULL) resuelto FROM finance.payment_program pp LEFT JOIN catalog.suppliers s ON s.id=pp.supplier_id WHERE pp.tenant_id=$1${mFilt}${ONLY_SUP ? ` AND (pp.supplier_text ILIKE '%${ONLY_SUP}%' OR s.name ILIKE '%${ONLY_SUP}%')` : ''} GROUP BY 1 ORDER BY monto DESC LIMIT 20`, [M])).map((r) => ({ proveedor: (r.prov || '').slice(0, 36), pagos: N(r.n), monto: $(r.monto), resuelto: r.resuelto ? '✓' : '·?' })));

  // ── H. SIN RESOLVER ──
  console.log('\n=== H. PROVEEDORES SIN RESOLVER (texto crudo, top 15 por $) ===');
  console.table((await q(`SELECT supplier_text, count(*) n, round(sum(amount),0) monto FROM finance.payment_program WHERE tenant_id=$1 AND supplier_id IS NULL${mFilt} GROUP BY 1 ORDER BY monto DESC LIMIT 15`, [M])).map((r) => ({ texto: (r.supplier_text || '').slice(0, 40), pagos: N(r.n), monto: $(r.monto) })));

  // ── I. VALOR ÚNICO: agosto no posteado (programa sin contraparte en erp) ──
  console.log('\n=== I. VALOR ÚNICO — ejecutado vs posteado (agosto) ===');
  const agoP = (await q(`SELECT count(*) n, round(sum(amount),0) m FROM finance.payment_program WHERE tenant_id=$1 AND source_month='2026-08'`, [M]))[0] || {};
  const agoE = (await q(`SELECT count(*) n, round(sum(monto::numeric),0) m FROM analytics.erp_supplier_payments WHERE tenant_id=$1 AND to_char(pago_date,'YYYY-MM')='2026-08'`, [M]))[0] || {};
  const agoFlag = (await q(`SELECT count(*) FILTER (WHERE kepler_flag IS FALSE) no, round(sum(amount) FILTER (WHERE kepler_flag IS FALSE),0) mno FROM finance.payment_program WHERE tenant_id=$1 AND source_month='2026-08'`, [M]))[0] || {};
  console.log(`  Programa agosto: ${N(agoP.n)} pagos · ${$(agoP.m)}`);
  console.log(`  Posteado en Kepler (erp): ${N(agoE.n)} pagos · ${$(agoE.m)}`);
  console.log(`  → NO posteado (por flag Tesorería): ${N(agoFlag.no)} pagos · ${$(agoFlag.mno)}  ← el valor que Kepler NO tiene`);

  // ── J. TÉRMINOS + DESCUENTO ──
  console.log('\n=== J. TÉRMINOS DE PROVEEDOR ===');
  const term = (await q(`SELECT count(*) FILTER (WHERE credit_days IS NOT NULL) cred, count(*) FILTER (WHERE invoice_type IS NOT NULL) inv, count(*) total FROM catalog.suppliers WHERE tenant_id=$1 AND deleted_at IS NULL`, [M]))[0] || {};
  const disc = (await q(`SELECT count(*) n, round(avg(expected_discount_rate)::numeric,3) avg_rate FROM commercial.supplier_discount_policy WHERE tenant_id=$1 AND active`, [M]))[0] || {};
  console.log(`  suppliers con credit_days: ${N(term.cred)}/${N(term.total)} · con invoice_type: ${N(term.inv)}`);
  console.log(`  supplier_discount_policy: ${N(disc.n)} activos · tasa promedio ${disc.avg_rate || 0}`);

  console.log('\n############ FIN ############\n');
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
