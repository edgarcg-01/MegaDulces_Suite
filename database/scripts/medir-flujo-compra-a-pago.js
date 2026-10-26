'use strict';
/**
 * `[FLUJO.2]` **Medición de seguimiento del flujo «de la compra al pago»** — sólo lectura contra prod.
 *
 * Es el instrumento que produjo las cifras de `docs/FLUJO_COMPRA_A_PAGO.md` (2026-10-26). Vive en el
 * repo para RE-CORRERLO cada mes y ver si las costuras mejoran o empeoran: volumen por documento,
 * cobertura de cada liga de Kepler (con placebo), tiempos entre documentos, condición y vencimiento
 * de la deuda, pago de la deuda (kdxf), medio de pago (c45) y lo que la Suite tiene de cada paso.
 *
 *   node database/scripts/medir-flujo-compra-a-pago.js [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD]
 *                                                      [--maduro AAAA-MM-DD] [--json <ruta>]
 *
 *   --desde   inicio de la ventana (c9).              Default: 1-ene del año en curso.
 *   --hasta   fin de la ventana (c9, inclusive).       Default: ayer.
 *   --maduro  último día con pago "maduro" (§5).       Default: --hasta menos 55 días.
 *   --json    deja todas las tablas en un JSON para comparar contra la corrida anterior.
 *
 * ⛔ Reglas que este script cumple, y que no se aflojan:
 *   - Destino: `PROD_DB_URL` (o `DATABASE_URL_NEW`) del `.env`, y **aborta** si el system_identifier
 *     no es el de prod (`7688376744939610156`). Medir contra la base equivocada no falla: da cifras
 *     equivocadas con toda confianza (Railway congelada, `.245`).
 *   - Toda consulta en `BEGIN; SET TRANSACTION READ ONLY; statement_timeout 60s; ROLLBACK`.
 *   - Los cruces son ESTRUCTURALES (llaves de Kepler), no por importe. El placebo de la liga c39 repite
 *     el apareo con el folio del padre +1 y mide cuántas veces "casa" el proveedor por azar.
 *   - Cada partición imprime su control (Σ partes = universo).
 * Decode y trampas: `docs/FLUJO_COMPRA_A_PAGO.md` y `docs/ERP_KEPLER.md` §3 (kdm1/kdxe/kdxf/kdb1).
 * ⚠️ Lee kdxe/kdxf enteras (decenas de miles de filas): unos segundos. Fuera de horario si se amplía.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

// ── corredor de sólo lectura (aborta si el destino no es prod) ──────────────────────────────────
const SID_PROD = '7688376744939610156';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
function urlProd() {
  try { require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* sin dotenv: sólo env */ }
  return process.env.PROD_DB_URL || process.env.DATABASE_URL_NEW;
}
function show(rows, title) {
  if (title) console.log(`\n── ${title}`);
  if (!rows || !rows.length) { console.log('  (0 filas)'); return; }
  const keys = Object.keys(rows[0]);
  console.log('  ' + keys.join(' | '));
  for (const r of rows) console.log('  ' + keys.map((k) => { const v = r[k]; return v === null ? '∅' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v); }).join(' | '));
}
async function run(fn) {
  const url = urlProd();
  if (!url) { console.error('falta PROD_DB_URL (o DATABASE_URL_NEW) en el entorno o en .env'); process.exit(2); }
  const c = new Client({ connectionString: url, application_name: 'medir-flujo-compra-a-pago-ro' });
  await c.connect();
  const id = (await c.query(`SELECT system_identifier::text sid, current_database() db, now()::text ahora FROM pg_control_system()`)).rows[0];
  if (id.sid !== SID_PROD) { console.error(`ABORTO: system_identifier ${id.sid} no es prod (${SID_PROD})`); await c.end(); process.exit(3); }
  console.log(`destino ${id.db} · system_identifier ${id.sid} · medido ${id.ahora}`);
  const q = async (sql, params) => {
    const t0 = Date.now();
    try {
      await c.query('BEGIN'); await c.query('SET TRANSACTION READ ONLY');
      await c.query(`SET LOCAL statement_timeout='60s'`);
      await c.query(`SELECT set_config('app.tenant_id', '${MEGA}', true)`);
      const r = await c.query(sql, params);
      return Object.assign(r.rows, { ms: Date.now() - t0 });
    } finally { await c.query('ROLLBACK').catch(() => undefined); }
  };
  try { await fn(q); } catch (e) { console.error('ERROR', e.message); process.exitCode = 1; }
  finally { await c.end(); }
}

// ── ventana ─────────────────────────────────────────────────────────────────────────────────────
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const iso = (d) => d.toISOString().slice(0, 10);
const masDias = (s, n) => iso(new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000));
const HOY = iso(new Date());
const W1 = arg('--hasta') || masDias(HOY, -1);                    // ventana principal (c9, inclusive)
const W0 = arg('--desde') || `${W1.slice(0, 4)}-01-01`;
const P1 = arg('--maduro') || masDias(W1, -55);                   // ventana madura para el pago
const EXT_A = masDias(W0, -365);                                  // extracción X-A: un año antes (padres)
const EXT_D = masDias(W0, -184);                                  // extracción X-D: medio año antes (pagos)
const JSON_OUT = arg('--json');
for (const [n, v] of [['--desde', W0], ['--hasta', W1], ['--maduro', P1]]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`${n} inválido: ${v}`); process.exit(2); }
}
console.log(`ventana ${W0}..${W1} · pago maduro hasta ${P1}`);

