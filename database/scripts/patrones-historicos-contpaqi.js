#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.67]` — **Patrones del histórico para los huecos del expediente `[CP.8.65]`.** Cada predicción usa SÓLO
 * lo anterior a la póliza que se califica (2025 completo + 2026 previo); se califica en 2026 contra la contadora.
 *
 * Medido 2026-10-21 (historia mínima 3, pureza 90 %):
 *   cuenta del proveedor: la ya usada con ese RFC acierta 5,549/5,563 (99.7 %) vs mapa 98.4 %; cubre 56 de 67
 *     sin mapa con 0 errores y corrige 76 de 91 errores del mapa → se usa primero el histórico.
 *   nota descuento/devolución: el histórico NO mejora la regla «relación 03» (90.3 % vs 91.6 %).
 *   2120 vs directa: ningún proveedor se desvía consistente; la señal real es «¿la factura está en la provisión
 *     del mes?» (ver `doble-registro-provision-contpaqi.js`).
 *   factura mixta 0 %/16 %: la regla (partir por base) acierta 98/102; el histórico no cambia nada.
 *
 *   CONTPAQI_SQL_PASSWORD=… node database/scripts/patrones-historicos-contpaqi.js
 *
 * Sólo lectura en las dos bases.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const sql = require('mssql');
