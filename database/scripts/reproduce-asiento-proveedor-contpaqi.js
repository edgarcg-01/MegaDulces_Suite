#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.65]` — **¿Sabemos ASENTAR un pago a proveedor?** Se reconstruye cada póliza de pago a proveedor de
 * 2026 renglón por renglón y se compara contra la de la contadora.
 *
 * Para aislar la REGLA de la LIGA, las facturas son las que ella asoció (la liga ya se midió aparte:
 * `rep-add-pago-factura-contpaqi.js`, `cadena-pago-kepler-contpaqi.js`). Todo lo demás sale de las fuentes:
 *   - CFDI (`fiscal.cfdis.impuestos`): total, IVA, IEPS, base al 16 % (`subtotal_iva_16`), fecha.
 *   - Regla de contabilidad: total ≥ $20 mil y de mes anterior → 2120 + traspaso IEPS/IVA; si no, 5010/5020.
 *   - Mapa proveedor → cuenta (`finance.gl_supplier_accounts`, por RFC).
 *   - ADD: notas relacionadas (`CfdiRelacionados`; 03 = devolución → 5060/5080, si no descuento 5050/5070)
 *     y lo pagado de cada factura (`Pagos_Doc_Rel.ImpPagado`) para el pago parcial.
 *   - Redondeo: diferencia a favor → abono 4200010000; en contra → cargo 5201000000.
 * Casos: A pago completo · B notas que ella juntó sin UUID (del ADD) · C pago parcial (REP) · D parcial con
 * nota (hipótesis H1–H3). Comparación estricta (renglón ±$0.02) y agregada (Σ por cuenta, porque ella junta
 * varias notas en un renglón).
 *
 * Medido 2026-10-21 (1,907 pólizas): se reproducen 1,435 (75.2 %) — A 1,172/1,293 · B 192/236 · C 47/85 ·
 * D 24/83 — y 293 no entran (76 con varios bancos, 33 proveedor sin mapa, 59 parciales con nota sin regla…).
 *
 *   CONTPAQI_SQL_PASSWORD=… node database/scripts/reproduce-asiento-proveedor-contpaqi.js
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
const r2 = (n) => Math.round(n * 100) / 100; const ym = (s) => String(s).slice(0, 7); const U = (s) => String(s || '').trim().toUpperCase();
const dia = (s) => Math.floor(Date.parse(String(s instanceof Date ? s.toISOString() : s).slice(0, 10)) / 86400000);
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); await c.query('SET default_transaction_read_only = on');
  const lineas = (await c.query(`
    SELECT l.periodo, l.folio, p.fecha::date::text fecha, l.cuenta, l.cargo_abono ca, l.importe::float8 imp, upper(l.cfdi_uuid) u
      FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
       AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
     WHERE p.source='contpaqi' AND p.ejercicio=2026 AND p.tipo_pol='2'`)).rows;
  const cf = new Map((await c.query(`SELECT upper(uuid) u, emisor_rfc rfc, tipo_comprobante tc, fecha::date::text f, total::float8 tot,
      coalesce((impuestos->>'iva_trasladado')::float8,0) iva, coalesce((impuestos->>'ieps_trasladado')::float8,0) ieps,
      coalesce((impuestos->>'subtotal_iva_16')::float8,0) s16
      FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante IN ('I','E') AND fecha >= '2025-01-01'`, [MEGA])).rows.map((r) => [r.u, r]));
  const mapa = new Map((await c.query(`SELECT upper(rfc) rfc, cuenta_proveedor FROM finance.gl_supplier_accounts
      WHERE tenant_id=$1 AND activo AND deleted_at IS NULL AND rfc IS NOT NULL`, [MEGA])).rows.map((r) => [r.rfc, String(r.cuenta_proveedor)]));
  await c.end();
  let m = await sql.connect(SRC('DB_Directory'));
  const ADD = (await m.request().query(`SELECT DB_DocumentsMetadata db FROM DatabaseDirectory WHERE RFC='${RFC}' ORDER BY Syncronized DESC`)).recordset[0].db; await m.close();
  m = await sql.connect(SRC(ADD));
  const rel = (await m.request().query(`SELECT cm.UUID nota, r.UUID rel, r.TipoRelacion tr FROM Comprobante cm JOIN CfdiRelacionados r ON r.GuidDocument=cm.GuidDocument
     WHERE cm.RFCReceptor='${RFC}' AND cm.TipoComprobante='E' AND cm.Fecha>='2025-06-01'`)).recordset;
  const rep = (await m.request().query(`SELECT c.UUID rep, p.IdPago, p.FechaPago fp, p.Monto monto, d.IdDocumento doc, d.ImpPagado pagado
      FROM Comprobante c JOIN Pagos p ON p.GuidDocument=c.GuidDocument JOIN Pagos_Doc_Rel d ON d.GuidDocument=c.GuidDocument AND d.IdPago=p.IdPago
     WHERE c.RFCReceptor='${RFC}' AND c.TipoComprobante='P' AND p.FechaPago>='2025-12-01'`)).recordset;
  await m.close();
  const notasDe = new Map(); const trNota = new Map();
  for (const x of rel) { trNota.set(U(x.nota), x.tr); if (!['01', '03', '07'].includes(x.tr)) continue; const k = U(x.rel); if (!notasDe.has(k)) notasDe.set(k, new Set()); notasDe.get(k).add(U(x.nota)); }
  const repPorDoc = new Map();
  for (const x of rep) { const k = U(x.doc); if (!repPorDoc.has(k)) repPorDoc.set(k, []); repPorDoc.get(k).push({ id: `${U(x.rep)}|${x.IdPago}`, monto: Number(x.monto), fp: x.fp, pagado: Number(x.pagado) }); }

  const esCompra = (cta) => /^(2120|5010|5020)/.test(cta); const esNota = (cta) => /^(505|506|507|508)/.test(cta);
  const asentar = (p, F, factor, N, B, banco, suf) => {
    const gen = []; const add = (ca, cuenta, imp) => { if (r2(imp) > 0.004) gen.push({ ca, cuenta, imp: r2(imp) }); };
    for (const u of F) {
      const x = cf.get(u); const k = factor.get(u) ?? 1;
      if (x.tot >= 20000 && ym(x.f) < ym(p.fecha)) {
        add('C', '2120' + suf, x.tot * k); add('C', '1470100000', x.ieps * k); add('A', '1470110000', x.ieps * k);
        add('C', '1060000000', x.iva * k); add('A', '1470040000', x.iva * k);
      } else {
        const b16 = x.iva > 0 ? (x.s16 > 0 ? x.s16 : x.iva / 0.16) : 0;
        add('C', '5020' + suf, b16 * k); add('C', '1060000000', x.iva * k); add('C', '1470100000', x.ieps * k);
        const resto = (x.tot - b16 - x.iva - x.ieps) * k; if (Math.abs(resto) >= 1) add('C', '5010' + suf, resto);
      }
    }
    for (const u of N) {
      const x = cf.get(u); const dev = trNota.get(u) === '03';
      const b16 = x.iva > 0 ? (x.s16 > 0 ? x.s16 : x.iva / 0.16) : 0;
      add('A', (dev ? '5080' : '5070') + suf, b16); add('A', '1060000000', x.iva); add('A', '1470100000', x.ieps);
      const resto = x.tot - b16 - x.iva - x.ieps; if (Math.abs(resto) >= 1) add('A', (dev ? '5060' : '5050') + suf, resto);
    }
    add('A', banco, B);
    const dif = r2(gen.filter((g) => g.ca === 'C').reduce((a, g) => a + g.imp, 0) - gen.filter((g) => g.ca === 'A').reduce((a, g) => a + g.imp, 0));
    if (dif > 0) add('A', '4200010000', dif); else if (dif < 0) add('C', '5201000000', -dif);
    return gen;
  };
  const estricta = (ls, gen) => { const pend = [...gen]; for (const l of ls) { const i = pend.findIndex((g) => g.ca === l.ca && g.cuenta === l.cuenta && Math.abs(g.imp - r2(l.imp)) <= 0.02); if (i < 0) return false; pend.splice(i, 1); } return !pend.length; };
  const agregada = (ls, gen) => {
    const s = new Map(); const n = new Map();
    for (const l of ls) { const k = `${l.ca}|${l.cuenta}`; s.set(k, (s.get(k) || 0) + l.imp); n.set(k, (n.get(k) || 0) + 1); }
    for (const g of gen) { const k = `${g.ca}|${g.cuenta}`; s.set(k, (s.get(k) || 0) - g.imp); n.set(k, (n.get(k) || 0) + 1); }
    // los centavos de redondeo se comparan juntos (4200 abono = −5201 cargo)
    const red = (s.get('A|4200010000') || 0) - (s.get('C|5201000000') || 0); s.delete('A|4200010000'); s.delete('C|5201000000');
    if (Math.abs(red) > 0.05) return false;
    for (const [k, v] of s) if (Math.abs(v) > 0.03 * (n.get(k) || 1)) return false;
    return true;
  };
  const pol = new Map();
  for (const l of lineas) { const k = `${l.periodo}|${l.folio}`; if (!pol.has(k)) pol.set(k, { fecha: l.fecha, ls: [] }); pol.get(k).ls.push(l); }
  const t = {}; const sum = (caso, campo) => { (t[caso] ??= { polizas: 0, estricta: 0, agregada: 0, distinta: 0 })[campo] += 1; };
  const fuera = {}; const fu = (k) => { fuera[k] = (fuera[k] || 0) + 1; };
  let total = 0; const ejNota = {};
  const usadaEn = new Map(); for (const l of lineas) if (l.u && l.ca === 'A' && esNota(l.cuenta)) usadaEn.set(l.u, `${l.periodo}|${l.folio}`);
  for (const [k, p] of pol) {
    const ls = p.ls;
    if (!ls.some((l) => l.ca === 'C' && esCompra(l.cuenta))) continue;
    total += 1;
    const bancos = ls.filter((l) => l.ca === 'A' && l.cuenta.startsWith('102'));
    if (bancos.length !== 1) { fu('más de un banco (o ninguno)'); continue; }
    const F = [...new Set(ls.filter((l) => l.ca === 'C' && esCompra(l.cuenta) && l.u).map((l) => l.u))];
    const Nor = [...new Set(ls.filter((l) => l.ca === 'A' && esNota(l.cuenta) && l.u).map((l) => l.u))];
    if (!F.length) { fu('renglón de compra sin UUID'); continue; }
    if ([...F, ...Nor].some((u) => !cf.has(u))) { fu('CFDI que no está en fiscal.cfdis'); continue; }
    const B = bancos[0].imp; const rfc = cf.get(F[0]).rfc;
    const usada = ls.find((l) => l.ca === 'C' && esCompra(l.cuenta)).cuenta.slice(4);
    const suf = mapa.has(rfc) ? mapa.get(rfc).slice(4) : null;
    if (!suf) { fu('proveedor sin cuenta en el mapa'); continue; }
    const sumF = F.reduce((a, u) => a + cf.get(u).tot, 0);
    let caso = null; let N = Nor; const factor = new Map();
    const tolN = (n) => 1 + 0.01 * n;
    if (Math.abs(sumF - Nor.reduce((a, u) => a + cf.get(u).tot, 0) - B) <= tolN(F.length + Nor.length)) caso = 'A pago completo';
    else {
      // B: las notas del ADD relacionadas a estas facturas, la única combinación que cuadra.
      const cand = [...new Set(F.flatMap((u) => [...(notasDe.get(u) || [])]))].filter((n) => cf.has(n)).slice(0, 20);
      const meta = sumF - B; const sols = [];
      const rec = (i, s, sel) => { if (sols.length > 1) return; if (sel.length && Math.abs(s - meta) <= tolN(sel.length)) { sols.push([...sel]); return; } if (i >= cand.length || s > meta + 1) return; sel.push(cand[i]); rec(i + 1, s + cf.get(cand[i]).tot, sel); sel.pop(); rec(i + 1, s, sel); };
      if (meta > 1) rec(0, 0, []);
      if (sols.length === 1) { caso = 'B notas juntadas (del ADD)'; N = sols[0]; }
      else if (!Nor.length) {
        // C: pago parcial — lo pagado de cada factura en el REP cuyo monto = banco.
        const reps = new Map();
        for (const u of F) for (const x of repPorDoc.get(u) || []) if (Math.abs(x.monto - B) <= 1 && Math.abs(dia(x.fp) - dia(p.fecha)) <= 5) { if (!reps.has(x.id)) reps.set(x.id, new Map()); reps.get(x.id).set(u, x.pagado); }
        const ok = [...reps.values()].filter((mm) => F.every((u) => mm.has(u)));
        if (ok.length === 1) { caso = 'C pago parcial (REP)'; for (const u of F) factor.set(u, ok[0].get(u) / cf.get(u).tot); N = []; }
        else { fu(ok.length > 1 ? 'parcial: REP ambiguo' : 'parcial: sin REP que cuadre (PUE, tardío o no emitido)'); continue; }
      } else {
        const d = r2(sumF - Nor.reduce((a, u) => a + cf.get(u).tot, 0) - B);
        // B2: TODAS las notas relacionadas a estas facturas, timbradas hasta el pago, no usadas en otra póliza.
        const todas = [...new Set(F.flatMap((u) => [...(notasDe.get(u) || [])]))]
          .filter((n) => cf.has(n) && cf.get(n).f <= p.fecha && !(usadaEn.has(n) && usadaEn.get(n) !== k));
        const sT = todas.reduce((a, n) => a + cf.get(n).tot, 0);
        if (todas.length && Math.abs(sumF - sT - B) <= tolN(F.length + todas.length) && suf === usada) {
          const g = asentar(p, F, new Map(), todas, B, bancos[0].cuenta, suf);
          fu(`B2 todas las notas relacionadas · ${estricta(ls, g) ? 'estricta' : agregada(ls, g) ? 'agregada' : 'DISTINTA'}`);
          continue;
        }
        // D: parcial CON nota. Dos hipótesis de asiento, se mide cuál reproduce.
        if (d > 1) {
          const reps = new Map();
          for (const u of F) for (const x of repPorDoc.get(u) || []) if (Math.abs(x.monto - B) <= 1 && Math.abs(dia(x.fp) - dia(p.fecha)) <= 5) { if (!reps.has(x.id)) reps.set(x.id, new Map()); reps.get(x.id).set(u, x.pagado); }
          const ok = [...reps.values()].filter((mm) => F.every((u) => mm.has(u)));
          if (ok.length === 1 && suf === usada) {
            const notasF = (u) => Nor.filter((n) => (notasDe.get(u) || new Set()).has(n)).reduce((a, n) => a + cf.get(n).tot, 0);
            const h1 = new Map(F.map((u) => [u, ok[0].get(u) / cf.get(u).tot]));
            const h2 = new Map(F.map((u) => [u, (ok[0].get(u) + notasF(u)) / cf.get(u).tot]));
            const g1 = asentar(p, F, h1, Nor, B, bancos[0].cuenta, suf); const g2 = asentar(p, F, h2, Nor, B, bancos[0].cuenta, suf);
            const res = (g) => (estricta(ls, g) || agregada(ls, g));
            // H3: factura completa; la nota es «total − pagado» de cada factura (REP), con la composición de la factura.
            const g3 = asentar(p, F, new Map(), [], B, bancos[0].cuenta, suf).filter((g) => !/^(4200010000|5201000000)$/.test(g.cuenta) && !g.cuenta.startsWith('102'));
            for (const u of F) {
              const x = cf.get(u); const q = (x.tot - ok[0].get(u)) / x.tot; if (q * x.tot < 0.5) continue;
              const b16 = x.iva > 0 ? (x.s16 > 0 ? x.s16 : x.iva / 0.16) : 0;
              for (const [cta, v] of [['5070' + suf, b16], ['1060000000', x.iva], ['1470100000', x.ieps], ['5050' + suf, x.tot - b16 - x.iva - x.ieps]]) if (r2(v * q) > 0.004) g3.push({ ca: 'A', cuenta: cta, imp: r2(v * q) });
            }
            g3.push({ ca: 'A', cuenta: bancos[0].cuenta, imp: B });
            const dif3 = r2(g3.filter((g) => g.ca === 'C').reduce((a, g) => a + g.imp, 0) - g3.filter((g) => g.ca === 'A').reduce((a, g) => a + g.imp, 0));
            if (dif3 > 0) g3.push({ ca: 'A', cuenta: '4200010000', imp: dif3 }); else if (dif3 < 0) g3.push({ ca: 'C', cuenta: '5201000000', imp: -dif3 });
            fu(`D parcial con nota (REP) · H1 ${res(g1) ? 'SÍ' : 'no'} · H2 ${res(g2) ? 'SÍ' : 'no'} · H3 nota = total − pagado ${res(g3) ? 'SÍ' : 'no'}`);
            continue;
          }
        }
        const enRep = F.some((u) => (repPorDoc.get(u) || []).some((x) => Math.abs(x.monto - B) <= 1));
        const relac = Nor.every((n) => F.some((u) => (notasDe.get(u) || new Set()).has(n)));
        fu(`con nota y no cuadra · ${d > 0 ? 'se pagó MENOS' : 'se pagó MÁS'} · ${enRep ? 'hay REP' : 'sin REP'} · notas ${relac ? 'relacionadas' : 'de OTRA factura'}`);
        if ((ejNota[d > 0] ??= []).length < 3) ejNota[d > 0].push(`${k} dif ${d} · facturas ${F.map((u) => cf.get(u).tot).join('+')} · notas ${Nor.map((u) => cf.get(u).tot).join('+')} · banco ${B}`);
        continue;
      }
    }
    sum(caso, 'polizas');
    if (suf !== usada) { sum(caso, 'distinta'); continue; }  // cuenta del proveedor mal mapeada: cuenta aparte
    const gen = asentar(p, F, factor, N, B, bancos[0].cuenta, suf);
    if (estricta(ls, gen)) sum(caso, 'estricta'); else if (agregada(ls, gen)) sum(caso, 'agregada'); else sum(caso, 'distinta');
  }
  console.log(`pólizas de pago a proveedor 2026: ${total}`);
  console.table(t);
  console.log('fuera del simulador:'); console.table(fuera); console.log(ejNota);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