const OUT = {};
const day = (s) => Math.round(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / 86400000);
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + ' %' : '—');
const M = (n) => (n / 1e6).toFixed(2);
const quant = (arr, p) => {
  if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i);
  return r2(a[lo] + (a[hi] - a[lo]) * (i - lo));
};
const clase = (prov) => /^TI/i.test(prov) ? 'TI' : /^C/i.test(prov) ? 'C' : /^G/i.test(prov) ? 'G' : 'otro';
const zona = (suc) => (suc === '00' ? '00' : 'resto');
const inW = (f, a = W0, b = W1) => f >= a && f <= b;
const keyDoc = (suc, c1, nat, t, s, folio) => `${suc}|${c1}|${nat}|${t}|${s}|${folio}`;

run(async (q) => {
  // ── Extracción (todo acotado por fecha o tablas chicas) ─────────────────────────────────────
  const xa = await q(`SELECT sucursal suc, btrim(c1) c1, c3 nat, c4::int t, c5::int s, btrim(c6) folio, c9::date::text f,
        btrim(coalesce(c10,'')) prov, coalesce(c16,0)::float8 monto, c18::date::text vence, btrim(coalesce(c30,'')) cond,
        btrim(coalesce(c36,'')) p_nat, coalesce(c37,0)::int p_t, coalesce(c38,0)::int p_s, btrim(coalesce(c39,'')) p_folio,
        btrim(coalesce(c43,'')) est
      FROM kepler_ods.kdm1 WHERE c2='X' AND c3='A' AND c4 IN (20,30,35,37,40) AND c9::date >= '${EXT_A}'`);
  console.log(`X-A extraídos: ${xa.length} (${xa.ms} ms)`);
  const xd = await q(`SELECT sucursal suc, btrim(c1) c1, c3 nat, c4::int t, c5::int s, btrim(c6) folio, c9::date::text f,
        btrim(coalesce(c10,'')) prov, coalesce(c16,0)::float8 monto, btrim(coalesce(c43,'')) est, btrim(coalesce(c45,'')) c45,
        c84 descuento, btrim(coalesce(c24,'')) concepto
      FROM kepler_ods.kdm1 WHERE c2='X' AND c3='D' AND c4 IN (20,25,26,40,55,60) AND c9 >= '${EXT_D}'`);
  console.log(`X-D extraídos: ${xd.length} (${xd.ms} ms)`);
  const kdb1 = await q(`SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre,
        CASE WHEN btrim(coalesce(c5,'')) NOT LIKE '102%' THEN 'puente'
             WHEN upper(btrim(coalesce(c3,''))) = 'EFECTIVO' THEN 'caja' ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,'')) <> '' ORDER BY btrim(c1), sucursal`);
  const kdxe = await q(`SELECT sucursal suc, btrim(c1) c1, btrim(c2) acr, c3 nat, c4::int t, c5::int s, btrim(c6) folio,
        c7::date::text f, c10::date::text vence, coalesce(c11,0)::float8 imp FROM kepler_ods.kdxe`);
  const kdxf = await q(`SELECT sucursal suc, btrim(c1) c1, btrim(c2) acr, c3::date::text f, c4::int ct, c5::int cs, btrim(c6) cf,
        c7::int at, c8::int as_, btrim(c9) af, coalesce(c10,0)::float8 apl FROM kepler_ods.kdxf`);
  const dedup = await q(`SELECT cedis_folio, dup_of_sucursal, dup_of_folio, status FROM analytics.erp_goods_receipt_dedup WHERE tenant_id=$1`, [MEGA]);
  console.log(`kdb1 ${kdb1.length} · kdxe ${kdxe.length} · kdxf ${kdxf.length} · dedup ${dedup.length}`);

  // Anti-réplica: valores de c1 que NO son la sucursal (para declararlos)
  const noPropios = {};
  for (const d of [...xa, ...xd]) if (d.c1 !== d.suc && inW(d.f)) { const k = `${d.nat}-${d.t} c1=${d.c1} en ${d.suc}`; noPropios[k] = (noPropios[k] || 0) + 1; }

  const idx = new Map(); for (const d of xa) idx.set(keyDoc(d.suc, d.c1, d.nat, d.t, d.s, d.folio), d);
  const idxD = new Map(); for (const d of xd) idxD.set(keyDoc(d.suc, d.c1, 'D', d.t, d.s, d.folio), d);

  // ── 1. Volumen por doctype ─────────────────────────────────────────────────────────────────
  const m1 = {};
  const sucs = new Set();
  for (const d of [...xa.map((x) => ({ ...x, nat: 'A' })), ...xd.map((x) => ({ ...x, nat: 'D' }))]) {
    if (!inW(d.f)) continue;
    const dt = `X-${d.nat}-${d.t}`;
    if (!['X-A-30', 'X-A-35', 'X-A-37', 'X-A-40', 'X-A-20', 'X-D-40', 'X-D-55', 'X-D-26', 'X-D-25', 'X-D-60', 'X-D-20'].includes(dt)) continue;
    const o = m1[dt] ??= { crudo: 0, replica: 0, cancel: 0, cancel_monto: 0, n: 0, monto: 0, porSuc: {}, porClase: {} };
    o.crudo += 1;
    if (d.c1 !== d.suc) { o.replica += 1; continue; }
    if (d.est === 'C') { o.cancel += 1; o.cancel_monto += d.monto; continue; }
    o.n += 1; o.monto += d.monto; sucs.add(d.suc);
    const ps = o.porSuc[d.suc] ??= { n: 0, monto: 0 }; ps.n += 1; ps.monto += d.monto;
    const pc = o.porClase[clase(d.prov)] ??= { n: 0, monto: 0 }; pc.n += 1; pc.monto += d.monto;
  }
  // X-A-20: la copia de oficinas (00) marcada como gemela de una recepción de sucursal
  const gem = new Map(dedup.filter((x) => ['auto', 'confirmado'].includes(x.status)).map((x) => [x.cedis_folio, x]));
  let gemN = 0, gemM = 0;
  for (const d of xa) if (d.t === 20 && d.suc === '00' && d.c1 === '00' && d.est !== 'C' && inW(d.f) && gem.has(d.folio)) { gemN += 1; gemM += d.monto; }
  const SUC = [...sucs].sort();
  const t1 = []; const t1s = [];
  for (const [dt, o] of Object.entries(m1).sort()) {
    const cs = Object.values(o.porClase).reduce((a, x) => a + x.n, 0);
    const ss = Object.values(o.porSuc).reduce((a, x) => a + x.n, 0);
    t1.push({ doctype: dt, crudo: o.crudo, replica_excl: o.replica, cancel_excl: o.cancel, docs: o.n, monto_M: M(o.monto),
      C_n: o.porClase.C?.n ?? 0, C_M: M(o.porClase.C?.monto ?? 0), TI_n: o.porClase.TI?.n ?? 0, TI_M: M(o.porClase.TI?.monto ?? 0),
      G_n: o.porClase.G?.n ?? 0, otro_n: o.porClase.otro?.n ?? 0,
      control: (cs === o.n && ss === o.n && o.n + o.cancel + o.replica === o.crudo) ? 'OK' : `FALLA ${cs}/${ss}/${o.n}` });
    const row = { doctype: dt }; for (const s of SUC) row[s] = o.porSuc[s] ? `${o.porSuc[s].n}/${M(o.porSuc[s].monto)}` : '0'; t1s.push(row);
  }
  show(t1, `1. Volumen por doctype, c9 ${W0}..${W1} (docs y $M c16; anti-réplica btrim(c1)=sucursal; sin cancelados)`);
  show(t1s, '1b. por sucursal: docs/$M');
  console.log(`  X-A-20 de 00 marcadas como gemelas (erp_goods_receipt_dedup auto/confirmado): ${gemN} docs, $${M(gemM)}M`);
  show(Object.entries(noPropios).map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v).slice(0, 15), '1c. documentos fuera por anti-réplica (c1 ≠ sucursal)');
  OUT.m1 = { t1, t1s, gemN, gemM, noPropios };

  // ── 2. Cobertura de ligas + placebo (folio+1) ─────────────────────────────────────────────
  const PADRE = { 20: 40, 40: 37, 37: 35, 35: 30 };
  // padres que no están en la extracción (anteriores a 2025): búsqueda puntual por llave
  const faltan = [];
  for (const d of xa) {
    if (!PADRE[d.t] || !inW(d.f) || d.c1 !== d.suc || d.est === 'C') continue;
    if (d.p_t === PADRE[d.t] && d.p_folio && !idx.has(keyDoc(d.suc, d.c1, d.p_nat || 'A', d.p_t, d.p_s, d.p_folio))) faltan.push(d);
  }
  if (faltan.length) {
    const extra = await q(`SELECT sucursal suc, btrim(c1) c1, c3 nat, c4::int t, c5::int s, btrim(c6) folio, c9::date::text f,
          btrim(coalesce(c10,'')) prov, coalesce(c16,0)::float8 monto, btrim(coalesce(c43,'')) est,
          btrim(coalesce(c36,'')) p_nat, coalesce(c37,0)::int p_t, coalesce(c38,0)::int p_s, btrim(coalesce(c39,'')) p_folio
        FROM kepler_ods.kdm1 k JOIN unnest($1::text[], $2::text[], $3::text[]) u(su, ti, fo)
          ON k.sucursal=u.su AND k.c2='X' AND k.c3='A' AND btrim(k.c4::text)=u.ti AND btrim(k.c6)=u.fo`,
    [faltan.map((d) => d.suc), faltan.map((d) => String(d.p_t)), faltan.map((d) => d.p_folio)]);
    for (const d of extra) idx.set(keyDoc(d.suc, d.c1, d.nat, d.t, d.s, d.folio), d);
    console.log(`  padres buscados fuera de la extracción: ${faltan.length}, encontrados ${extra.length}`);
  }
  const placeboFolio = (f) => { const n = String(Number(f) + 1); return n.padStart(f.length, '0'); };
  const t2 = []; const pares = { 20: [], 40: [], 37: [], 35: [] };
  for (const t of [20, 40, 37, 35]) for (const z of ['00', 'resto', 'total']) {
    const o = { hijo: `X-A-${t}`, padre: `X-A-${PADRE[t]}`, zona: z, docs: 0, declara: 0, declara_otro: 0, sin_liga: 0, padre_existe: 0, mismo_prov: 0, padre_cancel: 0, placebo_existe: 0, placebo_mismo_prov: 0, monto: 0, monto_ligado: 0 };
    for (const d of xa) {
      if (d.t !== t || !inW(d.f) || d.c1 !== d.suc || d.est === 'C') continue;
      if (z !== 'total' && zona(d.suc) !== z) continue;
      o.docs += 1; o.monto += d.monto;
      if (!d.p_folio || d.p_t === 0) { o.sin_liga += 1; continue; }
      if (d.p_t !== PADRE[t]) { o.declara_otro += 1; continue; }
      o.declara += 1;
      const p = idx.get(keyDoc(d.suc, d.c1, d.p_nat || 'A', d.p_t, d.p_s, d.p_folio));
      if (p) {
        o.padre_existe += 1; o.monto_ligado += d.monto;
        if (p.prov === d.prov) o.mismo_prov += 1;
        if (p.est === 'C') o.padre_cancel += 1;
        if (z === 'total') pares[t].push({ h: d, p });
      }
      const pl = idx.get(keyDoc(d.suc, d.c1, d.p_nat || 'A', d.p_t, d.p_s, placeboFolio(d.p_folio)));
      if (pl) { o.placebo_existe += 1; if (pl.prov === d.prov) o.placebo_mismo_prov += 1; }
    }
    o.control = (o.declara + o.declara_otro + o.sin_liga === o.docs) ? 'OK' : 'FALLA';
    t2.push({ hijo: o.hijo, padre: o.padre, zona: z, docs: o.docs, declara_liga: pct(o.declara, o.docs), padre_existe: `${o.padre_existe} (${pct(o.padre_existe, o.docs)})`,
      pct_monto_ligado: pct(o.monto_ligado, o.monto), sin_liga: o.sin_liga, declara_otro: o.declara_otro,
      mismo_prov: pct(o.mismo_prov, o.padre_existe), padre_cancel: o.padre_cancel,
      placebo_f1_mismo_prov: pct(o.placebo_mismo_prov, o.placebo_existe), control: o.control });
  }
  show(t2, '2. Cobertura de la liga c36/c37/c38/c39 del hijo (propios, no cancelados, ventana)');
  // Cadena completa: X-A-20 → 40 → 37 → 35 → 30
  const cad = { '00': { n: 0, a40: 0, a37: 0, a35: 0, a30: 0 }, resto: { n: 0, a40: 0, a37: 0, a35: 0, a30: 0 } };
  const e2e = { '00': [], resto: [] }; const e2eOC = { '00': [], resto: [] };
  const padreDe = (d) => (d && d.p_folio && d.p_t === PADRE[d.t]) ? idx.get(keyDoc(d.suc, d.c1, d.p_nat || 'A', d.p_t, d.p_s, d.p_folio)) : undefined;
  for (const d of xa) {
    if (d.t !== 20 || !inW(d.f) || d.c1 !== d.suc || d.est === 'C' || clase(d.prov) !== 'C') continue;
    const z = zona(d.suc); cad[z].n += 1;
    const oe = padreDe(d); if (!oe) continue; cad[z].a40 += 1;
    const va = padreDe(oe); if (!va) continue; cad[z].a37 += 1;
    const oc = padreDe(va); if (!oc) continue; cad[z].a35 += 1; e2eOC[z].push(day(d.f) - day(oc.f));
    const rq = padreDe(oc); if (!rq) continue; cad[z].a30 += 1; e2e[z].push(day(d.f) - day(rq.f));
  }
  show(Object.entries(cad).map(([z, o]) => ({ zona: z, XA20_compra: o.n, llega_a_40: pct(o.a40, o.n), a_37: pct(o.a37, o.n), a_35_OC: pct(o.a35, o.n), a_30_req: pct(o.a30, o.n),
    OC_a_aplica_med: quant(e2eOC[z], 0.5), OC_a_aplica_p90: quant(e2eOC[z], 0.9), req_a_aplica_med: quant(e2e[z], 0.5), req_a_aplica_p90: quant(e2e[z], 0.9) })),
  '2b. Cadena completa desde la X-A-20 de compra (C%) hacia atrás');
  OUT.m2 = { t2, cad };

  // ── 3. Tiempos sobre pares ligados ────────────────────────────────────────────────────────
  const t3 = [];
  const NOM = { 35: 'requisición→OC', 37: 'OC→vale', 40: 'vale→orden de entrada', 20: 'orden de entrada→aplica' };
  for (const t of [35, 37, 40, 20]) for (const z of ['00', 'resto']) {
    const ds = pares[t].filter((x) => zona(x.h.suc) === z).map((x) => day(x.h.f) - day(x.p.f));
    t3.push({ tramo: NOM[t], zona: z, pares: ds.length, mediana: quant(ds, 0.5), p90: quant(ds, 0.9), mismo_dia: pct(ds.filter((x) => x === 0).length, ds.length), negativos: ds.filter((x) => x < 0).length, max: ds.length ? Math.max(...ds) : null });
  }
  show(t3, '3. Días entre padre e hijo (c9), sólo pares ligados');
  OUT.m3 = t3;

  // ── 4. Obligación: c30 y c18 en X-A-20 de compra ──────────────────────────────────────────
  const a20 = xa.filter((d) => d.t === 20 && inW(d.f) && d.c1 === d.suc && d.est !== 'C' && clase(d.prov) === 'C');
  const cond = {}; let ok = 0, ok1 = 0, conDias = 0, sinParse = 0; const difs = {};
  for (const d of a20) {
    const c = cond[d.cond || '∅'] ??= { n: 0, monto: 0 }; c.n += 1; c.monto += d.monto;
    let n = null;
    if (/contado/i.test(d.cond)) n = 0; else { const m = d.cond.match(/^(\d+)\s*d/i); if (m) n = Number(m[1]); }
    if (n === null || !d.vence) { sinParse += 1; continue; }
    conDias += 1;
    const diff = day(d.vence) - (day(d.f) + n);
    if (diff === 0) ok += 1; if (Math.abs(diff) <= 1) ok1 += 1;
    const b = diff === 0 ? '0' : diff > 0 ? (diff <= 7 ? '+1..7' : '+8 o más') : (diff >= -7 ? '-7..-1' : '-8 o menos'); difs[b] = (difs[b] || 0) + 1;
  }
  const condRows = Object.entries(cond).sort((a, b) => b[1].n - a[1].n);
  const totN = condRows.reduce((a, [, v]) => a + v.n, 0), totM = condRows.reduce((a, [, v]) => a + v.monto, 0);
  const top = condRows.slice(0, 12).map(([k, v]) => ({ c30: k, docs: v.n, pct_docs: pct(v.n, totN), monto_M: M(v.monto), pct_monto: pct(v.monto, totM) }));
  const resto = condRows.slice(12); top.push({ c30: `(otras ${resto.length})`, docs: resto.reduce((a, [, v]) => a + v.n, 0), pct_docs: '', monto_M: M(resto.reduce((a, [, v]) => a + v.monto, 0)), pct_monto: '' });
  show(top, `4. c30 en X-A-20 de compra (C%), ${a20.length} docs $${M(totM)}M — control Σ=${totN === a20.length ? 'OK' : 'FALLA'}`);
  const contado = condRows.filter(([k]) => /contado/i.test(k)).reduce((a, [, v]) => ({ n: a.n + v.n, m: a.m + v.monto }), { n: 0, m: 0 });
  console.log(`  contado: ${contado.n} docs (${pct(contado.n, totN)}), $${M(contado.m)}M (${pct(contado.m, totM)})`);
  console.log(`  c18 = c9 + días(c30): exacto ${ok}/${conDias} (${pct(ok, conDias)}), ±1 día ${pct(ok1, conDias)}; sin días legibles o sin c18: ${sinParse}`);
  console.log('  distribución de (c18 − (c9+días)):', JSON.stringify(difs));
  // ¿kdxe.c10 (vence de CxP) = kdm1.c18?
  const xeA = new Map(); for (const e of kdxe) if (e.nat === 'A') xeA.set(`${e.suc}|${e.c1}|${e.acr}|${e.t}|${e.s}|${e.folio}`, e);
  let enX = 0, venIg = 0, impIg = 0;
  for (const d of a20) { const e = xeA.get(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`); if (!e) continue; enX += 1; if (e.vence === d.vence) venIg += 1; if (Math.abs(e.imp - d.monto) <= 1) impIg += 1; }
  console.log(`  X-A-20 compra que están en kdxe (A-20): ${enX}/${a20.length} (${pct(enX, a20.length)}); vencimiento kdxe.c10 = kdm1.c18: ${pct(venIg, enX)}; importe kdxe.c11 = c16 ±$1: ${pct(impIg, enX)}`);
  OUT.m4 = { top, contado, ok, ok1, conDias, sinParse, difs, enX, venIg, impIg };

  // ── 5. Pago: X-A-20 de compra ene–ago vs kdxf ─────────────────────────────────────────────
  const apps = new Map();
  for (const f of kdxf) {
    if (f.at !== 20) continue;
    const k = `${f.suc}|${f.c1}|${f.acr}|20|${f.as_}|${f.af}`;
    (apps.get(k) ?? apps.set(k, []).get(k)).push(f);
  }
  const fechaPago = (f) => { const p = idxD.get(keyDoc(f.suc, f.c1, 'D', f.ct, f.cs, f.cf)); return p ? { f: p.f, est: p.est, enKdm1: true } : { f: f.f, est: '', enKdm1: false }; };
  const PAGO = new Set([20, 25, 26, 60]);
  const t5 = []; const det5 = {};
  for (const z of ['00', 'resto', 'total']) {
    const o = { zona: z, docs: 0, monto: 0, en_kdxe: 0, con_pago: 0, monto_con_pago: 0, con_cualquier_apl: 0, saldado: 0, monto_aplicado_pago: 0, monto_aplicado_notas: 0, apl_cancel: 0, fecha_kdm1: 0, fecha_igual_kdxf: 0, napl: 0 };
    const dPrimero = [], dUltimo = [];
    for (const d of a20) {
      if (d.f > P1) continue; if (z !== 'total' && zona(d.suc) !== z) continue;
      o.docs += 1; o.monto += d.monto;
      if (xeA.has(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`)) o.en_kdxe += 1;
      const lst = (apps.get(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`) || []).filter((f) => {
        const fp = fechaPago(f); if (fp.est === 'C') { o.apl_cancel += 1; return false; } return true; });
      if (lst.length) o.con_cualquier_apl += 1;
      const pagos = lst.filter((f) => PAGO.has(f.ct));
      const sumAll = lst.reduce((a, f) => a + f.apl, 0);
      o.monto_aplicado_pago += pagos.reduce((a, f) => a + f.apl, 0);
      o.monto_aplicado_notas += lst.filter((f) => !PAGO.has(f.ct)).reduce((a, f) => a + f.apl, 0);
      if (sumAll >= d.monto - 1) o.saldado += 1;
      if (!pagos.length) continue;
      o.con_pago += 1; o.monto_con_pago += d.monto;
      const fechas = pagos.map((f) => { const fp = fechaPago(f); o.napl += 1; if (fp.enKdm1) { o.fecha_kdm1 += 1; if (fp.f === f.f) o.fecha_igual_kdxf += 1; } return day(fp.f); });
      if (d.vence) { dPrimero.push(Math.min(...fechas) - day(d.vence)); dUltimo.push(Math.max(...fechas) - day(d.vence)); }
    }
    det5[z] = { dPrimeroN: dPrimero.length };
    t5.push({ zona: z, XA20_compra: o.docs, monto_M: M(o.monto), en_kdxe: pct(o.en_kdxe, o.docs), con_pago: `${o.con_pago} (${pct(o.con_pago, o.docs)})`, pct_monto_con_pago: pct(o.monto_con_pago, o.monto),
      con_cualquier_aplic: pct(o.con_cualquier_apl, o.docs), saldado_100: pct(o.saldado, o.docs), aplicado_pago_M: M(o.monto_aplicado_pago), aplicado_notas_M: M(o.monto_aplicado_notas),
      apl_canceladas_excl: o.apl_cancel, d_vence_a_1er_pago_med: quant(dPrimero, 0.5), d_1er_p90: quant(dPrimero, 0.9), d_vence_a_ult_pago_med: quant(dUltimo, 0.5), d_ult_p90: quant(dUltimo, 0.9),
      pagaron_antes_o_al_vencer: pct(dUltimo.filter((x) => x <= 0).length, dUltimo.length), fecha_pago_doc_en_kdm1: pct(o.fecha_kdm1, o.napl), kdxf_c3_igual_fecha_doc: pct(o.fecha_igual_kdxf, o.fecha_kdm1) });
  }
  show(t5, `5. Pago de las X-A-20 de compra ${W0}..${P1} (kdxf estructural; cargo 20/25/26/60 = pago; aplicaciones con cargo cancelado fuera)`);
  // 5b. Sucursal sin pago propio pero con gemela en 00 pagada
  const gemDe = new Map(); for (const g of gem.values()) gemDe.set(`${g.dup_of_sucursal}|${g.dup_of_folio}`, g.cedis_folio);
  const a20_00 = new Map(a20.filter((d) => d.suc === '00').map((d) => [d.folio, d]));
  let sinPago = 0, conGem = 0, gemPagada = 0, gemPagadaM = 0, sinPagoM = 0;
  for (const d of a20) {
    if (d.f > P1 || d.suc === '00') continue;
    const lst = (apps.get(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`) || []).filter((f) => PAGO.has(f.ct) && fechaPago(f).est !== 'C');
    if (lst.length) continue; sinPago += 1; sinPagoM += d.monto;
    const gf = gemDe.get(`${d.suc}|${d.folio}`); if (!gf) continue; conGem += 1;
    const g = a20_00.get(gf);
    const gl = g ? (apps.get(`00|00|${g.prov}|20|${g.s}|${g.folio}`) || []).filter((f) => PAGO.has(f.ct) && fechaPago(f).est !== 'C') : [];
    if (gl.length) { gemPagada += 1; gemPagadaM += d.monto; }
  }
  console.log(`  5b. X-A-20 de sucursal (≠00) sin pago aplicado: ${sinPago} ($${M(sinPagoM)}M); con gemela en 00 (dedup auto/confirmado): ${conGem}; gemela 00 con pago aplicado: ${gemPagada} ($${M(gemPagadaM)}M)`);
  // 5c. Por mes de la X-A-20 (madurez)
  const porMes = {};
  for (const d of a20) {
    const m = d.f.slice(0, 7); const o = porMes[m] ??= { docs: 0, con_pago: 0, monto: 0, monto_con_pago: 0 };
    o.docs += 1; o.monto += d.monto;
    const lst = (apps.get(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`) || []).filter((f) => PAGO.has(f.ct) && fechaPago(f).est !== 'C');
    if (lst.length) { o.con_pago += 1; o.monto_con_pago += d.monto; }
  }
  show(Object.entries(porMes).sort().map(([m, o]) => ({ mes: m, docs: o.docs, con_pago: pct(o.con_pago, o.docs), pct_monto: pct(o.monto_con_pago, o.monto) })), '5c. por mes de la X-A-20 (todas las sucursales)');
  // 5d. Días por condición (contado vs crédito): vencimiento→último pago y entrada (c9)→último pago
  const t5d = [];
  for (const z of ['00', 'resto']) for (const cc of ['contado', 'crédito']) {
    const dv = [], de = []; let n = 0, np = 0;
    for (const d of a20) {
      if (d.f > P1 || zona(d.suc) !== z) continue;
      if ((/contado/i.test(d.cond) ? 'contado' : 'crédito') !== cc) continue; n += 1;
      const lst = (apps.get(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`) || []).filter((f) => PAGO.has(f.ct) && fechaPago(f).est !== 'C');
      if (!lst.length) continue; np += 1;
      const ult = Math.max(...lst.map((f) => day(fechaPago(f).f)));
      if (d.vence) dv.push(ult - day(d.vence)); de.push(ult - day(d.f));
    }
    t5d.push({ zona: z, condicion: cc, docs: n, con_pago: pct(np, n), vence_a_pago_med: quant(dv, 0.5), vence_a_pago_p90: quant(dv, 0.9), al_o_antes_vencer: pct(dv.filter((x) => x <= 0).length, dv.length), entrada_a_pago_med: quant(de, 0.5), entrada_a_pago_p90: quant(de, 0.9) });
  }
  show(t5d, '5d. Días al último pago, por condición (X-A-20 compra ene–ago con pago aplicado)');
  // 5e. ¿Con qué se saldan las X-A-20 de sucursal? composición por tipo de cargo y concepto de las X-D-55
  const comp = {}; const conc55 = {}; const fechas55 = {};
  let notaYGem = 0, soloNota = 0;
  for (const d of a20) {
    if (d.f > P1 || d.suc === '00') continue;
    const lst = (apps.get(`${d.suc}|${d.c1}|${d.prov}|20|${d.s}|${d.folio}`) || []).filter((f) => fechaPago(f).est !== 'C');
    const tipos = [...new Set(lst.map((f) => `X-D-${f.ct}`))].sort().join('+') || 'sin aplicación';
    const o = comp[tipos] ??= { n: 0, m: 0 }; o.n += 1; o.m += d.monto;
    if (tipos === 'X-D-55') {
      soloNota += 1;
      const gf = gemDe.get(`${d.suc}|${d.folio}`); const g = gf ? a20_00.get(gf) : null;
      if (g && (apps.get(`00|00|${g.prov}|20|${g.s}|${g.folio}`) || []).some((f) => PAGO.has(f.ct) && fechaPago(f).est !== 'C')) notaYGem += 1;
      for (const f of lst) { const p = idxD.get(keyDoc(f.suc, f.c1, 'D', f.ct, f.cs, f.cf)); if (!p) continue;
        const k = `${p.suc} ${p.concepto.slice(0, 40)}`; const c = conc55[k] ??= { apl: 0, m: 0 }; c.apl += 1; c.m += f.apl;
        fechas55[p.f] = (fechas55[p.f] || 0) + 1; }
    }
  }
  show(Object.entries(comp).sort((a, b) => b[1].n - a[1].n).map(([k, o]) => ({ saldada_con: k, docs: o.n, monto_M: M(o.m) })), '5e. X-A-20 compra de sucursal (≠00), ene–ago: con qué tipo de cargo se aplicaron');
  console.log(`  saldadas SOLO con nota X-D-55: ${soloNota}; de ésas con gemela en 00 que sí tiene pago aplicado: ${notaYGem}`);
  show(Object.entries(conc55).sort((a, b) => b[1].m - a[1].m).slice(0, 8).map(([k, o]) => ({ nota_suc_concepto: k, aplicaciones: o.apl, aplicado_M: M(o.m) })), '5e2. concepto (c24) de las X-D-55 que saldan X-A-20 de sucursal');
  show(Object.entries(fechas55).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({ fecha_nota: k, aplicaciones: v })), '5e3. fechas de esas notas (top)');
  OUT.m5x = { t5d, comp, conc55, soloNota, notaYGem };
  // tipos de cargo en kdxf contra X-A-20 (control del decode)
  const tc = {}; for (const f of kdxf) if (f.at === 20) { const k = `X-D-${f.ct}-${f.cs}`; tc[k] = (tc[k] || 0) + 1; }
  console.log('  cargos aplicados a abonos 20 en kdxf (toda la historia):', JSON.stringify(tc));
  OUT.m5 = { t5, sinPago, conGem, gemPagada, porMes, tc };

  // ── 6. Medio de pago ──────────────────────────────────────────────────────────────────────
  const cta = new Map(kdb1.map((k) => [k.clave, k]));
  const t6 = {}; let n6 = 0, m6 = 0, desc6 = 0;
  const puentes = {};
  for (const d of xd) {
    if (![25, 26, 60].includes(d.t) || !inW(d.f) || d.c1 !== d.suc || d.est === 'C' || clase(d.prov) !== 'C') continue;
    const k = cta.get(d.c45);
    const tipo = !d.c45 ? 'sin_declarar' : !k ? 'no_resuelve' : k.tipo;
    if (tipo === 'puente') puentes[k.nombre] = (puentes[k.nombre] || 0) + 1;
    const key = `${tipo}|X-D-${d.t}|${zona(d.suc)}`;
    const o = t6[key] ??= { n: 0, m: 0 }; o.n += 1; o.m += d.monto; n6 += 1; m6 += d.monto;
    desc6 += Number(String(d.descuento ?? '').replace(/[^0-9.-]/g, '')) || 0;
  }
  const rows6 = Object.entries(t6).sort().map(([k, o]) => { const [tipo, dt, z] = k.split('|'); return { medio: tipo, doctype: dt, zona: z, docs: o.n, monto_M: M(o.m), pct_monto: pct(o.m, m6) }; });
  const porTipo = {}; for (const [k, o] of Object.entries(t6)) { const t = k.split('|')[0]; const p = porTipo[t] ??= { n: 0, m: 0 }; p.n += o.n; p.m += o.m; }
  show(rows6, `6. Pagos X-D-25/26/60 a proveedor C% (${W0}..${W1}, propios, sin cancelados): ${n6} docs $${M(m6)}M`);
  show(Object.entries(porTipo).map(([t, o]) => ({ medio: t, docs: o.n, pct_docs: pct(o.n, n6), monto_M: M(o.m), pct_monto: pct(o.m, m6) })), '6b. por medio (control Σ)');
  console.log(`  cuentas puente usadas: ${JSON.stringify(puentes)} · descuento c84 capturado: $${M(desc6)}M`);
  const top6 = {}; for (const d of xd) if ([25, 26, 60].includes(d.t) && inW(d.f) && d.c1 === d.suc && d.est !== 'C' && clase(d.prov) === 'C') { const k = cta.get(d.c45); const nm = k ? `${d.c45} ${k.nombre}` : d.c45 || '∅'; const o = top6[nm] ??= { n: 0, m: 0 }; o.n += 1; o.m += d.monto; }
  show(Object.entries(top6).sort((a, b) => b[1].m - a[1].m).slice(0, 10).map(([k, o]) => ({ cuenta: k, docs: o.n, monto_M: M(o.m) })), '6c. top cuentas c45');
  OUT.m6 = { rows6, porTipo, puentes, desc6 };

  // ── 7. Suite ───────────────────────────────────────────────────────────────────────────────
  const s = {};
  s.req = await q(`SELECT source_type, estado, count(*) n, count(kepler_folio) con_kepler_folio, count(oc_folio) con_oc_folio,
        min(created_at)::date desde, max(created_at)::date hasta, round(sum(total_cost)::numeric/1e6,2) total_cost_M
      FROM commercial.purchase_requisitions WHERE tenant_id=$1 GROUP BY 1,2 ORDER BY 1,2`, [MEGA]);
  show(s.req, '7a. commercial.purchase_requisitions');
  s.spo = await q(`SELECT status, count(*) n, count(kepler_folio) con_kepler_folio, count(purchase_delivery_line_id) desde_entrega,
        round(sum(original_amount)::numeric/1e6,2) original_M, round(sum(paid_amount)::numeric/1e6,2) pagado_M, min(created_at)::date desde, max(created_at)::date hasta
      FROM commercial.supplier_payment_obligations WHERE tenant_id=$1 GROUP BY 1 ORDER BY 1`, [MEGA]);
  show(s.spo, '7b. commercial.supplier_payment_obligations');
  s.lots = await q(`SELECT status, count(*) n, min(lot_date) desde, max(lot_date) hasta, count(released_at) autorizados FROM finance.payment_calendar_lots WHERE tenant_id=$1 GROUP BY 1`, [MEGA]);
  show(s.lots, '7c. finance.payment_calendar_lots');
  s.alloc = await q(`SELECT status, count(*) n, count(payment_method) con_metodo, count(kepler_payment_folio) con_pago_kepler, count(executed_at) ejecutados,
        round(sum(amount_assigned)::numeric/1e6,3) asignado_M, min(created_at)::date desde, max(created_at)::date hasta FROM finance.payment_allocations WHERE tenant_id=$1 GROUP BY 1`, [MEGA]);
  show(s.alloc, '7d. finance.payment_allocations');
  s.items = await q(`SELECT obligation_source, count(*) n, round(sum(applied_amount)::numeric/1e6,3) aplicado_M, min(created_at)::date desde, max(created_at)::date hasta FROM finance.payment_allocation_items WHERE tenant_id=$1 GROUP BY 1`, [MEGA]);
  show(s.items, '7e. finance.payment_allocation_items');
  s.otros = await q(`SELECT 'payment_negotiation_agreements' t, count(*) n, min(created_at)::date desde, max(created_at)::date hasta FROM finance.payment_negotiation_agreements WHERE tenant_id=$1
      UNION ALL SELECT 'financial_commitments', count(*), min(created_at)::date, max(created_at)::date FROM finance.financial_commitments WHERE tenant_id=$1
      UNION ALL SELECT 'payment_program (pay_date)', count(*), min(pay_date), max(pay_date) FROM finance.payment_program WHERE tenant_id=$1
      UNION ALL SELECT 'payment_program kepler_matched', count(*) FILTER (WHERE kepler_matched), NULL, NULL FROM finance.payment_program WHERE tenant_id=$1
      UNION ALL SELECT 'supplier_payment_proofs (pago_date)', count(*), min(pago_date), max(pago_date) FROM finance.supplier_payment_proofs WHERE tenant_id=$1
      UNION ALL SELECT 'purchase_deliveries', count(*), min(created_at)::date, max(created_at)::date FROM commercial.purchase_deliveries WHERE tenant_id=$1
      UNION ALL SELECT 'purchase_delivery_lines', count(*), min(created_at)::date, max(created_at)::date FROM commercial.purchase_delivery_lines WHERE tenant_id=$1`, [MEGA]);
  show(s.otros, '7f. otras tablas del calendario / pago');
  s.proofs = await q(`SELECT status, count(*) n FROM finance.supplier_payment_proofs WHERE tenant_id=$1 GROUP BY 1 ORDER BY 2 DESC`, [MEGA]);
  show(s.proofs, '7g. supplier_payment_proofs por status');
  s.dl = await q(`SELECT status, count(*) n, round(sum(amount)::numeric/1e6,2) monto_M FROM commercial.purchase_delivery_lines WHERE tenant_id=$1 GROUP BY 1`, [MEGA]);
  show(s.dl, '7h. purchase_delivery_lines por status');
  OUT.m7 = s;

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify({ ventana: { W0, W1, P1 }, ...OUT }, null, 1)); console.log('JSON en ' + JSON_OUT); }
});
