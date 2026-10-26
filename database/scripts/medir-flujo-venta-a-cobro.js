'use strict';
/**
 * `[FLUJO.4]` **Medición de seguimiento del flujo «de la venta al cobro»** — sólo lectura contra prod.
 *
 * Es el instrumento que produjo las cifras de `docs/FLUJO_VENTA_A_COBRO.md` (2026-10-26). Vive en el
 * repo para RE-CORRERLO cada mes: volumen por documento de venta y cobro, a quién va la U-D-13 de
 * Oficinas, la cadena de telemarketing (con placebo), cobro del crédito, cartera viva y su aging, medio
 * de cobro (c45), cortes U-D-23 → cobro, mostrador y arqueos, y lo que la Suite tiene de cada paso.
 *
 *   node database/scripts/medir-flujo-venta-a-cobro.js [secciones…] [--desde AAAA-MM-DD] [--hasta AAAA-MM-DD]
 *                                                     [--maduro AAAA-MM-DD] [--json <ruta>]
 *   secciones: números 1..8 (p. ej. `4 7`); sin ellas, todas.
 *
 *   --desde   inicio de la ventana (c9).              Default: 1-ene del año en curso.
 *   --hasta   fin de la ventana (c9, inclusive).       Default: ayer.
 *   --maduro  último día con crédito "maduro" (§3).     Default: --hasta menos 55 días.
 *   ⚠️ Las fechas del corte del 1-oct (2026-07-03, 2026-10-01) son FIJAS a propósito: son el evento
 *   que partió el modelo de Oficinas (Fase PO), no una ventana.
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
 * Decode y trampas: `docs/FLUJO_VENTA_A_COBRO.md` y `docs/ERP_KEPLER.md` (kdm1/kdm5/kdue/kdb1).
 * ⚠️ Tickets U-D-10 (~500k/año) SIEMPRE agregados en SQL. Corrida completa: ~25 min en horario hábil.
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
  const c = new Client({ connectionString: url, application_name: 'medir-flujo-venta-a-cobro-ro' });
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
const P1 = arg('--maduro') || masDias(W1, -55);                   // ventana madura de crédito
const JSON_OUT = arg('--json');
for (const [n, v] of [['--desde', W0], ['--hasta', W1], ['--maduro', P1]]) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { console.error(`${n} inválido: ${v}`); process.exit(2); }
}
console.log(`ventana ${W0}..${W1} · crédito maduro hasta ${P1}`);

const SEC = new Set(process.argv.slice(2).filter((a) => /^\d+$/.test(a)));   // números de sección; los --flag y sus valores no cuentan
const on = (n) => !SEC.size || SEC.has(String(n));
const OUT = {};
const NOM = { '00': 'Oficinas', '01': 'Padre Hidalgo', '02': 'La Piedad Abastos', '03': '8 Esquinas', '04': 'Yurécuaro', '05': 'Zamora Centro', '06': 'Canindo', '07': 'Morelia Madero', '08': 'Morelia Abastos' };
const nom = (s) => (NOM[s] ? `${s} ${NOM[s]}` : String(s));
const day = (s) => Math.round(Date.parse(String(s).slice(0, 10) + 'T00:00:00Z') / 86400000);
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (a, b) => (b ? (a / b * 100).toFixed(1) + ' %' : '—');
const M = (n) => (Number(n) / 1e6).toFixed(2);
const quant = (arr, p) => {
  if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y);
  const i = (a.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i);
  return r2(a[lo] + (a[hi] - a[lo]) * (i - lo));
};
const inW = (f, a = W0, b = W1) => f >= a && f <= b;
const origen = (suc, c1) => (c1 === suc ? 'propio' : c1.startsWith(suc + '-') ? 'ruta' : 'replica');
const placeboFolio = (f) => { const n = String(Number(f) + 1); return n.padStart(f.length, '0'); };
// clase de cliente: TI… = sucursal propia; luego el resolvedor de la Suite (v_customer_account_kind / por código)
const CLASE_SQL = (col, kcol) => `CASE WHEN btrim(coalesce(${col},'')) ~* '^TI' THEN 'TI_sucursal'
   WHEN btrim(coalesce(${col},''))='CONTADO' THEN 'CONTADO' WHEN btrim(coalesce(${col},''))='ONLINE' THEN 'ONLINE'
   ELSE coalesce(${kcol}, analytics.customer_account_kind_by_code(btrim(${col})), 'cliente_final') END`;

run(async (q) => {
  // ── 1. Volumen por doctype y sucursal ──────────────────────────────────────────────────────
  if (on(1)) {
    const v = await q(`SELECT sucursal suc, c3 nat, c4::int t,
          CASE WHEN btrim(c1)=sucursal THEN 'propio' WHEN btrim(c1) LIKE sucursal||'-%' THEN 'ruta' ELSE 'replica' END origen,
          count(*)::int crudo, count(*) FILTER (WHERE btrim(coalesce(c43,''))='C')::int cancel,
          coalesce(sum(c16) FILTER (WHERE btrim(coalesce(c43,''))<>'C'),0)::float8 monto
        FROM kepler_ods.kdm1
        WHERE c2='U' AND ((c3='D' AND c4 IN (3,5,6,7,8,9,10,12,13,23,40,41,45)) OR (c3='A' AND c4 IN (5,7)))
          AND c9 >= $1::date AND c9 < $2::date + 1
        GROUP BY 1,2,3,4`, [W0, W1]);
    console.log(`1. filas agregadas: ${v.length} (${v.ms} ms)`);
    const dts = {}; const sucs = new Set();
    for (const r of v) {
      const dt = `U-${r.nat}-${r.t}`; const o = dts[dt] ??= { crudo: 0, replica: 0, cancel: 0, docs: 0, monto: 0, ruta_docs: 0, ruta_monto: 0, porSuc: {} };
      o.crudo += r.crudo;
      if (r.origen === 'replica') { o.replica += r.crudo; continue; }
      o.cancel += r.cancel; const n = r.crudo - r.cancel; o.docs += n; o.monto += r.monto;
      if (r.origen === 'ruta') { o.ruta_docs += n; o.ruta_monto += r.monto; }
      const ps = o.porSuc[r.suc] ??= { n: 0, m: 0 }; ps.n += n; ps.m += r.monto; sucs.add(r.suc);
    }
    const SUC = [...sucs].sort();
    const ORD = ['U-D-40', 'U-D-41', 'U-D-8', 'U-D-10', 'U-D-23', 'U-D-12', 'U-D-13', 'U-D-5', 'U-D-3', 'U-D-9', 'U-D-6', 'U-D-7', 'U-D-45', 'U-A-5', 'U-A-7'];
    const t1 = [], t1s = [];
    for (const dt of ORD) {
      const o = dts[dt]; if (!o) { t1.push({ doctype: dt, crudo: 0, replica_excl: 0, cancel_excl: 0, docs: 0, monto_M: '0.00', de_ruta_docs: 0, de_ruta_M: '0.00', control: 'sin documentos en la ventana' }); continue; }
      const ss = Object.values(o.porSuc).reduce((a, x) => a + x.n, 0);
      t1.push({ doctype: dt, crudo: o.crudo, replica_excl: o.replica, cancel_excl: o.cancel, docs: o.docs, monto_M: M(o.monto), de_ruta_docs: o.ruta_docs, de_ruta_M: M(o.ruta_monto),
        control: (ss === o.docs && o.docs + o.cancel + o.replica === o.crudo) ? 'OK' : 'FALLA' });
      const row = { doctype: dt }; for (const s of SUC) row[s] = o.porSuc[s] ? `${o.porSuc[s].n}/${M(o.porSuc[s].m)}` : '0'; t1s.push(row);
    }
    show(t1, `1. Volumen por doctype, c9 ${W0}..${W1} (docs y $M c16; propio+ruta; sin réplica ni cancelados c43='C')`);
    show(t1s, '1b. por sucursal: docs/$M (00 Oficinas, 01 Padre Hidalgo, 02 La Piedad Abastos, 03 8 Esquinas, 04 Yurécuaro, 05 Zamora Centro, 06 Canindo, 07 Morelia Madero, 08 Morelia Abastos)');
    // fuera de ventana por fecha absurda
    const raras = await q(`SELECT c3 nat, c4::int t, count(*) FILTER (WHERE c9::date > $1::date)::int futuras, count(*) FILTER (WHERE c9 < '2000-01-01')::int anio_1800
        FROM kepler_ods.kdm1 WHERE c2='U' AND ((c3='D' AND c4 IN (8,10,12,13,23,40,41)) OR (c3='A' AND c4 IN (5,7))) AND (c9::date > $1::date OR c9 < '2000-01-01')
        GROUP BY 1,2`, [HOY]);
    show(raras, `1c. documentos con c9 en el FUTURO (> ${HOY}) o en 1800 (fuera de la ventana; declarados)`);
    // pre/post corte del 1-oct (00 deja de concentrar)
    const pp = await q(`SELECT c4::int t, CASE WHEN sucursal='00' THEN '00' ELSE 'resto' END z, (c9::date >= '2026-10-01') post,
          count(*)::int n, sum(c16)::float8 m
        FROM kepler_ods.kdm1 WHERE c2='U' AND c3 IN ('D','A') AND ((c3='D' AND c4 IN (13,12,8,23)) OR (c3='A' AND c4 IN (5,7)))
          AND c9 >= $1::date AND c9 < $2::date + 1 AND (btrim(c1)=sucursal OR btrim(c1) LIKE sucursal||'-%') AND btrim(coalesce(c43,''))<>'C'
        GROUP BY 1,2,3 ORDER BY 1,2,3`, [W0, W1]);
    show(pp.map((r) => ({ doctype: (r.t === 5 || r.t === 7) ? `U-A-${r.t}` : `U-D-${r.t}`, zona: r.z, periodo: r.post ? 'oct (1–25)' : 'ene–sep', docs: r.n, monto_M: M(r.m) })), '1d. antes / después del 1-oct (fin del 00 concentrador)');
    // clase de cliente en U-D-8 / 12 / 13
    const cl = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind)
        SELECT m.c4::int t, CASE WHEN m.sucursal='00' THEN '00' ELSE 'resto' END z, ${CLASE_SQL('m.c10', 'k.kind')} clase,
          count(*)::int n, sum(m.c16)::float8 monto
        FROM kepler_ods.kdm1 m LEFT JOIN k ON k.cliente_code=btrim(m.c10)
        WHERE m.c2='U' AND m.c3='D' AND m.c4 IN (8,12,13) AND m.c9 >= $1::date AND m.c9 < $2::date + 1
          AND btrim(m.c1)=m.sucursal AND btrim(coalesce(m.c43,''))<>'C'
        GROUP BY 1,2,3 ORDER BY 1,2,5 DESC`, [W0, W1]);
    const tot = {}; for (const r of cl) { const k = `U-D-${r.t}`; const o = tot[k] ??= { n: 0, m: 0 }; o.n += r.n; o.m += r.monto; }
    show(cl.map((r) => ({ doctype: `U-D-${r.t}`, zona: r.z, clase: r.clase, docs: r.n, monto_M: M(r.monto), pct_monto_doctype: pct(r.monto, tot[`U-D-${r.t}`].m) })), '1e. U-D-8/12/13 por clase de cliente (TI… sucursal propia; interno NN-NN; ruta RD/RV/RUTA; CONTADO; ONLINE; resto = cliente_final)');
    console.log('  control Σ por clase =', JSON.stringify(Object.fromEntries(Object.entries(tot).map(([k, o]) => [k, { docs: o.n, M: M(o.m) }]))), ' (debe igualar 1. para propios; 1. incluye ruta)');
    const top = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, cliente_nombre, kind FROM analytics.v_customer_account_kind),
          t AS (SELECT sum(c16)::float8 tot FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4=13 AND c9 >= $1::date AND c9 < $2::date + 1 AND btrim(c1)=sucursal AND btrim(coalesce(c43,''))<>'C')
        SELECT btrim(m.c10) cliente, max(k.cliente_nombre) nombre, ${CLASE_SQL('max(m.c10)', 'max(k.kind)')} clase,
          string_agg(DISTINCT m.sucursal, ',') sucs, count(*)::int docs, sum(m.c16)::float8 monto, max(t.tot) tot
        FROM kepler_ods.kdm1 m LEFT JOIN k ON k.cliente_code=btrim(m.c10) CROSS JOIN t
        WHERE m.c2='U' AND m.c3='D' AND m.c4=13 AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(m.c1)=m.sucursal AND btrim(coalesce(m.c43,''))<>'C'
        GROUP BY 1 ORDER BY monto DESC LIMIT 12`, [W0, W1]);
    show(top.map((r) => ({ cliente: r.cliente, nombre: r.nombre, clase: r.clase, sucursales: r.sucs, docs: r.docs, monto_M: M(r.monto), pct_U_D_13: pct(r.monto, r.tot) })), '1f. top clientes de U-D-13 por monto (ventana)');
    // 1g. U-D-13 de Oficinas por clase y periodo (contraste con «84 % de 3-jul→1-oct era la casa: TI### y rutas propias»)
    const per = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind)
        SELECT CASE WHEN m.c9::date < '2026-07-03' THEN '1 ene–2 jul' WHEN m.c9::date < '2026-10-01' THEN '2 3 jul–30 sep' ELSE '3 1–25 oct' END periodo,
          ${CLASE_SQL('m.c10', 'k.kind')} clase, count(*)::int n, sum(m.c16)::float8 monto
        FROM kepler_ods.kdm1 m LEFT JOIN k ON k.cliente_code=btrim(m.c10)
        WHERE m.c2='U' AND m.c3='D' AND m.c4=13 AND m.sucursal='00' AND btrim(m.c1)='00' AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(coalesce(m.c43,''))<>'C'
        GROUP BY 1,2 ORDER BY 1,4 DESC`, [W0, W1]);
    const pt = {}; for (const r of per) { const o = pt[r.periodo] ??= { n: 0, m: 0 }; o.n += r.n; o.m += r.monto; }
    show(per.map((r) => ({ periodo: r.periodo.slice(2), clase: r.clase, docs: r.n, pct_docs: pct(r.n, pt[r.periodo].n), monto_M: M(r.monto), pct_monto: pct(r.monto, pt[r.periodo].m) })), '1g. U-D-13 de 00 Oficinas por periodo y clase (casa = interno NN-NN + ruta + TI)');
    const casa = Object.entries(pt).map(([p, o]) => { const c = per.filter((r) => r.periodo === p && ['interno', 'ruta', 'TI_sucursal'].includes(r.clase)); return { periodo: p.slice(2), docs: o.n, monto_M: M(o.m), casa_pct_docs: pct(c.reduce((s, r) => s + r.n, 0), o.n), casa_pct_monto: pct(c.reduce((s, r) => s + r.monto, 0), o.m), TI_docs: per.filter((r) => r.periodo === p && r.clase === 'TI_sucursal').reduce((s, r) => s + r.n, 0) }; });
    show(casa, '1g2. resumen «la casa facturándose a sí misma» en U-D-13 de Oficinas');
    const ti = await q(`SELECT sucursal, count(*)::int n, sum(c16)::float8 m FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4=13 AND btrim(c10) ~* '^TI' GROUP BY 1`);
    console.log('  U-D-13 con cliente TI… en toda la historia de kdm1:', JSON.stringify(ti));
    const tiOtros = await q(`SELECT c4::int t, count(*)::int n, round(sum(c16)/1e6,2)::float8 m FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND btrim(c10) ~* '^TI' AND c9 >= $1::date AND c9 < $2::date + 1 AND btrim(c1)=sucursal AND btrim(coalesce(c43,''))<>'C' GROUP BY 1 ORDER BY 3 DESC`, [W0, W1]);
    console.log('  ¿dónde SÍ aparecen los clientes TI… (doctypes U-D, ventana)?', JSON.stringify(tiOtros));
    OUT.m1x = { per, casa, ti, tiOtros };
    OUT.m1 = { t1, t1s, raras, pp, cl, top };
  }

  // ── Extracciones chicas compartidas por 2, 3 y 6 ──────────────────────────────────────────
  let docs = null, kdm5 = null, idx = null, idxA = null;
  const key = (c1, nat, t, s, folio) => `${c1}|${nat}|${t}|${s}|${folio}`;
  if (on(2) || on(3) || on(6)) {
    docs = await q(`SELECT sucursal suc, btrim(c1) c1, c3 nat, c4::int t, c5::int s, btrim(c6) folio, c9::date::text f,
          btrim(coalesce(c10,'')) cli, btrim(coalesce(c11,'')) st, coalesce(c16,0)::float8 monto, btrim(coalesce(c43,'')) est,
          btrim(coalesce(c36,'')) p_nat, coalesce(c37,0)::int p_t, coalesce(c38,0)::int p_s, btrim(coalesce(c39,'')) p_folio,
          btrim(coalesce(c45,'')) c45
        FROM kepler_ods.kdm1 WHERE c2='U' AND ((c3='D' AND c4 IN (8,13,12,23,40,41)) OR (c3='A' AND c4 IN (5,7,21,25,30,35,40,65)))`);
    // kdm5 VIGENTE (sin aplicaciones de documentos cancelados, CSU.11 / GOTCHAS §89). Monto aplicado = c13.
    // Quién aplica = c2..c6 (género, naturaleza, tipo, subtipo, folio); a qué = c1 sucursal + c8 naturaleza, c9 tipo, c10 subtipo, c11 folio.
    kdm5 = await q(`SELECT sucursal suc, btrim(c1) c1, c3 a_nat, c4::int a_t, c5::int a_s, btrim(c6) a_folio, c7::int seq,
          btrim(c8) d_nat, c9::int d_t, c10::int d_s, btrim(c11) d_folio, coalesce(c12,0)::float8 m12, coalesce(c13,0)::float8 m13
        FROM analytics.kepler_kdm5_vigente WHERE c2='U'`);
    const crudo5 = await q(`SELECT count(*)::int n, coalesce(sum(c13),0)::float8 m FROM kepler_ods.kdm5 WHERE c2='U'`);
    console.log(`extracciones: kdm1 U (sin tickets) ${docs.length} filas (${docs.ms} ms) · kdm5 vigente U ${kdm5.length} (${kdm5.ms} ms) · kdm5 crudo U ${crudo5[0].n} → ${crudo5[0].n - kdm5.length} aplicaciones de documentos cancelados fuera ($${M(crudo5[0].m - kdm5.reduce((s, a) => s + a.m13, 0))}M)`);
    const rep = kdm5.filter((a) => a.c1 !== a.suc).length;
    kdm5 = kdm5.filter((a) => a.c1 === a.suc);
    console.log(`  kdm5: réplicas excluidas (c1≠sucursal) ${rep}; quedan ${kdm5.length}; Σc12−Σc13 = ${r2(kdm5.reduce((a, x) => a + x.m12 - x.m13, 0))}`);
    idx = new Map(); for (const d of docs) if (origen(d.suc, d.c1) !== 'replica') idx.set(key(d.c1, d.nat, d.t, d.s, d.folio), d);
    idxA = idx;
    // muestra de verificación del layout de kdm5 (5 aplicaciones al azar contra kdm1)
    const smp = [...kdm5].sort(() => Math.random() - 0.5).slice(0, 5).map((a) => {
      const c = idx.get(key(a.c1, 'A', a.a_t, a.a_s, a.a_folio)); const f = idx.get(key(a.c1, a.d_nat, a.d_t, a.d_s, a.d_folio));
      return { cobro: `${a.c1} U-A-${a.a_t}-${a.a_s} ${a.a_folio}`, aplicado: a.m13, cobro_en_kdm1: c ? `${c.f} ${c.cli} $${c.monto}` : 'NO', doc: `U-${a.d_nat}-${a.d_t}-${a.d_s} ${a.d_folio}`, doc_en_kdm1: f ? `${f.f} ${f.cli} $${f.monto}` : 'NO', mismo_cliente: c && f ? String(c.cli === f.cli) : '—' };
    });
    show(smp, 'muestra kdm5 (layout c2..c6 = cobro, c8..c11 = documento, c13 = aplicado)');
  }

  // ── 2. Cadena telemarketing ────────────────────────────────────────────────────────────────
  if (on(2)) {
    const PADRE = { 41: 40, 8: 41 };
    const t2 = [];
    const pares = { 41: [], 8: [] };
    for (const t of [41, 8]) for (const sub of (t === 41 ? [1, 2] : [1])) {
      const o = { hijo: `U-D-${t}-${sub}`, padre: `U-D-${PADRE[t]}`, docs: 0, monto: 0, declara: 0, declara_otro: 0, sin_liga: 0, existe: 0, monto_lig: 0, mismo_cli: 0, padre_cancel: 0, pl_existe: 0, pl_mismo_cli: 0 };
      for (const d of docs) {
        if (d.nat !== 'D' || d.t !== t || d.s !== sub || !inW(d.f) || d.c1 !== d.suc || d.est === 'C') continue;
        o.docs += 1; o.monto += d.monto;
        if (!d.p_folio || !d.p_t) { o.sin_liga += 1; continue; }
        if (d.p_t !== PADRE[t]) { o.declara_otro += 1; continue; }
        o.declara += 1;
        const p = idx.get(key(d.c1, d.p_nat || 'D', d.p_t, d.p_s, d.p_folio));
        if (p) { o.existe += 1; o.monto_lig += d.monto; if (p.cli === d.cli) o.mismo_cli += 1; if (p.est === 'C') o.padre_cancel += 1; pares[t].push({ h: d, p }); }
        const pl = idx.get(key(d.c1, d.p_nat || 'D', d.p_t, d.p_s, placeboFolio(d.p_folio)));
        if (pl) { o.pl_existe += 1; if (pl.cli === d.cli) o.pl_mismo_cli += 1; }
      }
      t2.push({ hijo: o.hijo, padre: o.padre, docs: o.docs, monto_M: M(o.monto), declara_liga: pct(o.declara, o.docs), padre_existe: `${o.existe} (${pct(o.existe, o.docs)})`, pct_monto_ligado: pct(o.monto_lig, o.monto),
        sin_liga: o.sin_liga, declara_otro: o.declara_otro, mismo_cliente: pct(o.mismo_cli, o.existe), padre_cancel: o.padre_cancel, placebo_f1_mismo_cliente: `${pct(o.pl_mismo_cli, o.pl_existe)} de ${o.pl_existe}`,
        control: o.declara + o.declara_otro + o.sin_liga === o.docs ? 'OK' : 'FALLA' });
    }
    // U-A-7 → U-D-8 por kdm5 (la cabecera del cobro no trae liga c37/c39: medido)
    const a7 = docs.filter((d) => d.nat === 'A' && d.t === 7 && inW(d.f) && d.c1 === d.suc && d.est !== 'C');
    const a7conLiga = a7.filter((d) => d.p_folio && d.p_t).length;
    const appsDe = new Map(); const appsA = new Map();
    for (const a of kdm5) {
      const c = idx.get(key(a.c1, 'A', a.a_t, a.a_s, a.a_folio));
      if (c && c.est === 'C') continue; // cobro cancelado: su aplicación sigue en kdm5 (CSU.11)
      const kd = key(a.c1, a.d_nat, a.d_t, a.d_s, a.d_folio); (appsDe.get(kd) ?? appsDe.set(kd, []).get(kd)).push({ ...a, cobro: c });
      const ka = key(a.c1, 'A', a.a_t, a.a_s, a.a_folio); (appsA.get(ka) ?? appsA.set(ka, []).get(ka)).push(a);
    }
    const o7 = { cobros: a7.length, monto: a7.reduce((s, d) => s + d.monto, 0), con_apl: 0, apl_a8: 0, fac_existe: 0, mismo_cli: 0, pl_existe: 0, pl_mismo: 0, sum_ok: 0 };
    for (const d of a7) {
      const ls = appsA.get(key(d.c1, 'A', 7, d.s, d.folio)) || []; if (!ls.length) continue; o7.con_apl += 1;
      const l8 = ls.filter((a) => a.d_t === 8); if (l8.length) o7.apl_a8 += 1;
      if (Math.abs(ls.reduce((s, a) => s + a.m13, 0) - d.monto) <= 1) o7.sum_ok += 1;
      const a = l8[0] || ls[0]; const f = idx.get(key(a.c1, a.d_nat, a.d_t, a.d_s, a.d_folio));
      if (f) { o7.fac_existe += 1; if (f.cli === d.cli) o7.mismo_cli += 1; }
      const pl = idx.get(key(a.c1, a.d_nat, a.d_t, a.d_s, placeboFolio(a.d_folio))); if (pl) { o7.pl_existe += 1; if (pl.cli === d.cli) o7.pl_mismo += 1; }
    }
    t2.push({ hijo: 'U-A-7 (cobro)', padre: 'U-D-8 vía kdm5', docs: o7.cobros, monto_M: M(o7.monto), declara_liga: `c37/c39 en cabecera: ${a7conLiga}`, padre_existe: `${o7.fac_existe} (${pct(o7.fac_existe, o7.cobros)})`,
      pct_monto_ligado: `con aplicación ${pct(o7.con_apl, o7.cobros)}; a U-D-8 ${pct(o7.apl_a8, o7.cobros)}`, sin_liga: o7.cobros - o7.con_apl, declara_otro: '', mismo_cliente: pct(o7.mismo_cli, o7.fac_existe),
      padre_cancel: '', placebo_f1_mismo_cliente: `${pct(o7.pl_mismo, o7.pl_existe)} de ${o7.pl_existe}`, control: `Σaplicado=c16 ±$1: ${pct(o7.sum_ok, o7.con_apl)}` });
    show(t2, `2. Cadena telemarketing: cobertura de la liga del hijo (c36..c39) y del cobro (kdm5), hijos propios no cancelados con c9 ${W0}..${W1}`);
    // Cobertura de cobro de las facturas U-D-8 (ventana) y tiempos
    const f8 = docs.filter((d) => d.nat === 'D' && d.t === 8 && inW(d.f) && d.c1 === d.suc && d.est !== 'C');
    const f8m = docs.filter((d) => d.nat === 'D' && d.t === 8 && inW(d.f, W0, P1) && d.c1 === d.suc && d.est !== 'C');
    const cob = (d) => (appsDe.get(key(d.c1, 'D', 8, d.s, d.folio)) || []);
    const cobrosDe = (d) => cob(d).filter((a) => a.a_t === 5 || a.a_t === 7);
    let saldada = 0, conCobro = 0, mCobrado = 0, mTot = 0; const dFacCobroUlt = [], dFacCobro1 = [];
    for (const d of f8m) {
      const ls = cob(d); const cs = cobrosDe(d); mTot += d.monto;
      const ap = ls.reduce((s, a) => s + a.m13, 0); if (ap >= d.monto - 0.01) saldada += 1;
      if (!cs.length) continue; conCobro += 1; mCobrado += Math.min(d.monto, cs.reduce((s, a) => s + a.m13, 0));
      const fs_ = cs.map((a) => a.cobro ? day(a.cobro.f) : null).filter((x) => x !== null);
      if (fs_.length) { dFacCobro1.push(Math.min(...fs_) - day(d.f)); dFacCobroUlt.push(Math.max(...fs_) - day(d.f)); }
    }
    console.log(`  U-D-8 ${W0}..${P1}: ${f8m.length} facturas $${M(mTot)}M; con cobro U-A-5/7 aplicado ${pct(conCobro, f8m.length)}; $ cobrado ${pct(mCobrado, mTot)}; saldadas (cualquier abono) ${pct(saldada, f8m.length)}`);
    // tiempos
    const tt = [];
    const tramo = (nombre, arr) => tt.push({ tramo: nombre, pares: arr.length, mediana: quant(arr, 0.5), p90: quant(arr, 0.9), mismo_dia: pct(arr.filter((x) => x === 0).length, arr.length), negativos: arr.filter((x) => x < 0).length });
    tramo('pedido U-D-40 → embarque U-D-41-1', pares[41].filter((x) => x.h.s === 1 && x.p.f > '1900').map((x) => day(x.h.f) - day(x.p.f)));
    tramo('pedido U-D-40 → embarque U-D-41-2 (sucursal)', pares[41].filter((x) => x.h.s === 2 && x.p.f > '1900').map((x) => day(x.h.f) - day(x.p.f)));
    tramo('embarque U-D-41 → factura U-D-8', pares[8].map((x) => day(x.h.f) - day(x.p.f)));
    tramo(`factura U-D-8 → 1er cobro (facturas ${W0}..${P1})`, dFacCobro1);
    tramo(`factura U-D-8 → último cobro (facturas ${W0}..${P1})`, dFacCobroUlt);
    // de punta a punta: pedido → último cobro (factura saldada y ligada)
    const e2e = [];
    const emb = new Map(pares[41].map((x) => [key(x.h.c1, 'D', 41, x.h.s, x.h.folio), x.p]));
    for (const x of pares[8]) {
      const d = x.h; if (!inW(d.f, W0, P1)) continue; const ped = emb.get(key(x.p.c1, 'D', 41, x.p.s, x.p.folio)) ||
        (() => { const p = idx.get(key(x.p.c1, x.p.p_nat || 'D', x.p.p_t, x.p.p_s, x.p.p_folio)); return p; })();
      if (!ped || ped.f < '1900') continue; const cs = cobrosDe(d); if (!cs.length) continue;
      const ap = cob(d).reduce((s, a) => s + a.m13, 0); if (ap < d.monto - 0.01) continue;
      const fs_ = cs.map((a) => a.cobro ? day(a.cobro.f) : null).filter((y) => y !== null); if (!fs_.length) continue;
      e2e.push(Math.max(...fs_) - day(ped.f));
    }
    tramo('pedido → último cobro (factura saldada, cadena completa)', e2e);
    show(tt, '2b. Días entre documentos ligados (c9; en el cobro c9 = día del tecleo)');
    // cobertura de la cadena completa desde el embarque telemarketing
    const e41 = docs.filter((d) => d.nat === 'D' && d.t === 41 && d.s === 1 && inW(d.f) && d.c1 === d.suc && d.est !== 'C');
    const facDe = new Map(); for (const x of pares[8]) { const k = key(x.p.c1, 'D', 41, x.p.s, x.p.folio); (facDe.get(k) ?? facDe.set(k, []).get(k)).push(x.h); }
    let conFac = 0, conPed = 0, conCob = 0; const stE = {};
    for (const e of e41) {
      stE[e.st || '∅'] = (stE[e.st || '∅'] || 0) + 1;
      if (e.p_t === 40 && idx.get(key(e.c1, 'D', 40, e.p_s, e.p_folio))) conPed += 1;
      const fs_ = facDe.get(key(e.c1, 'D', 41, 1, e.folio)) || []; if (fs_.length) conFac += 1;
      if (fs_.some((f) => f.est !== 'C' && cobrosDe(f).length)) conCob += 1;
    }
    console.log(`  embarques U-D-41-1 en ventana: ${e41.length}; con pedido ${pct(conPed, e41.length)}; con factura U-D-8 que lo cita ${pct(conFac, e41.length)}; con factura cobrada ${pct(conCob, e41.length)}; estatus c11: ${JSON.stringify(stE)}`);
    const p40 = docs.filter((d) => d.nat === 'D' && d.t === 40 && inW(d.f) && d.c1 === d.suc && d.est !== 'C');
    const embDe = new Set(pares[41].map((x) => key(x.p.c1, 'D', 40, x.p.s, x.p.folio)));
    const st40 = {}; for (const p of p40) st40[p.st || '∅'] = (st40[p.st || '∅'] || 0) + 1;
    console.log(`  pedidos U-D-40 en ventana: ${p40.length} ($${M(p40.reduce((s, d) => s + d.monto, 0))}M); con embarque que los cita ${pct(p40.filter((p) => embDe.has(key(p.c1, 'D', 40, p.s, p.folio))).length, p40.length)}; estatus c11: ${JSON.stringify(st40)}`);
    OUT.m2 = { t2, tt, conCobro, f8m: f8m.length, saldada, mCobrado, mTot };
  }

  // ── 3. Crédito: cargos ene–ago de la cartera (erp_receivable_documents) ───────────────────
  if (on(3)) {
    // MATERIALIZED a propósito: sin él el planificador empuja el filtro y el join adentro de la vista (>60 s medido)
    const c = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
          r AS MATERIALIZED (SELECT * FROM analytics.erp_receivable_documents WHERE cargo_abono='C')
        SELECT r.sucursal suc, r.doc_code, r.folio, r.cliente_code cli, r.fecha::text f, r.vencimiento::text v, r.importe::float8 imp,
          r.saldo_documento::float8 saldo, r.aplicaciones apls, ${CLASE_SQL('r.cliente_code', 'k.kind')} clase
        FROM r LEFT JOIN k ON k.cliente_code=btrim(r.cliente_code)
        WHERE r.fecha BETWEEN $1::date AND $2::date`, [W0, P1]);
    console.log(`3. cargos ${W0}..${P1} en erp_receivable_documents: ${c.length} (${c.ms} ms)`);
    const grp = (fn) => {
      const g = {};
      for (const d of c) {
        const k = fn(d); const o = g[k] ??= { docs: 0, imp: 0, con_apl: 0, con_cobro: 0, saldado: 0, m_cobro: 0, m_otros: 0, dv: [], de: [], sinFecha: 0, sinVenc: 0 };
        o.docs += 1; o.imp += d.imp;
        const ap = d.apls || []; if (ap.length) o.con_apl += 1;
        const cob = ap.filter((a) => a.tipo === 'cobro'); if (cob.length) o.con_cobro += 1;
        o.m_cobro += Math.min(d.imp, cob.reduce((s, a) => s + Number(a.monto), 0));
        o.m_otros += ap.filter((a) => a.tipo !== 'cobro').reduce((s, a) => s + Number(a.monto), 0);
        if (d.saldo <= 0.005) {
          o.saldado += 1;
          const fs_ = ap.map((a) => a.fecha).filter(Boolean); if (fs_.length < ap.length) o.sinFecha += 1;
          if (fs_.length) { const ult = Math.max(...fs_.map(day)); if (d.v) o.dv.push(ult - day(d.v)); else o.sinVenc += 1; o.de.push(ult - day(d.f)); }
        }
      }
      return Object.entries(g).sort((a, b) => b[1].imp - a[1].imp).map(([k, o]) => ({ grupo: k, cargos: o.docs, importe_M: M(o.imp), con_aplicacion: pct(o.con_apl, o.docs), con_cobro: pct(o.con_cobro, o.docs),
        saldado_docs: pct(o.saldado, o.docs), pct_monto_cobrado: pct(o.m_cobro, o.imp), notas_y_otros_M: M(o.m_otros), venc_a_saldo_med: quant(o.dv, 0.5), venc_a_saldo_p90: quant(o.dv, 0.9),
        a_tiempo: pct(o.dv.filter((x) => x <= 0).length, o.dv.length), emision_a_saldo_med: quant(o.de, 0.5), emision_a_saldo_p90: quant(o.de, 0.9), saldados_sin_fecha_apl: o.sinFecha, _n: o.docs, _imp: o.imp }));
    };
    const ctrl = (rows) => `control Σ cargos ${rows.reduce((s, r) => s + r._n, 0)} = ${c.length} · Σ$ ${M(rows.reduce((s, r) => s + r._imp, 0))}M`;
    const strip = (rows) => rows.map(({ _n, _imp, ...r }) => r);
    const gC = grp((d) => d.doc_code); show(strip(gC), `3a. Crédito por documento (canal), cargos ${W0}..${P1}; cobro = aplicaciones U-A-5/7 (kdm5 vigente); días = última aplicación − vencimiento — ${ctrl(gC)}`);
    const gK = grp((d) => d.clase); show(strip(gK), `3b. por clase de cliente — ${ctrl(gK)}`);
    const gS = grp((d) => nom(d.suc)); show(strip(gS), `3c. por sucursal — ${ctrl(gS)}`);
    const gT = grp((d) => (d.doc_code === 'UD1301' && d.clase === 'cliente_final') ? 'UD1301 cliente_final' : (d.doc_code === 'UD0801' && d.clase === 'cliente_final') ? 'UD0801 cliente_final' : 'otros');
    show(strip(gT), `3d. crédito a TERCEROS (cliente_final) en los dos canales grandes — ${ctrl(gT)}`);
    // 3e. Segunda implementación: Σ aplicado por kdm5 crudo (con c1=sucursal y cobro no cancelado) vs la vista
    if (kdm5) {
      const raw = (await q(`SELECT btrim(c1) c1, c4::int a_t, c5::int a_s, btrim(c6) a_folio, btrim(c8) d_nat, c9::int d_t, c10::int d_s, btrim(c11) d_folio, coalesce(c13,0)::float8 m13
          FROM kepler_ods.kdm5 WHERE c2='U' AND btrim(c1)=sucursal`));
      const apl = new Map();
      for (const a of raw) {
        if (![5, 7, 21, 25, 30, 35, 40].includes(a.a_t)) continue;
        const cb = idxA.get(key(a.c1, 'A', a.a_t, a.a_s, a.a_folio)); if (cb && cb.est === 'C') continue;
        const k = `${a.c1}|U${a.d_nat}${String(a.d_t).padStart(2, '0')}${String(a.d_s).padStart(2, '0')}|${a.d_folio}`; apl.set(k, (apl.get(k) || 0) + a.m13);
      }
      let dif = 0, difM = 0, ok = 0;
      for (const d of c) { const mine = Math.min(d.imp, apl.get(`${d.suc}|${d.doc_code}|${d.folio}`) || 0); const vista = d.imp - d.saldo; if (Math.abs(mine - vista) <= 0.01) ok += 1; else { dif += 1; difM += mine - vista; } }
      console.log(`  3e. 2ª implementación (kdm5 crudo − cobros cancelados) vs vista: ${ok}/${c.length} cargos al centavo (${pct(ok, c.length)}); ${dif} difieren, Σ Δ $${r2(difM)}`);
    } else console.log('  3e. (correr junto con la sección 2 o 6 para la 2ª implementación)');
    OUT.m3 = { gC: strip(gC), gK: strip(gK), gS: strip(gS), gT: strip(gT) };
  }

  // ── 4. Cartera viva hoy ───────────────────────────────────────────────────────────────────
  if (on(4)) {
    const a = await q(`WITH h AS (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date d),
        k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
        doc AS MATERIALIZED (SELECT r.sucursal, r.cliente_code, r.vencimiento, r.saldo_cliente, r.cargo_abono, r.signed_amount,
            GREATEST(COALESCE(r.saldo_ajustado,0),0) res, ${CLASE_SQL('r.cliente_code', 'k.kind')} clase
          FROM analytics.customer_receivables r LEFT JOIN k ON k.cliente_code=btrim(r.cliente_code)),
        cli AS (SELECT sucursal, coalesce(cliente_code,'∅') cli, max(clase) clase, sum(signed_amount) neto FROM doc GROUP BY 1,2)
        SELECT x.sucursal suc, x.clase,
          (SELECT round(sum(GREATEST(neto,0)),2) FROM cli WHERE cli.sucursal=x.sucursal AND cli.clase=x.clase)::float8 saldo_canonico,
          (SELECT round(sum(LEAST(neto,0)),2) FROM cli WHERE cli.sucursal=x.sucursal AND cli.clase=x.clase)::float8 a_favor,
          (SELECT count(*) FROM cli WHERE cli.sucursal=x.sucursal AND cli.clase=x.clase AND neto > 0.005)::int clientes,
          x.res::float8, x.por_vencer::float8, x.d0_30::float8, x.d31_60::float8, x.d61_90::float8, x.d90::float8
        FROM (SELECT d.sucursal, d.clase,
            round(sum(d.res) FILTER (WHERE d.cargo_abono='C' AND d.res>0.005),2) res,
            round(coalesce(sum(d.res) FILTER (WHERE d.cargo_abono='C' AND d.res>0.005 AND (d.vencimiento IS NULL OR d.vencimiento >= h.d)),0),2) por_vencer,
            round(coalesce(sum(d.res) FILTER (WHERE d.cargo_abono='C' AND d.res>0.005 AND h.d - d.vencimiento BETWEEN 1 AND 30),0),2) d0_30,
            round(coalesce(sum(d.res) FILTER (WHERE d.cargo_abono='C' AND d.res>0.005 AND h.d - d.vencimiento BETWEEN 31 AND 60),0),2) d31_60,
            round(coalesce(sum(d.res) FILTER (WHERE d.cargo_abono='C' AND d.res>0.005 AND h.d - d.vencimiento BETWEEN 61 AND 90),0),2) d61_90,
            round(coalesce(sum(d.res) FILTER (WHERE d.cargo_abono='C' AND d.res>0.005 AND h.d - d.vencimiento > 90),0),2) d90
          FROM doc d CROSS JOIN h GROUP BY 1,2) x ORDER BY 1,2`);
    console.log(`4. cartera (customer_receivables) ${a.length} celdas (${a.ms} ms)`);
    const bySuc = {}; const byK = {};
    const add = (o, r) => { for (const k of ['saldo_canonico', 'a_favor', 'clientes', 'res', 'por_vencer', 'd0_30', 'd31_60', 'd61_90', 'd90']) o[k] = (o[k] || 0) + (Number(r[k]) || 0); };
    for (const r of a) { add(bySuc[r.suc] ??= {}, r); add(byK[r.clase] ??= {}, r); }
    const fmt = (k, o) => ({ grupo: k, saldo_canonico_M: M(o.saldo_canonico), clientes_con_saldo: o.clientes, en_partidas_M: M(o.res), sin_documento_M: M(o.saldo_canonico - o.res), por_vencer_M: M(o.por_vencer), venc_1_30_M: M(o.d0_30), venc_31_60_M: M(o.d31_60), venc_61_90_M: M(o.d61_90), venc_90_mas_M: M(o.d90), pct_vencido: pct(o.d0_30 + o.d31_60 + o.d61_90 + o.d90, o.res), saldos_a_favor_M: M(o.a_favor),
      control_buckets: Math.abs(o.por_vencer + o.d0_30 + o.d31_60 + o.d61_90 + o.d90 - o.res) < 1 ? 'OK' : 'FALLA' });
    const tot = {}; for (const o of Object.values(bySuc)) add(tot, o);
    show([...Object.entries(bySuc).sort().map(([k, o]) => fmt(nom(k), o)), fmt('TOTAL', tot)], '4a. Cartera viva hoy por sucursal (saldo canónico = Σ max(Σ signed del cliente,0) de kdue; antigüedad = saldo_ajustado FIFO por vencimiento, como /finanzas/cartera)');
    show(Object.entries(byK).sort().map(([k, o]) => fmt(k, o)), '4b. por clase de cuenta');
    show(a.filter((r) => Math.abs(r.saldo_canonico) > 1 || Math.abs(r.a_favor) > 1).map((r) => ({ sucursal: nom(r.suc), clase: r.clase, saldo_canonico_M: M(r.saldo_canonico), clientes: r.clientes, vencido_M: M(r.d0_30 + r.d31_60 + r.d61_90 + r.d90), venc_90_mas_M: M(r.d90), a_favor_M: M(r.a_favor) })), '4b2. sucursal × clase');
    // 4c. Reconciliación contra kdue directo (otra consulta, mismo criterio de doctypes) + universo crudo
    const kd = await q(`WITH src AS (SELECT DISTINCT ON (btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6)) btrim(c1) suc, btrim(coalesce(c2,'')) cli, c29, c4::int t, c11
          FROM kepler_ods.kdue WHERE c29 IN ('C','A') ORDER BY btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6), c7),
        f AS (SELECT * FROM src WHERE (c29='C' AND t IN (3,8,9,12,13,25,41)) OR (c29='A' AND t IN (5,7,21,25,30,35,40))),
        cl AS (SELECT suc, cli, sum(CASE WHEN c29='C' THEN c11 ELSE -c11 END) s FROM f GROUP BY 1,2)
        SELECT suc, round(sum(GREATEST(s,0)),2)::float8 saldo_pos, round(sum(LEAST(s,0)),2)::float8 a_favor, round(sum(s),2)::float8 neto FROM cl GROUP BY 1 ORDER BY 1`);
    const rows4c = kd.map((r) => { const o = bySuc[r.suc] || {}; return { sucursal: nom(r.suc), kdue_saldo_pos_M: M(r.saldo_pos), vista_saldo_canonico_M: M(o.saldo_canonico || 0), delta_pesos: r2(r.saldo_pos - (o.saldo_canonico || 0)), kdue_neto_M: M(r.neto) }; });
    show(rows4c, '4c. Reconciliación: kdue directo (DISTINCT por documento, mismos doctypes) vs vista');
    const uni = await q(`WITH src AS (SELECT DISTINCT ON (btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6)) c29, c4::int t, c11, btrim(c1) c1
          FROM kepler_ods.kdue ORDER BY btrim(c1), c29, btrim(c4::text), btrim(c5::text), btrim(c6), c7)
        SELECT c29, t, count(*)::int n, round(sum(c11)/1e6,2)::float8 m, count(DISTINCT c1)::int almacenes FROM src GROUP BY 1,2 ORDER BY 1,2`);
    show(uni, '4d. universo crudo de kdue (documentos distintos): qué doctypes trae y cuáles entran a la cartera');
    const c28 = await q(`SELECT c28, count(*)::int n FROM kepler_ods.kdue GROUP BY 1`);
    console.log('  kdue.c28 (género):', JSON.stringify(c28));
    const snap = await q(`SELECT sucursal, snapshot_date::text, saldo_total::float8, vencido_total::float8, d0_30::float8, d31_60::float8, d61_90::float8, d90_plus::float8, computed_at::text
        FROM analytics.customer_receivable_snapshots WHERE tenant_id=$1 AND snapshot_date=(SELECT max(snapshot_date) FROM analytics.customer_receivable_snapshots WHERE tenant_id=$1) ORDER BY 1`, [MEGA]);
    show(snap.map((r) => ({ sucursal: nom(r.sucursal), fecha: r.snapshot_date, saldo_M: M(r.saldo_total), vencido_M: M(r.vencido_total), d0_30_M: M(r.d0_30), d90_M: M(r.d90_plus), calculado: r.computed_at.slice(0, 16) })), '4e. último snapshot del escáner (analytics.customer_receivable_snapshots), tercer testigo');
    const sr = await q(`SELECT min(snapshot_date)::text mn, max(snapshot_date)::text mx, count(DISTINCT snapshot_date)::int dias FROM analytics.customer_receivable_snapshots WHERE tenant_id=$1`, [MEGA]);
    console.log('  snapshots:', JSON.stringify(sr[0]));
    // 4f. La cartera de terceros que quedó en Oficinas: ¿esos clientes ya compran/pagan en una sucursal desde el 1-oct?
    const huer = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
        cr AS MATERIALIZED (SELECT sucursal, cliente_code, saldo_cliente, cargo_abono, fecha, saldo_ajustado FROM analytics.customer_receivables WHERE sucursal='00'),
        cli AS (SELECT r.cliente_code, max(r.saldo_cliente)::float8 saldo FROM cr r LEFT JOIN k ON k.cliente_code=btrim(r.cliente_code)
           WHERE ${CLASE_SQL('r.cliente_code', 'k.kind')}='cliente_final' GROUP BY 1 HAVING max(r.saldo_cliente) > 0.005),
        otros AS (SELECT btrim(c10) cli, count(*) FILTER (WHERE c3='A')::int cobros, coalesce(sum(c16) FILTER (WHERE c3='A'),0)::float8 m_cobros,
             count(*) FILTER (WHERE c3='D')::int ventas, coalesce(sum(c16) FILTER (WHERE c3='D'),0)::float8 m_ventas
           FROM kepler_ods.kdm1 WHERE c2='U' AND sucursal<>'00' AND btrim(c1)=sucursal AND btrim(coalesce(c43,''))<>'C' AND c9 >= '2026-10-01'
             AND ((c3='A' AND c4 IN (5,7)) OR (c3='D' AND c4 IN (8,12,13))) GROUP BY 1),
        c00 AS (SELECT btrim(c10) cli, max(c9)::date ult FROM kepler_ods.kdm1 WHERE c2='U' AND c3='A' AND c4 IN (5,7) AND sucursal='00' AND btrim(c1)='00' AND btrim(coalesce(c43,''))<>'C' GROUP BY 1)
        SELECT count(*)::int clientes, sum(saldo)::float8 saldo,
          count(*) FILTER (WHERE o.cobros > 0)::int con_cobro_en_sucursal_oct, coalesce(sum(saldo) FILTER (WHERE o.cobros > 0),0)::float8 saldo_de_esos, coalesce(sum(o.m_cobros),0)::float8 m_cobros_suc,
          count(*) FILTER (WHERE o.ventas > 0)::int con_venta_en_sucursal_oct, coalesce(sum(o.m_ventas),0)::float8 m_ventas_suc,
          count(*) FILTER (WHERE c00.ult >= '2026-10-01')::int con_cobro_en_00_oct, count(*) FILTER (WHERE c00.ult IS NULL)::int nunca_cobro_en_00
        FROM cli LEFT JOIN otros o ON o.cli=cli.cliente_code LEFT JOIN c00 ON c00.cli=cli.cliente_code`);
    show(huer.map((r) => ({ clientes: r.clientes, saldo_M: M(r.saldo), con_cobro_en_sucursal_desde_1oct: r.con_cobro_en_sucursal_oct, su_saldo_en_00_M: M(r.saldo_de_esos), cobrado_en_sucursal_oct_M: M(r.m_cobros_suc), con_venta_en_sucursal_oct: r.con_venta_en_sucursal_oct, vendido_en_sucursal_oct_M: M(r.m_ventas_suc), con_cobro_en_00_oct: r.con_cobro_en_00_oct, nunca_cobro_en_00: r.nunca_cobro_en_00 })),
      '4f. Clientes FINALES con saldo vivo en 00 Oficinas: ¿compran o pagan ya en otra sucursal (c10 = mismo código) desde el 1-oct?');
    const mesF = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
        cr AS MATERIALIZED (SELECT sucursal, cliente_code, doc_code, cargo_abono, fecha, saldo_ajustado FROM analytics.customer_receivables WHERE sucursal='00' AND cargo_abono='C')
        SELECT to_char(r.fecha,'YYYY-MM') mes, r.doc_code, count(*) FILTER (WHERE GREATEST(coalesce(r.saldo_ajustado,0),0) > 0.005)::int vivas, round(sum(GREATEST(coalesce(r.saldo_ajustado,0),0)),2)::float8 res
        FROM cr r LEFT JOIN k ON k.cliente_code=btrim(r.cliente_code) WHERE ${CLASE_SQL('r.cliente_code', 'k.kind')}='cliente_final'
        GROUP BY 1,2 HAVING sum(GREATEST(coalesce(r.saldo_ajustado,0),0)) > 1000 ORDER BY 1,2`);
    show(mesF.map((r) => ({ mes_factura: r.mes, doc: r.doc_code, partidas_vivas: r.vivas, saldo_M: M(r.res) })), '4g. saldo vivo de clientes finales en 00 por mes de la factura');
    const dest = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
        cr AS MATERIALIZED (SELECT cliente_code, saldo_cliente FROM analytics.customer_receivables WHERE sucursal='00'),
        cli AS (SELECT r.cliente_code FROM cr r LEFT JOIN k ON k.cliente_code=btrim(r.cliente_code) WHERE ${CLASE_SQL('r.cliente_code', 'k.kind')}='cliente_final' GROUP BY 1 HAVING max(r.saldo_cliente) > 0.005),
        cob AS (SELECT m.sucursal, btrim(m.c1) c1, m.c4 t, m.c5 s, btrim(m.c6) folio, m.c16 monto FROM kepler_ods.kdm1 m JOIN cli ON cli.cliente_code=btrim(m.c10)
           WHERE m.c2='U' AND m.c3='A' AND m.c4 IN (5,7) AND m.sucursal<>'00' AND btrim(m.c1)=m.sucursal AND btrim(coalesce(m.c43,''))<>'C' AND m.c9 >= '2026-10-01'),
        ap AS (SELECT btrim(a.c1) c1, a.c4 t, a.c5 s, btrim(a.c6) folio, 'U-'||btrim(a.c8)||'-'||a.c9::int dt, sum(a.c13) m, min(d.c9)::date fmin
           FROM analytics.kepler_kdm5_vigente a LEFT JOIN kepler_ods.kdm1 d ON d.sucursal=a.c1 AND d.c1=a.c1 AND d.c2='U' AND d.c3=a.c8 AND d.c4=a.c9 AND d.c5=a.c10 AND d.c6=a.c11
           WHERE a.c2='U' AND a.c3='A' AND a.c4 IN (5,7) AND btrim(a.c1)<>'00' GROUP BY 1,2,3,4,5)
        SELECT coalesce(ap.dt,'sin aplicación') dt, count(*)::int filas, coalesce(sum(ap.m), sum(cob.monto))::float8 monto, count(*) FILTER (WHERE ap.fmin < '2026-10-01')::int doc_anterior_1oct
        FROM cob LEFT JOIN ap ON ap.c1=cob.c1 AND ap.t=cob.t AND ap.s=cob.s AND ap.folio=cob.folio GROUP BY 1 ORDER BY 3 DESC`);
    show(dest.map((r) => ({ aplicado_a: r.dt, filas: r.filas, monto_M: M(r.monto), documento_anterior_al_1oct: r.doc_anterior_1oct })), '4h. ¿A qué se aplican los cobros en sucursal (desde 1-oct) de esos mismos clientes? (kdm5 vigente)');
    // 4i. ¿La U-D-13 a clientes finales de 00 (3-jul→30-sep) ESPEJA una venta de sucursal (U-D-8 o U-D-41) al mismo cliente?
    //     cruce por cliente + importe ±$1 + fecha ±3 días; PLACEBO: misma regla contra la fecha +35 días.
    const esp = await q(`WITH k AS MATERIALIZED (SELECT cliente_code, kind FROM analytics.v_customer_account_kind),
        f13 AS MATERIALIZED (SELECT btrim(m.c6) folio, btrim(m.c10) cli, m.c9::date f, m.c16::float8 monto FROM kepler_ods.kdm1 m LEFT JOIN k ON k.cliente_code=btrim(m.c10)
          WHERE m.c2='U' AND m.c3='D' AND m.c4=13 AND m.sucursal='00' AND btrim(m.c1)='00' AND btrim(coalesce(m.c43,''))<>'C' AND m.c9 >= '2026-07-03' AND m.c9 < '2026-10-01'
            AND ${CLASE_SQL('m.c10', 'k.kind')}='cliente_final'),
        sv AS MATERIALIZED (SELECT c4::int t, sucursal, btrim(c10) cli, c9::date f, c16::float8 monto FROM kepler_ods.kdm1
          WHERE c2='U' AND c3='D' AND c4 IN (8,41) AND btrim(c1)=sucursal AND btrim(coalesce(c43,''))<>'C' AND c9 >= '2026-06-01' AND c9 < '2026-12-01'
            AND btrim(c10) IN (SELECT cli FROM f13)),
        rd AS MATERIALIZED (SELECT sucursal, doc_code, folio, saldo_documento FROM analytics.erp_receivable_documents WHERE cargo_abono='C'),
        sd AS MATERIALIZED (SELECT folio, saldo_documento FROM rd WHERE sucursal='00' AND doc_code='UD1301'),
        x AS (SELECT f13.*, coalesce(sd.saldo_documento,0)::float8 saldo, EXISTS (SELECT 1 FROM sv WHERE sv.t=8 AND sv.cli=f13.cli AND abs(sv.monto-f13.monto)<=1 AND abs(sv.f-f13.f)<=3) es_espejo
          FROM f13 LEFT JOIN sd ON sd.folio=f13.folio)
        SELECT (SELECT sum(monto) FROM x WHERE es_espejo)::float8 monto_espejo, (SELECT sum(saldo) FROM x WHERE es_espejo)::float8 saldo_vivo_espejo,
          (SELECT sum(saldo) FROM x WHERE NOT es_espejo)::float8 saldo_vivo_no_espejo, (SELECT sum(saldo) FROM x)::float8 saldo_vivo_total,
          count(*)::int n, sum(monto)::float8 m,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sv WHERE sv.cli=f13.cli))::int cliente_en_sucursal,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sv WHERE sv.t=8 AND sv.cli=f13.cli AND abs(sv.monto-f13.monto)<=1 AND abs(sv.f-f13.f)<=3))::int espejo_u_d_8,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sv WHERE sv.t=8 AND sv.cli=f13.cli AND abs(sv.monto-f13.monto)<=1 AND abs(sv.f-(f13.f+35))<=3))::int placebo_u_d_8,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sv WHERE sv.t=41 AND sv.cli=f13.cli AND abs(sv.monto-f13.monto)<=1 AND abs(sv.f-f13.f)<=3))::int espejo_u_d_41,
          count(*) FILTER (WHERE EXISTS (SELECT 1 FROM sv WHERE sv.t=41 AND sv.cli=f13.cli AND abs(sv.monto-f13.monto)<=1 AND abs(sv.f-(f13.f+35))<=3))::int placebo_u_d_41
        FROM f13`);
    show(esp.map((r) => ({ U_D_13_cliente_final_00_jul_sep: r.n, monto_M: M(r.m), cliente_con_venta_en_sucursal: pct(r.cliente_en_sucursal, r.n), espejo_U_D_8: pct(r.espejo_u_d_8, r.n), placebo_U_D_8: pct(r.placebo_u_d_8, r.n), espejo_U_D_41: pct(r.espejo_u_d_41, r.n), placebo_U_D_41: pct(r.placebo_u_d_41, r.n),
      monto_espejo_U_D_8_M: M(r.monto_espejo), saldo_vivo_hoy_M: M(r.saldo_vivo_total), del_cual_espejo_M: M(r.saldo_vivo_espejo), no_espejo_M: M(r.saldo_vivo_no_espejo) })),
      '4i. ¿La U-D-13 de 00 a clientes finales (3-jul→30-sep) espeja una venta de sucursal? cliente + importe ±$1 + fecha ±3 d; placebo = fecha +35 d');
    OUT.m4 = { bySuc, byK, kd, uni, snap, huer, mesF, dest, esp };
  }

  // ── 5. Medio de cobro ──────────────────────────────────────────────────────────────────────
  if (on(5)) {
    const B = `SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, btrim(c2) nombre,
        CASE WHEN btrim(coalesce(c5,'')) NOT LIKE '102%' THEN 'puente' WHEN upper(btrim(coalesce(c3,'')))='EFECTIVO' THEN 'caja' ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>'' ORDER BY btrim(c1), sucursal`;
    const m = await q(`WITH b AS (${B})
        SELECT m.c4::int t, m.c5::int s, CASE WHEN m.sucursal='00' THEN '00' ELSE 'resto' END z,
          CASE WHEN btrim(m.c1)=m.sucursal THEN 'propio' ELSE 'ruta' END origen,
          CASE WHEN btrim(coalesce(m.c45,''))='' THEN 'sin_declarar' ELSE coalesce(b.tipo,'no_resuelve') END medio,
          count(*)::int n, sum(m.c16)::float8 monto
        FROM kepler_ods.kdm1 m LEFT JOIN b ON b.clave=btrim(m.c45)
        WHERE m.c2='U' AND m.c3='A' AND m.c4 IN (5,7) AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(coalesce(m.c43,''))<>'C'
          AND (btrim(m.c1)=m.sucursal OR btrim(m.c1) LIKE m.sucursal||'-%')
        GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5`, [W0, W1]);
    const T = m.reduce((s, r) => ({ n: s.n + r.n, m: s.m + r.monto }), { n: 0, m: 0 });
    show(m.map((r) => ({ doctype: `U-A-${r.t}-${r.s}`, zona: r.z, origen: r.origen, medio: r.medio, docs: r.n, monto_M: M(r.monto), pct_monto_total: pct(r.monto, T.m) })), `5. Medio de cobro (c45 → kdb1: c3 EFECTIVO = caja; c5 102% = banco; si no, puente), c9 ${W0}..${W1}, sin cancelados — Σ ${T.n} docs $${M(T.m)}M`);
    const pm = {}; for (const r of m) { const k = `U-A-${r.t}|${r.medio}`; const o = pm[k] ??= { n: 0, m: 0 }; o.n += r.n; o.m += r.monto; }
    const pt = {}; for (const r of m) { const o = pt[`U-A-${r.t}`] ??= { n: 0, m: 0 }; o.n += r.n; o.m += r.monto; }
    show(Object.entries(pm).sort().map(([k, o]) => { const [dt, medio] = k.split('|'); return { doctype: dt, medio, docs: o.n, pct_docs: pct(o.n, pt[dt].n), monto_M: M(o.m), pct_monto: pct(o.m, pt[dt].m) }; }), '5b. resumen por doctype y medio (control Σ = 5)');
    const top = await q(`WITH b AS (${B})
        SELECT m.c4::int t, btrim(m.c45) c45, max(b.nombre) nombre, max(b.tipo) tipo, count(*)::int n, sum(m.c16)::float8 monto
        FROM kepler_ods.kdm1 m LEFT JOIN b ON b.clave=btrim(m.c45)
        WHERE m.c2='U' AND m.c3='A' AND m.c4 IN (5,7) AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(coalesce(m.c43,''))<>'C' AND (btrim(m.c1)=m.sucursal OR btrim(m.c1) LIKE m.sucursal||'-%')
        GROUP BY 1,2 ORDER BY 6 DESC LIMIT 12`, [W0, W1]);
    show(top.map((r) => ({ doctype: `U-A-${r.t}`, cuenta: r.c45, nombre: r.nombre, tipo: r.tipo, docs: r.n, monto_M: M(r.monto) })), '5c. top cuentas c45');
    const amb = await q(`SELECT btrim(c1) clave, count(DISTINCT (btrim(coalesce(c2,'')), btrim(coalesce(c3,'')), btrim(coalesce(c5,''))))::int variantes, count(DISTINCT sucursal)::int sucs
        FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>'' GROUP BY 1 HAVING count(DISTINCT (btrim(coalesce(c2,'')), btrim(coalesce(c3,'')), btrim(coalesce(c5,'')))) > 1`);
    console.log(`  kdb1: claves con más de una definición entre sucursales: ${amb.length} ${JSON.stringify(amb.slice(0, 6))}`);
    const nr = await q(`WITH b AS (${B}) SELECT m.sucursal suc, btrim(m.c45) c45, count(*)::int n, sum(m.c16)::float8 monto
        FROM kepler_ods.kdm1 m LEFT JOIN b ON b.clave=btrim(m.c45)
        WHERE m.c2='U' AND m.c3='A' AND m.c4 IN (5,7) AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(coalesce(m.c43,''))<>'C' AND btrim(coalesce(m.c45,''))<>'' AND b.clave IS NULL
        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`, [W0, W1]);
    show(nr.map((r) => ({ sucursal: nom(r.suc), c45: r.c45, docs: r.n, monto_M: M(r.monto) })), '5c2. c45 que NO resuelve en kdb1');
    const kb = await q(`SELECT sucursal, btrim(c1) c1, btrim(c2) c2, btrim(c3) c3, btrim(c5) c5 FROM kepler_ods.kdb1 WHERE btrim(c1) IN (SELECT btrim(c45) FROM kepler_ods.kdm1 WHERE c2='U' AND c3='A' AND c4=7 AND c9 >= '2026-10-01' GROUP BY 1) ORDER BY 2,1 LIMIT 12`);
    show(kb, '5c3. kdb1 de las cuentas usadas por U-A-7 (octubre)');
    // 5d. U-A-7: medio por c45 vs forma de pago SAT del complemento (dos fuentes)
    const cp = await q(`WITH b AS (${B})
        SELECT CASE WHEN btrim(coalesce(m.c45,''))='' THEN 'sin_declarar' ELSE coalesce(b.tipo,'no_resuelve') END medio, coalesce(c.forma_pago_sat,'sin complemento') forma,
          count(*)::int n, sum(m.c16)::float8 monto
        FROM kepler_ods.kdm1 m LEFT JOIN b ON b.clave=btrim(m.c45)
          LEFT JOIN LATERAL (SELECT forma_pago_sat FROM analytics.v_kepler_payment_complement c WHERE c.sucursal=btrim(m.sucursal) AND c.folio=btrim(m.c6) AND c.serie='UA0701' LIMIT 1) c ON true
        WHERE m.c2='U' AND m.c3='A' AND m.c4=7 AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(coalesce(m.c43,''))<>'C' AND btrim(m.c1)=m.sucursal
        GROUP BY 1,2 ORDER BY 1,2`, [W0, W1]);
    show(cp.map((r) => ({ medio_c45: r.medio, forma_pago_SAT: r.forma, docs: r.n, monto_M: M(r.monto) })), '5d. U-A-7: medio por c45 contra forma de pago del complemento CFDI (01 efectivo, 02 cheque, 03 transferencia)');
    OUT.m5 = { m, top, amb, cp };
  }

  // ── 6. Ruta directa: cortes U-D-23 → cobro ─────────────────────────────────────────────────
  if (on(6)) {
    const cortes = docs.filter((d) => d.nat === 'D' && d.t === 23 && inW(d.f) && origen(d.suc, d.c1) !== 'replica');
    const rc = await q(`SELECT truck, almacen, cobro_folio, fecha::text f, cuenta, doc_tipo, folio_corte, importe::float8 imp, referencia FROM analytics.route_collections`);
    console.log(`6. cortes U-D-23 en kdm1 (ventana, propio+ruta): ${cortes.length}; primer corte en kdm1: ${docs.filter((d) => d.nat === 'D' && d.t === 23).map((d) => d.f).sort()[0]} · route_collections ${rc.length} filas`);
    const apps23 = new Map();
    let colision = 0, cobroEnC1 = 0, cobroEnRuta = 0, napp = 0;
    const rutaFolios = new Set(cortes.filter((d) => d.c1 !== d.suc).map((d) => `${d.suc}|${d.folio}`));
    const cobRutaFolios = new Set(docs.filter((d) => d.nat === 'A' && d.t === 5 && d.c1 !== d.suc && d.c1.startsWith(d.suc + '-')).map((d) => `${d.suc}|${d.folio}`));
    for (const a of kdm5) {
      if (a.d_t !== 23) continue; napp += 1;
      if (rutaFolios.has(`${a.c1}|${a.d_folio}`)) colision += 1;
      if (idxA.get(key(a.c1, 'A', a.a_t, a.a_s, a.a_folio))) cobroEnC1 += 1;
      if (cobRutaFolios.has(`${a.c1}|${a.a_folio}`)) cobroEnRuta += 1;
      const cb = idxA.get(key(a.c1, 'A', a.a_t, a.a_s, a.a_folio)); if (cb && cb.est === 'C') continue;
      const k = key(a.c1, 'D', 23, a.d_s, a.d_folio); (apps23.get(k) ?? apps23.set(k, []).get(k)).push({ ...a, cobro: cb });
    }
    console.log(`  kdm5 → U-D-23: ${napp} aplicaciones; cobro presente en kdm1 con el mismo c1: ${pct(cobroEnC1, napp)}; folio de corte que TAMBIÉN existe como corte de ruta (colisión posible): ${colision}; folio de cobro que también existe como cobro de ruta: ${cobroEnRuta}`);
    const rcBy = new Map(); for (const r of rc) { const k = `${r.almacen}|${r.folio_corte}`; (rcBy.get(k) ?? rcBy.set(k, []).get(k)).push(r); }
    const t6 = [];
    for (const grupo of ['tienda (c1 = sucursal)', 'camioneta (c1 compuesto)']) {
      const bySuc = {};
      for (const d of cortes) {
        const esRuta = d.c1 !== d.suc; if ((grupo.startsWith('camioneta')) !== esRuta) continue;
        const o = bySuc[d.suc] ??= { cortes: 0, monto: 0, con_cobro: 0, saldado: 0, m_cob: 0, d1: [], du: [], pl_n: 0, pl_ok: 0, ok: 0, cancel: 0 };
        if (d.est === 'C') { o.cancel += 1; continue; }
        o.cortes += 1; o.monto += d.monto;
        let ls, fechas, tot;
        if (!esRuta) {
          ls = apps23.get(key(d.c1, 'D', 23, d.s, d.folio)) || [];
          tot = ls.reduce((s, a) => s + a.m13, 0); fechas = ls.map((a) => a.cobro ? day(a.cobro.f) : null).filter((x) => x !== null);
          const pl = idx.get(key(d.c1, 'D', 23, d.s, placeboFolio(d.folio)));
          if (ls.length && pl && pl.est !== 'C') { o.pl_n += 1; if (Math.abs(tot - pl.monto) <= 1) o.pl_ok += 1; }
        } else {
          ls = rcBy.get(`${d.c1}|${d.folio}`) || [];
          tot = ls.reduce((s, r) => s + r.imp, 0); fechas = ls.map((r) => day(r.f));
          const pl = idx.get(key(d.c1, 'D', 23, d.s, placeboFolio(d.folio)));
          if (ls.length && pl && pl.est !== 'C') { o.pl_n += 1; if (Math.abs(tot - pl.monto) <= 1) o.pl_ok += 1; }
        }
        if (!ls.length) continue;
        o.con_cobro += 1; o.m_cob += Math.min(tot, d.monto);
        if (Math.abs(tot - d.monto) <= 1) o.ok += 1;
        if (tot >= d.monto - 1) { o.saldado += 1; if (fechas.length) o.du.push(Math.max(...fechas) - day(d.f)); }
        if (fechas.length) o.d1.push(Math.min(...fechas) - day(d.f));
      }
      for (const [s, o] of Object.entries(bySuc).sort()) t6.push({ tipo: grupo, sucursal: nom(s), cortes: o.cortes, monto_M: M(o.monto), cancel_excl: o.cancel, con_cobro: pct(o.con_cobro, o.cortes), saldados: pct(o.saldado, o.cortes), pct_monto_cobrado: pct(o.m_cob, o.monto),
        cobro_igual_corte_1peso: pct(o.ok, o.con_cobro), placebo_f1_igual: `${pct(o.pl_ok, o.pl_n)} de ${o.pl_n}`, dias_corte_a_1er_cobro_med: quant(o.d1, 0.5), dias_a_ultimo_med: quant(o.du, 0.5), dias_a_ultimo_p90: quant(o.du, 0.9) });
    }
    show(t6, `6. Cortes U-D-23 (c9 ${W0}..${W1}; en kdm1 existen desde 2026-09-30) → cobro. Tienda: kdm5 U-A-5→D-23; camioneta: analytics.route_collections (almacén+folio_corte)`);
    const ct = t6.reduce((s, r) => s + r.cortes, 0); const cr = cortes.filter((d) => d.est !== 'C').length;
    console.log(`  control Σ cortes ${ct} = ${cr} ${ct === cr ? 'OK' : 'FALLA'}`);
    // route_collections cuyo almacén no tiene U-D-23 en el ODS (Canindo 06-00N, etc.)
    const alm = {}; const cortesK = new Set(docs.filter((d) => d.nat === 'D' && d.t === 23).map((d) => `${d.c1}|${d.folio}`));
    const cobK = new Set(docs.filter((d) => d.nat === 'A' && d.t === 5).map((d) => `${d.c1}|${d.folio}`));
    for (const r of rc) { const o = alm[r.almacen] ??= { filas: 0, imp: 0, corte_en_kdm1: 0, cobro_en_kdm1: 0 }; o.filas += 1; o.imp += r.imp; if (cortesK.has(`${r.almacen}|${r.folio_corte}`)) o.corte_en_kdm1 += 1; if (cobK.has(`${r.almacen}|${r.cobro_folio}`)) o.cobro_en_kdm1 += 1; }
    show(Object.entries(alm).sort().map(([k, o]) => ({ almacen: k, filas: o.filas, importe_M: M(o.imp), corte_en_kdm1: pct(o.corte_en_kdm1, o.filas), cobro_U_A_5_en_kdm1: pct(o.cobro_en_kdm1, o.filas) })), '6b. analytics.route_collections por almacén (¿el corte y el cobro están en kdm1?)');
    // ruta directa ene–sep: U-D-13 a clientes de ruta
    OUT.m6 = { t6, alm };
  }

  // ── 7. Mostrador: tickets U-D-10 y arqueos ────────────────────────────────────────────────
  if (on(7)) {
    const tk = await q(`SELECT sucursal suc,
          CASE WHEN btrim(c1)=sucursal THEN 'propio' WHEN btrim(c1) LIKE sucursal||'-%' THEN 'ruta' ELSE 'replica' END origen,
          count(*) FILTER (WHERE btrim(coalesce(c43,''))<>'C')::int docs, count(*) FILTER (WHERE btrim(coalesce(c43,''))='C')::int cancel,
          coalesce(sum(c16) FILTER (WHERE btrim(coalesce(c43,''))<>'C'),0)::float8 monto,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY c16) FILTER (WHERE btrim(coalesce(c43,''))<>'C')::float8 ticket_med,
          count(DISTINCT c9::date)::int dias, count(DISTINCT c5)::int cajas, count(*) FILTER (WHERE btrim(coalesce(c45,''))<>'')::int con_c45,
          min(c9)::date::text desde, max(c9)::date::text hasta
        FROM kepler_ods.kdm1 WHERE c2='U' AND c3='D' AND c4=10 AND c9::date BETWEEN $1::date AND $2::date GROUP BY 1,2 ORDER BY 1,2`, [W0, W1]);
    console.log(`7. tickets agregados en SQL (${tk.ms} ms)`);
    const tT = tk.filter((r) => r.origen !== 'replica').reduce((s, r) => ({ n: s.n + r.docs, m: s.m + r.monto }), { n: 0, m: 0 });
    show(tk.map((r) => ({ sucursal: nom(r.suc), origen: r.origen, tickets: r.docs, monto_M: M(r.monto), ticket_mediano: r2(r.ticket_med ?? 0), dias: r.dias, desde: r.desde, hasta: r.hasta, cajas: r.cajas, cancel_excl: r.cancel, con_c45: r.con_c45 })), `7a. Tickets U-D-10, c9 ${W0}..${W1} (agregado en el servidor) — Σ propio+ruta ${tT.n} tickets $${M(tT.m)}M`);
    const cc = await q(`SELECT warehouse_code suc, count(*)::int cortes, count(DISTINCT (caja, folio, business_date))::int llaves,
          sum(efectivo_esperado)::float8 esp, sum(efectivo_contado)::float8 cont, sum(efectivo_diff)::float8 dif, sum(abs(efectivo_diff))::float8 absdif,
          count(*) FILTER (WHERE abs(efectivo_diff) >= 50)::int n50, sum(efectivo_diff) FILTER (WHERE efectivo_diff >= 50)::float8 faltante50,
          sum(efectivo_diff) FILTER (WHERE efectivo_diff <= -50)::float8 sobrante50,
          sum(venta_total)::float8 venta, sum(tarjeta_esperado)::float8 tarj, sum(transfer_esperado)::float8 transf,
          count(*) FILTER (WHERE abs(coalesce(efectivo_diff,0) - (coalesce(efectivo_esperado,0)-coalesce(efectivo_contado,0))) > 0.01)::int dif_incoherente,
          count(*) FILTER (WHERE coalesce(efectivo_contado,0)=0 AND coalesce(efectivo_esperado,0)>0)::int contado_cero,
          coalesce(sum(efectivo_esperado) FILTER (WHERE coalesce(efectivo_contado,0)=0 AND coalesce(efectivo_esperado,0)>0),0)::float8 esperado_en_cero,
          coalesce(sum(efectivo_diff) FILTER (WHERE NOT (coalesce(efectivo_contado,0)=0 AND coalesce(efectivo_esperado,0)>0)),0)::float8 dif_sin_cero,
          count(*) FILTER (WHERE abs(efectivo_diff) >= 50 AND NOT (coalesce(efectivo_contado,0)=0 AND coalesce(efectivo_esperado,0)>0))::int n50_sin_cero,
          count(*) - count(DISTINCT (caja, folio, business_date)) duplicados,
          count(*) FILTER (WHERE NOT cerrado)::int abiertos, count(DISTINCT warehouse_name)::int nombres
        FROM analytics.cash_cuts WHERE tenant_id=$1 AND business_date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`, [MEGA, W0, W1]);
    const tkS = {}; for (const r of tk) if (r.origen !== 'replica') tkS[r.suc] = (tkS[r.suc] || 0) + r.monto;
    const C = cc.reduce((s, r) => ({ n: s.n + r.cortes, ll: s.ll + r.llaves, esp: s.esp + r.esp, cont: s.cont + r.cont, dif: s.dif + r.dif, abs: s.abs + r.absdif, n50: s.n50 + r.n50, f50: s.f50 + (r.faltante50 ?? 0), s50: s.s50 + (r.sobrante50 ?? 0), venta: s.venta + r.venta, cero: s.cero + r.contado_cero, inc: s.inc + r.dif_incoherente }),
      { n: 0, ll: 0, esp: 0, cont: 0, dif: 0, abs: 0, n50: 0, f50: 0, s50: 0, venta: 0, cero: 0, inc: 0 });
    // tickets sólo de las sucursales con arqueo, para que la razón compare lo mismo
    const tkConArq = cc.reduce((s, r) => s + (tkS[r.suc] || 0), 0);
    const Z = cc.reduce((s, r) => ({ cero: s.cero + r.contado_cero, esp0: s.esp0 + r.esperado_en_cero, dif: s.dif + r.dif_sin_cero, n50: s.n50 + r.n50_sin_cero, n: s.n + r.cortes - r.contado_cero }), { cero: 0, esp0: 0, dif: 0, n50: 0, n: 0 });
    show(cc.map((r) => ({ sucursal: nom(r.suc), cortes_contado_cero: r.contado_cero, esperado_en_esos: r2(r.esperado_en_cero), diferencia_sin_ellos: r2(r.dif_sin_cero), pct_dif_50_sin_ellos: pct(r.n50_sin_cero, r.cortes - r.contado_cero), filas_duplicadas: r.duplicados })).concat([{ sucursal: 'TOTAL', cortes_contado_cero: Z.cero, esperado_en_esos: r2(Z.esp0), diferencia_sin_ellos: r2(Z.dif), pct_dif_50_sin_ellos: pct(Z.n50, Z.n), filas_duplicadas: cc.reduce((s, r) => s + Number(r.duplicados), 0) }]),
      '7b2. «Contado en cero» separado (no se distingue de «nadie capturó»): la diferencia sin esos cortes');
    show([...cc.map((r) => ({ sucursal: nom(r.suc), cortes: r.cortes, llaves_unicas: r.llaves, efectivo_esperado_M: M(r.esp), efectivo_contado_M: M(r.cont), diferencia_pesos: r2(r.dif), abs_dif_pesos: r2(r.absdif), pct_cortes_dif_50: pct(r.n50, r.cortes),
      faltante_50: r2(r.faltante50 ?? 0), sobrante_50: r2(r.sobrante50 ?? 0), venta_total_arqueo_M: M(r.venta), tickets_U_D_10_M: M(tkS[r.suc] || 0), arqueo_sobre_tickets: pct(r.venta, tkS[r.suc] || 0), contado_cero: r.contado_cero, dif_incoherente: r.dif_incoherente, nombres_almacen: r.nombres })),
    { sucursal: 'TOTAL', cortes: C.n, llaves_unicas: C.ll, efectivo_esperado_M: M(C.esp), efectivo_contado_M: M(C.cont), diferencia_pesos: r2(C.dif), abs_dif_pesos: r2(C.abs), pct_cortes_dif_50: pct(C.n50, C.n), faltante_50: r2(C.f50), sobrante_50: r2(C.s50),
      venta_total_arqueo_M: M(C.venta), tickets_U_D_10_M: M(tkConArq), arqueo_sobre_tickets: pct(C.venta, tkConArq), contado_cero: C.cero, dif_incoherente: C.inc, nombres_almacen: '' }],
    `7b. Arqueos analytics.cash_cuts, business_date ${W0}..${W1} (diferencia = esperado − contado; >0 faltó)`);
    const mes = await q(`WITH t AS (SELECT sucursal suc, to_char(c9,'YYYY-MM') mes, sum(c16)::float8 m FROM kepler_ods.kdm1
          WHERE c2='U' AND c3='D' AND c4=10 AND c9::date BETWEEN $2::date AND $3::date AND (btrim(c1)=sucursal OR btrim(c1) LIKE sucursal||'-%') AND btrim(coalesce(c43,''))<>'C' GROUP BY 1,2),
        a AS (SELECT warehouse_code suc, to_char(business_date,'YYYY-MM') mes, sum(venta_total)::float8 m, count(*)::int n FROM analytics.cash_cuts WHERE tenant_id=$1 AND business_date BETWEEN $2::date AND $3::date GROUP BY 1,2)
        SELECT coalesce(t.suc,a.suc) suc, coalesce(t.mes,a.mes) mes, coalesce(t.m,0) tk, coalesce(a.m,0) arq, coalesce(a.n,0) cortes FROM t FULL JOIN a ON a.suc=t.suc AND a.mes=t.mes ORDER BY 1,2`, [MEGA, W0, W1]);
    const MESES = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];
    const mm = {};
    for (const r of mes) {
      const row = mm[r.suc] ??= Object.fromEntries([['sucursal', nom(r.suc)], ...MESES.map((x) => [`m${x}`, '—'])]);
      row[`m${r.mes.slice(5)}`] = r.tk ? (r.arq / r.tk * 100).toFixed(0) + '%' : (r.arq ? 'arqueo sin tickets' : '—');
    }
    show(Object.values(mm), '7c. arqueo (venta_total) ÷ tickets U-D-10 por mes (m01..m10; «—» = ni tickets ni arqueo en kdm1/cash_cuts ese mes)');
    OUT.m7 = { tk, cc, mes };
  }

  // ── 8. Suite: cobro, depósito y conciliación ──────────────────────────────────────────────
  if (on(8)) {
    const sz = await q(`SELECT n.nspname||'.'||c.relname t, pg_relation_size(c.oid)::bigint bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname, c.relname) IN (('finance','collection_deposits'),('finance','collection_promises'),('finance','cash_ledger_cut_vouchers'),('finance','cash_ledger_cuts'),('commercial','collection_guides'))`);
    show(sz, '8.0 tamaño en disco (no sujeto a RLS): distingue «vacía» de «RLS me la esconde»');
    const t8 = await q(`
        SELECT 'finance.collection_deposits (comprobantes de cobranza, Fase CC)' t, count(*)::int n, min(cobro_date)::text desde, max(cobro_date)::text hasta, round(coalesce(sum(cobro_monto),0)/1e6,3)::float8 monto_M FROM finance.collection_deposits WHERE tenant_id=$1
        UNION ALL SELECT 'finance.collection_promises (promesas de pago)', count(*), min(fecha_promesa)::text, max(fecha_promesa)::text, round(coalesce(sum(monto_prometido),0)/1e6,3) FROM finance.collection_promises WHERE tenant_id=$1
        UNION ALL SELECT 'commercial.collection_guides (guías de cobranza)', count(*), min(created_at)::date::text, max(created_at)::date::text, round(coalesce(sum(total),0)/1e6,3) FROM commercial.collection_guides WHERE tenant_id=$1
        UNION ALL SELECT 'finance.cash_ledger ingresos (Caja General) todos', count(*), min(fecha)::text, max(fecha)::text, round(coalesce(sum(monto),0)/1e6,3) FROM finance.cash_ledger WHERE tenant_id=$1 AND tipo='ingreso' AND deleted_at IS NULL AND estado<>'cancelado'
        UNION ALL SELECT 'finance.cash_ledger ingresos anclados a cobro (origen_tipo=cobro)', count(*), min(fecha)::text, max(fecha)::text, round(coalesce(sum(monto),0)/1e6,3) FROM finance.cash_ledger WHERE tenant_id=$1 AND tipo='ingreso' AND origen_tipo='cobro' AND deleted_at IS NULL AND estado<>'cancelado'
        UNION ALL SELECT 'finance.cash_ledger_cuts (corte de Caja General)', count(*), min(created_at)::date::text, max(created_at)::date::text, NULL FROM finance.cash_ledger_cuts WHERE tenant_id=$1
        UNION ALL SELECT 'finance.caos_ingreso_atribucion (CAOS)', count(*), min(cobro_fecha)::text, max(cobro_fecha)::text, round(coalesce(sum(monto),0)/1e6,3) FROM finance.caos_ingreso_atribucion WHERE tenant_id=$1 AND deleted_at IS NULL
        UNION ALL SELECT 'finance.caos_deposito_grano (CAOS)', count(*), min(business_date)::text, max(business_date)::text, round(coalesce(sum(monto),0)/1e6,3) FROM finance.caos_deposito_grano WHERE tenant_id=$1 AND deleted_at IS NULL
        UNION ALL SELECT 'analytics.caja_depositos 2026 (depósitos Wincaja)', count(*), min(deposito_date)::text, max(deposito_date)::text, round(coalesce(sum(total_deposito),0)/1e6,3) FROM analytics.caja_depositos WHERE deposito_date >= '2026-01-01' AND NOT coalesce(eliminado,false)
        UNION ALL SELECT 'analytics.cash_sessions 2026 (sesiones de caja)', count(*), min(business_date)::text, max(business_date)::text, NULL FROM analytics.cash_sessions WHERE tenant_id=$1 AND business_date >= '2026-01-01'
        UNION ALL SELECT 'finance.bank_movements (estados de cuenta) abonos', count(*), min(movement_date)::text, max(movement_date)::text, round(coalesce(sum(amount_in),0)/1e6,3) FROM finance.bank_movements WHERE tenant_id=$1 AND deleted_at IS NULL AND coalesce(amount_in,0)>0
        UNION ALL SELECT 'finance.bank_recon_matches U-A-5/U-A-7', count(*), min(created_at)::date::text, max(created_at)::date::text, round(coalesce(sum(kepler_amount),0)/1e6,3) FROM finance.bank_recon_matches WHERE tenant_id=$1 AND kepler_doc_tipo IN ('U-A-5','U-A-7')`, [MEGA]);
    show(t8, '8a. Tablas de la Suite del lado cobro/depósito/conciliación');
    const bm = await q(`SELECT to_char(movement_date,'YYYY-MM') mes, count(*) FILTER (WHERE coalesce(amount_in,0)>0)::int abonos, count(DISTINCT bank_account_id)::int cuentas
        FROM finance.bank_movements WHERE tenant_id=$1 AND deleted_at IS NULL AND movement_date >= '2025-12-01' GROUP BY 1 ORDER BY 1`, [MEGA]);
    show(bm, '8b. cobertura de estados de cuenta cargados (finance.bank_movements) por mes');
    // 8c. cobros 2026 conciliados con banco: llave tipo + folio + cuenta (c45 = kepler_cuenta) [+ sucursal cuando el match la trae]; placebo folio+1
    const B = `SELECT DISTINCT ON (btrim(c1)) btrim(c1) clave, CASE WHEN btrim(coalesce(c5,'')) NOT LIKE '102%' THEN 'puente' WHEN upper(btrim(coalesce(c3,'')))='EFECTIVO' THEN 'caja' ELSE 'banco' END tipo
      FROM kepler_ods.kdb1 WHERE btrim(coalesce(c1,''))<>'' ORDER BY btrim(c1), sucursal`;
    const cobros = await q(`WITH b AS (${B})
        SELECT m.sucursal suc, 'U-A-'||m.c4::int tipo, btrim(m.c6) folio, btrim(m.c45) c45, m.c16::float8 monto, to_char(m.c9,'YYYY-MM') mes, coalesce(b.tipo,'?') medio
          FROM kepler_ods.kdm1 m LEFT JOIN b ON b.clave=btrim(m.c45)
          WHERE m.c2='U' AND m.c3='A' AND m.c4 IN (5,7) AND m.c9 >= $1::date AND m.c9 < $2::date + 1 AND btrim(coalesce(m.c43,''))<>'C' AND (btrim(m.c1)=m.sucursal OR btrim(m.c1) LIKE m.sucursal||'-%')`, [W0, W1]);
    const brm = await q(`SELECT kepler_doc_tipo tipo, btrim(kepler_doc_folio) folio, btrim(kepler_cuenta) cta, nullif(btrim(kepler_sucursal),'') suc, kepler_amount::float8 amt
        FROM finance.bank_recon_matches WHERE tenant_id=$1 AND kepler_doc_tipo IN ('U-A-5','U-A-7')`, [MEGA]);
    const R = new Map(); for (const r of brm) { const k = `${r.tipo}|${r.folio}|${r.cta}`; (R.get(k) ?? R.set(k, []).get(k)).push(r); }
    const hit = (c, folio, conMonto) => (R.get(`${c.tipo}|${folio}|${c.c45}`) || []).some((r) => (!r.suc || r.suc === c.suc) && (!conMonto || Math.abs(r.amt - c.monto) <= 0.01));
    const agg = {};
    for (const c of cobros) {
      const k = `${c.tipo}|${c.medio}`; const o = agg[k] ??= { cobros: 0, monto: 0, conc: 0, mconc: 0, igual: 0, pl: 0, plI: 0, porMes: {} };
      o.cobros += 1; o.monto += c.monto; const pm = o.porMes[c.mes] ??= [0, 0]; pm[1] += 1;
      if (hit(c, c.folio, false)) { o.conc += 1; o.mconc += c.monto; pm[0] += 1; if (hit(c, c.folio, true)) o.igual += 1; }
      if (/^\d+$/.test(c.folio)) { const pf = placeboFolio(c.folio); if (hit(c, pf, false)) { o.pl += 1; if (hit(c, pf, true)) o.plI += 1; } }
    }
    show(Object.entries(agg).sort().map(([k, o]) => { const [tipo, medio] = k.split('|'); return { tipo, medio, cobros: o.cobros, monto_M: M(o.monto), conciliados: `${o.conc} (${pct(o.conc, o.cobros)})`, pct_monto_conc: pct(o.mconc, o.monto), match_con_monto_igual: pct(o.igual, o.conc), placebo_f1_existe: o.pl, placebo_f1_monto_igual: `${pct(o.plI, o.pl)} de ${o.pl}`,
      por_mes: Object.entries(o.porMes).sort().map(([m, [a, b]]) => `${m.slice(5)}:${pct(a, b)}`).join(' ') }; }),
      `8c. Cobros 2026 (c9 ${W0}..${W1}) con match en finance.bank_recon_matches (tipo+folio+cuenta c45[+sucursal]) — placebo: folio+1; control Σ cobros ${Object.values(agg).reduce((s, o) => s + o.cobros, 0)} = ${cobros.length}`);
    const todos = await q(`SELECT 'U-A-'||c4::int tipo, btrim(c6) folio, btrim(coalesce(c45,'')) c45, btrim(coalesce(c43,'')) est, c9::date::text f FROM kepler_ods.kdm1 WHERE c2='U' AND c3='A' AND c4 IN (5,7)`);
    const K = new Map(); for (const d of todos) { const k = `${d.tipo}|${d.folio}|${d.c45}`; (K.get(k) ?? K.set(k, []).get(k)).push(d); }
    const inv = {};
    for (const [k] of R) { const tipo = k.split('|')[0]; const o = inv[tipo] ??= { docs_match: 0, en_kdm1: 0, cancelado: 0, fuera_2026: 0 }; o.docs_match += 1; const ls = K.get(k); if (!ls) continue; o.en_kdm1 += 1; if (ls.every((d) => d.est === 'C')) o.cancelado += 1; if (ls.every((d) => d.f < W0)) o.fuera_2026 += 1; }
    const brmSinCobro = Object.entries(inv).map(([tipo, o]) => ({ tipo, ...o }));
    show(brmSinCobro, '8d. control inverso: los documentos (tipo+folio+cuenta) de bank_recon_matches existen en kdm1');
    const kbm = await q(`SELECT count(*)::int n FROM analytics.kepler_bank_movements`).catch((e) => [{ n: `ERROR ${e.message}` }]);
    console.log(`  analytics.kepler_bank_movements filas: ${kbm[0].n} (${kbm.ms ?? '?'} ms)`);
    OUT.m8 = { t8, bm, agg, brmSinCobro };
  }

  if (JSON_OUT) { fs.writeFileSync(JSON_OUT, JSON.stringify({ ventana: { W0, W1, P1 }, ...OUT }, null, 1)); console.log('JSON en ' + JSON_OUT); }
});
