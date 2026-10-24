"use strict";
/**
 * [PQ.12] PARIDAD de existencia contra el REPORTE de Kepler — «misma fórmula, mismos resultados».
 *
 * Regla del PM (2026-10-24): nada inventado ni importado; la Suite sigue la fórmula de Kepler y
 * entrega los mismos números. Este script lo mide: toma el «Reporte de existencia por productos»
 * de Kepler (exportado a texto con `pdftotext -raw <pdf> <txt>`) y lo cruza SKU por SKU contra
 * `analytics.v_erp_stock_on_hand` y contra el kardex crudo `kepler_ods.kdil` (c4+c8−c9).
 *
 * ⛔ Arranca con un CONTROL: cifras leídas A OJO en el PDF (pasalas con --control 'SKU=valor,…').
 * Si el parser no acierta el control, se tira el instrumento, no la medición. Medido el
 * 2026-10-24: `pdftotext -layout` corría los renglones un SKU (17022 salía con 375 que era de
 * 17021); `-raw` acierta 11 de 11.
 *
 * Uso: pdftotext -raw KRep_md_invrepexsrep.kpl.pdf cedis.txt
 *      $env:PROD_DATABASE_URL='…'; node database/scripts/pq-paridad-existencia-reporte-kepler.js cedis.txt --sucursal 00 --control '17022=175,06001=-1152'
 */
const { Client } = require('pg');
const fs = require('fs');
const URL = process.env.PROD_DATABASE_URL || process.env.PROD_DB_URL;
if (!URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SUC = arg('--sucursal', '00');
const CTRL = Object.fromEntries((arg('--control', '') || '').split(',').filter(Boolean).map((p) => { const [k, v] = p.split('='); return [k.trim(), Number(v)]; }));
const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
const re = /^(\d{5}) (.*?)(PZA|PAQ|KG|CJA|SER|LT|GR|BTO|MIL|PAR|ROL|BOL|CAJ|PQT|DOC)\*\s+(-?\d{1,3}(?:,\d{3})*\.\d{2})/;
const rep = new Map(); let sinCifra = 0;
for (const l of lines) { const m = l.match(re); if (!m) { if (/^\d{5} /.test(l)) sinCifra++; continue; } if (!rep.has(m[1])) rep.set(m[1], { desc: m[2].trim(), uni: m[3], v: Number(m[4].replace(/,/g, '')) }); }
if (Object.keys(CTRL).length) {
  const malos = Object.entries(CTRL).filter(([k, v]) => rep.get(k)?.v !== v);
  if (malos.length) { console.log('⛔ CONTROL FALLA → instrumento inválido'); console.table(malos.map(([k, v]) => ({ sku: k, ojo: v, parser: rep.get(k)?.v }))); process.exit(2); }
  console.log(`CONTROL: ${Object.keys(CTRL).length} cifras leídas a ojo → el parser las acierta`);
} else console.log('⚠️ sin --control: el parser no está validado contra el PDF (pasá cifras leídas a ojo)');
for (const k of ['00001', '00002', '00022']) rep.delete(k);   // conceptos de venta, no productos
(async () => {
  const c = new Client({ connectionString: URL, ssl: { rejectUnauthorized: false }, statement_timeout: 120000 });
  await c.connect(); await c.query('SET default_transaction_read_only = on');
  const id = (await c.query('SELECT system_identifier::text sid, now()::text t FROM pg_control_system()')).rows[0];
  console.log(`base system_identifier ${id.sid} · ${id.t} · sucursal ${SUC}`);
  const ods = new Map((await c.query('select sku, qty_stock_units::numeric q from analytics.v_erp_stock_on_hand where warehouse_code=$1', [SUC])).rows.map((r) => [String(r.sku).padStart(5, '0'), Number(r.q)]));
  const crudo = new Map((await c.query('select btrim(k.c3) sku, sum(k.c4 + k.c8 - k.c9) q, max(greatest(k.c6,k.c7))::date ult from kepler_ods.kdil k where k.sucursal=$1 and k.c1=$1 group by 1', [SUC])).rows.map((r) => [String(r.sku).padStart(5, '0'), { q: Number(r.q), ult: r.ult }]));
  const pos = [...rep.values()].filter((r) => r.v > 0), neg = [...rep.values()].filter((r) => r.v < 0);
  console.log(`Reporte Kepler: ${rep.size} productos (${sinCifra} renglones sin cifra) · positivos ${pos.length} (${Math.round(pos.reduce((a, r) => a + r.v, 0)).toLocaleString('en-US')} u1) · negativos ${neg.length} (${Math.round(neg.reduce((a, r) => a + r.v, 0)).toLocaleString('en-US')} u1)`);
  let igual = 0, dif = [], soloKep = [], soloOds = [], negRecortado = 0, negCrudoIgual = 0, crudoIgual = 0;
  for (const [k, r] of rep) {
    const o = ods.get(k), cr = crudo.get(k)?.q;
    if (cr != null && Math.abs(cr - r.v) < 0.5) crudoIgual++;
    if (r.v > 0) { if (!(o > 0)) soloKep.push({ sku: k, kepler: r.v, kdil_crudo: cr ?? null, ult_mov: crudo.get(k)?.ult ?? null }); else if (Math.abs(o - r.v) < 0.5) igual++; else dif.push({ sku: k, kepler: r.v, ods: o, kdil_crudo: cr ?? null, desc: r.desc.slice(0, 32) }); }
    else if (r.v < 0) { if ((o ?? 0) === 0) negRecortado++; if (cr != null && Math.abs(cr - r.v) < 0.5) negCrudoIgual++; }
  }
  for (const [k, o] of ods) if (o > 0 && !(rep.get(k)?.v > 0)) soloOds.push({ sku: k, ods: o, ult_mov: crudo.get(k)?.ult ?? null });
  console.log(`\nPARIDAD con la vista (v_erp_stock_on_hand): positivos iguales ${igual} de ${pos.length} · distintos ${dif.length} · sólo Kepler ${soloKep.length} · sólo ODS ${soloOds.length}`);
  console.log(`MISMA FÓRMULA (kdil c4+c8−c9, sin recorte ni filtro): reproduce ${crudoIgual} de ${rep.size} renglones del reporte, incluidos ${negCrudoIgual} de ${neg.length} negativos`);
  console.log(`Negativos de Kepler que la vista muestra como 0: ${negRecortado} de ${neg.length}`);
  if (dif.length) { console.log('\ndistintos (mirá ult_mov: lo movido después de la hora del reporte explica la diferencia):'); console.table(dif.slice(0, 20)); }
  if (soloKep.length) { console.log('\nsólo Kepler:'); console.table(soloKep.slice(0, 20)); }
  if (soloOds.length) { console.log('\nsólo ODS:'); console.table(soloOds.slice(0, 20)); }
  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