const { Client } = require('pg');
const SRC = (database) => {
  // Sin contraseña por defecto en el código: el repo es público.
  if (!process.env.CONTPAQI_SQL_PASSWORD) throw new Error('falta CONTPAQI_SQL_PASSWORD (usuario de sólo lectura del ADD)');
  return { server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35', user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
    password: process.env.CONTPAQI_SQL_PASSWORD, database,
    options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
    connectionTimeout: 20000, requestTimeout: 300000 };
};
const RFC = 'LOGL851014AQ5'; const MEGA = '00000000-0000-0000-0000-00000000d01c';
const U = (s) => String(s || '').trim().toUpperCase(); const ym = (s) => String(s).slice(0, 7);
const MIN_N = Number(process.env.MIN_N || 3); const PUREZA = Number(process.env.PUREZA || 0.9);
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); await c.query('SET default_transaction_read_only = on');
  // Renglones con UUID de pólizas de egreso 2025–2026, en orden de fecha.
  const ls = (await c.query(`SELECT p.ejercicio, p.periodo, p.folio, p.fecha::date::text fecha, l.cuenta, l.cargo_abono ca, upper(l.cfdi_uuid) u
      FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
       AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
     WHERE p.source='contpaqi' AND p.ejercicio IN (2025,2026) AND p.tipo_pol='2' AND l.cfdi_uuid IS NOT NULL
       AND (l.cuenta ~ '^(2120|5010|5020|5050|5060|5070|5080)') ORDER BY p.fecha, p.ejercicio, p.periodo, p.folio`)).rows;
  const cf = new Map((await c.query(`SELECT upper(uuid) u, emisor_rfc rfc, fecha::date::text f, total::float8 tot,
      coalesce((impuestos->>'iva_trasladado')::float8,0) iva, coalesce((impuestos->>'ieps_trasladado')::float8,0) ieps,
      coalesce((impuestos->>'subtotal_iva_16')::float8,0) s16
      FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante IN ('I','E') AND fecha >= '2024-06-01'`, [MEGA])).rows.map((r) => [r.u, r]));
  const mapa = new Map((await c.query(`SELECT upper(rfc) rfc, substr(cuenta_proveedor,5) suf FROM finance.gl_supplier_accounts
      WHERE tenant_id=$1 AND activo AND deleted_at IS NULL AND rfc IS NOT NULL`, [MEGA])).rows.map((r) => [r.rfc, r.suf]));
  const prov = new Map();
  for (const x of (await c.query(`SELECT cuenta, round(importe::numeric,2)::float8 imp, min(p.fecha)::date::text f
      FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
       AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
     WHERE p.source='contpaqi' AND p.ejercicio IN (2025,2026) AND p.tipo_pol='3' AND l.cuenta LIKE '2120%' AND l.cargo_abono='A'
     GROUP BY 1,2`)).rows) prov.set(`${x.cuenta}|${x.imp.toFixed(2)}`, x.f);
  const provCruce = {};
  await c.end();
  let m = await sql.connect(SRC('DB_Directory'));
  const ADD = (await m.request().query(`SELECT DB_DocumentsMetadata db FROM DatabaseDirectory WHERE RFC='${RFC}' ORDER BY Syncronized DESC`)).recordset[0].db; await m.close();
  m = await sql.connect(SRC(ADD));
  const tr = new Map((await m.request().query(`SELECT cm.UUID u, max(r.TipoRelacion) tr FROM Comprobante cm JOIN CfdiRelacionados r ON r.GuidDocument=cm.GuidDocument
     WHERE cm.RFCReceptor='${RFC}' AND cm.TipoComprobante='E' AND cm.Fecha>='2024-06-01' GROUP BY cm.UUID`)).recordset.map((x) => [U(x.u), x.tr]));
  await m.close();

  // Un evento por (póliza, UUID): qué hizo la contadora con ese CFDI.
  const ev = new Map();
  for (const l of ls) {
    const k = `${l.ejercicio}|${l.periodo}|${l.folio}|${l.u}`;
    if (!ev.has(k)) ev.set(k, { fecha: l.fecha, anio: l.ejercicio, u: l.u, ctas: new Set(), sufs: new Set() });
    ev.get(k).ctas.add(l.cuenta.slice(0, 4)); ev.get(k).sufs.add(l.cuenta.slice(4));
  }
  const eventos = [...ev.values()].filter((e) => cf.has(e.u));
  const errProv = [];
  const hist = { nota: new Map(), prov: new Map(), mixta: new Map(), cuenta: new Map() };
  const votar = (mp, key, val) => { const h = mp.get(key) ?? {}; h[val] = (h[val] || 0) + 1; mp.set(key, h); };
  const mayoria = (h) => { if (!h) return null; const tot = Object.values(h).reduce((a, b) => a + b, 0); const [v, n] = Object.entries(h).sort((a, b) => b[1] - a[1])[0]; return { v, n, tot, pureza: n / tot }; };
  const R = { nota: { n: 0, regla: 0, hist: 0, combinada: 0, hist_cubre: 0 }, prov: { n: 0, regla: 0, combinada: 0, regla_err: 0, hist_corrige: 0, hist_rompe: 0 },
    mixta: { n: 0, regla: 0, combinada: 0 }, cuenta: { n: 0, mapa_ok: 0, mapa_err: 0, sin_mapa: 0, hist_ok: 0, hist_err: 0, sin_hist: 0, sin_mapa_hist_ok: 0, sin_mapa_hist_err: 0, mapa_err_hist_ok: 0 } };
  for (const e of eventos) {
    const x = cf.get(e.u); const enPrueba = e.anio === 2026;
    const esNota = [...e.ctas].some((k) => /^50[5-8]0$/.test(k)); const esFact = [...e.ctas].some((k) => /^(2120|5010|5020)$/.test(k));
    // ── P4 cuenta del proveedor ──
    const suf = [...e.sufs][0];
    if (enPrueba && e.sufs.size === 1) {
      const r = R.cuenta; r.n += 1; const mm = mapa.get(x.rfc); const h = mayoria(hist.cuenta.get(x.rfc));
      if (!mm) r.sin_mapa += 1; else if (mm === suf) r.mapa_ok += 1; else r.mapa_err += 1;
      if (!h) r.sin_hist += 1; else if (h.v === suf) r.hist_ok += 1; else r.hist_err += 1;
      if (!mm && h) { if (h.v === suf) r.sin_mapa_hist_ok += 1; else r.sin_mapa_hist_err += 1; }
      if (mm && mm !== suf && h && h.v === suf) r.mapa_err_hist_ok += 1;
    }
    if (e.sufs.size === 1) votar(hist.cuenta, x.rfc, suf);
    // ── P1 nota: descuento / devolución ──
    if (esNota) {
      const dev = [...e.ctas].some((k) => /^50[68]0$/.test(k)); const des = [...e.ctas].some((k) => /^50[57]0$/.test(k));
      if (dev !== des) {
        const real = dev ? 'dev' : 'desc';
        if (enPrueba) {
          const r = R.nota; r.n += 1; const regla = tr.get(e.u) === '03' ? 'dev' : 'desc'; if (regla === real) r.regla += 1;
          const h = mayoria(hist.nota.get(x.rfc));
          if (h && h.v === real) r.hist += 1;
          const usaHist = h && h.tot >= MIN_N && h.pureza >= PUREZA; if (usaHist) r.hist_cubre += 1;
          if ((usaHist ? h.v : regla) === real) r.combinada += 1;
        }
        votar(hist.nota, x.rfc, real);
      }
    }
    if (!esFact || esNota) continue;
    // ── P2 provisionada (2120) vs directa ──
    const real2120 = e.ctas.has('2120'); const directa = e.ctas.has('5010') || e.ctas.has('5020');
    if (real2120 !== directa) {
      const celda = `${x.tot >= 20000 ? 'ge20' : 'lt20'}|${ym(x.f) < ym(e.fecha) ? 'ant' : 'mismo'}`;
      const regla = celda === 'ge20|ant';
      if (enPrueba) {
        // Señal de ContPAQi: ¿la factura está en una póliza de provisión (diario, abono 2120) anterior al pago?
        const fp = prov.get(`2120${suf}|${(Math.round(x.tot * 100) / 100).toFixed(2)}`);
        const enProv = !!fp && fp <= e.fecha;
        const kp = `${real2120 ? 'real 2120' : 'real directa'} · regla ${regla ? '2120' : 'directa'} · en provisión ${enProv ? 'SÍ' : 'no'}`;
        provCruce[kp] = (provCruce[kp] || 0) + 1;
        const r = R.prov; r.n += 1; if (regla === real2120) r.regla += 1; else { r.regla_err += 1; errProv.push({ real: real2120 ? '2120' : 'directa', celda, tot: x.tot, f: x.f, pago: e.fecha, rfc: x.rfc, u: e.u }); }
        const h = mayoria(hist.prov.get(`${x.rfc}|${celda}`)); const usaHist = h && h.tot >= MIN_N && h.pureza >= PUREZA;
        const pred = usaHist ? h.v === 'true' : regla; if (pred === real2120) r.combinada += 1;
        if (usaHist && pred !== regla) { if (pred === real2120) r.hist_corrige += 1; else r.hist_rompe += 1; }
      }
      votar(hist.prov, `${x.rfc}|${celda}`, String(real2120));
    }
    // ── P3 factura mixta (bases 0 % y 16 %): ¿se parte en 5010/5020 o va toda a una? ──
    if (directa && !real2120 && x.iva > 0) {
      const b16 = x.s16 > 0 ? x.s16 : x.iva / 0.16; const resto = x.tot - b16 - x.iva - x.ieps;
      if (resto >= 1 && b16 >= 1) {
        const real = e.ctas.has('5010') && e.ctas.has('5020') ? 'parte' : e.ctas.has('5020') ? 'todo5020' : 'todo5010';
        if (enPrueba) {
          const r = R.mixta; r.n += 1; if (real === 'parte') r.regla += 1;
          const h = mayoria(hist.mixta.get(x.rfc)); const usaHist = h && h.tot >= MIN_N && h.pureza >= PUREZA;
          if ((usaHist ? h.v : 'parte') === real) r.combinada += 1;
        }
        votar(hist.mixta, x.rfc, real);
      }
    }
  }
  console.log(`eventos (póliza × CFDI) 2025–2026: ${eventos.length} · historia mínima ${MIN_N}, pureza ${PUREZA}`);
  for (const [k, v] of Object.entries(R)) { console.log(k); console.table(v); }
  console.table(provCruce);
  if (process.env.ERR_PROV) require('fs').writeFileSync(process.env.ERR_PROV, JSON.stringify(errProv));
  const g = {}; for (const x of errProv) { const k = `${x.real} · ${x.celda}`; g[k] = (g[k] || 0) + 1; } console.table(g);
  for (const x of errProv.slice(0, 25)) console.log(x.real.padEnd(8), x.celda.padEnd(10), x.tot.toFixed(2).padStart(11), 'factura', x.f, 'pago', x.pago, x.rfc.slice(0, 4), x.u.slice(0, 8));
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
