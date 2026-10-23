#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.86]` — **Simulación del armado «gasto con factura», calificado contra la contadora, ANTES de escribirlo.**
 *
 * La forma real de un gasto (`[CP.8.83]`): una póliza por pago, con las facturas del proveedor, la cuenta de gasto
 * que decide el PROVEEDOR (`gasto-por-rfc-contpaqi.js`: 93.0 % por historia del RFC, placebo 9.0 %) y el IVA de las
 * facturas. Esto arma cada egreso de banco así, SIN mirar la póliza de ella para predecir, y después la usa sólo
 * para calificar:
 *
 *   1. proveedor:  el RFC que da el concepto del banco (`rfcPorTexto` contra el padrón de emisores, `[CP.8.71]`)
 *   2. facturas:   las del RFC entre 180 días antes y 5 después, no pagadas antes, que suman lo pagado — una sola,
 *                  o la ÚNICA combinación de 2 a 4
 *   3. cuenta:     la cuenta de gasto 52xx que ese RFC usó más en las pólizas ANTERIORES
 *   4. asiento:    cargo cuenta = Σ (total − IVA − IEPS) · cargo 1060 = Σ IVA · cargo 1470100 = Σ IEPS · abono banco
 *                  ⛔ facturas con retención (ISR/IVA retenido) NO se arman: se declaran
 *
 * Universo: los egresos de banco (con cuenta de ContPAQi) que casan con una póliza de ella de gasto 52xx, una sola
 * pata de banco. Calificación: Σ por (cuenta, C/A) a ±$0.02 — `igual` / `difiere` (con por qué) / `no_arma` (en qué paso).
 *
 *   node database/scripts/simula-gasto-con-factura-contpaqi.js --desde=2026-01 --hasta=2026-09
 *
 * Sólo lectura, verifica `system_identifier`.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
require('ts-node').register({ transpileOnly: true, skipProject: true, compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' } });
const { construirPadron, rfcPorTexto } = require(path.join(ROOT, 'libs/finance/src/lib/contpaqi/rfc-acreedor.ts'));

const PROD = '7688376744939610156';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const arg = (n, d) => { const p = process.argv.find((a) => a.startsWith(`--${n}=`)); return p ? p.split('=').slice(1).join('=') : d; };
const DESDE = arg('desde', '2026-01'); const HASTA = arg('hasta', '2026-09');
const finMes = (m) => { const [y, mm] = m.split('-').map(Number); return new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 10); };
const cent = (n) => Math.round(Number(n) * 100);
const dia = (s) => Math.floor(Date.parse(String(s).slice(0, 10)) / 86400000);

(async () => {
  const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW,
    pool: { min: 0, max: 1, afterCreate: (c, d) => c.query('SET default_transaction_read_only = on', (e) => d(e, c)) } });
  const sid = (await knex.raw('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD) { console.error(`⛔ no es prod (${sid})`); process.exit(1); }
  const D = await knex.transaction(async (trx) => {
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [MEGA]);
    const q = async (sql, b) => (await trx.raw(sql, b)).rows;
    const lineas = await q(`
      SELECT p.ejercicio||'|'||p.periodo||'|'||p.folio k, to_char(p.fecha,'YYYY-MM-DD') f, l.cuenta, l.cargo_abono ca, l.importe::float8 imp, upper(l.cfdi_uuid) u
        FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source AND l.ejercicio=p.ejercicio
         AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
       WHERE p.source='contpaqi' AND p.tipo_pol='2' AND p.fecha >= '2025-01-01' AND p.fecha < ?::date`, [finMes(HASTA)]);
    const movs = await q(`
      SELECT m.id, ba.contpaqi_cuenta cta, to_char(m.movement_date,'YYYY-MM-DD') f, m.amount_out::float8 imp, coalesce(nullif(btrim(m.concept),''), m.raw_code, '') concepto, c.code cat
        FROM finance.bank_movements m JOIN finance.bank_accounts ba ON ba.id=m.bank_account_id LEFT JOIN finance.movement_categories c ON c.id=m.category_id
       WHERE m.tenant_id=? AND m.deleted_at IS NULL AND m.amount_out > 0 AND ba.contpaqi_cuenta IS NOT NULL
         AND m.movement_date >= ?::date AND m.movement_date < ?::date`, [MEGA, `${DESDE}-01`, finMes(HASTA)]);
    const cfdis = await q(`
      SELECT upper(uuid) u, emisor_rfc rfc, emisor_nombre nom, tipo_comprobante tc, fecha::date::text f, total::float8 tot,
             coalesce((impuestos->>'iva_trasladado')::float8,0) iva, coalesce((impuestos->>'ieps_trasladado')::float8,0) ieps,
             coalesce(total_retenidos,0)::float8 ret
        FROM fiscal.cfdis WHERE tenant_id=? AND rol='recibidas' AND tipo_comprobante IN ('I','E') AND fecha >= '2024-07-01'`, [MEGA]);
    return { lineas, movs, cfdis };
  });
  // Pólizas reales.
  const pols = new Map();
  for (const l of D.lineas) { const p = pols.get(l.k) ?? { k: l.k, f: l.f, ls: [] }; p.ls.push(l); pols.set(l.k, p); }
  const cfdi = new Map(D.cfdis.map((c) => [c.u, c]));
  const facturasDe = new Map(); for (const c of D.cfdis) if (c.tc === 'I') { if (!facturasDe.has(c.rfc)) facturasDe.set(c.rfc, []); facturasDe.get(c.rfc).push(c); }
  const padron = construirPadron(D.cfdis.map((c) => ({ rfc: c.rfc, nom: c.nom })));
  const POR_IMPORTE = process.argv.includes('--por-importe'); const PLACEBO = process.argv.includes('--placebo');
  const porTotal = new Map(); for (const c of D.cfdis) if (c.tc === 'I') { const kk = cent(c.tot); if (!porTotal.has(kk)) porTotal.set(kk, []); porTotal.get(kk).push(c); }
  // Historia de la contadora: (rfc → [{f, cuenta}]) de gasto, y cuándo se pagó cada factura.
  const histRfc = new Map(); const pagadaEn = new Map(); const porBanco = new Map(); const esGasto = new Map();
  for (const p of pols.values()) {
    const gastos = [...new Set(p.ls.filter((l) => l.ca === 'C' && /^52/.test(l.cuenta)).map((l) => l.cuenta))];
    const otro = p.ls.some((l) => l.ca === 'C' && /^(2120|50[12]0|2140|215)/.test(l.cuenta));
    const bancos = p.ls.filter((l) => l.ca === 'A' && /^102/.test(l.cuenta));
    const us = [...new Set(p.ls.map((l) => l.u).filter(Boolean))];
    for (const u of us) { const f0 = pagadaEn.get(u); if (!f0 || p.f < f0) pagadaEn.set(u, p.f); }
    if (gastos.length === 1 && !otro) {
      const rfcs = [...new Set(us.map((u) => cfdi.get(u)?.rfc).filter(Boolean))];
      if (rfcs.length === 1) { if (!histRfc.has(rfcs[0])) histRfc.set(rfcs[0], []); histRfc.get(rfcs[0]).push({ f: p.f, cuenta: gastos[0] }); }
    }
    if (bancos.length === 1 && gastos.length && !otro) {
      esGasto.set(p.k, true);
      const kk = `${bancos[0].cuenta}|${cent(bancos[0].imp)}`; if (!porBanco.has(kk)) porBanco.set(kk, []); porBanco.get(kk).push(p);
    }
  }
  const moda = (rfc, antes) => { const h = (histRfc.get(rfc) ?? []).filter((x) => x.f < antes); if (!h.length) return null; const c = new Map(); for (const x of h) c.set(x.cuenta, (c.get(x.cuenta) ?? 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
  const huella = (rs) => { const m = new Map(); for (const r of rs) { const k = `${r.cuenta}|${r.ca}`; m.set(k, (m.get(k) ?? 0) + cent(r.imp)); } return m; };
  const iguales = (a, b) => { const A = huella(a), B = huella(b); for (const k of new Set([...A.keys(), ...B.keys()])) if (Math.abs((A.get(k) ?? 0) - (B.get(k) ?? 0)) > 2) return false; return true; };

  const res = {}; const contar = (k, imp) => { res[k] = res[k] ?? { n: 0, imp: 0 }; res[k].n++; res[k].imp += imp; };
  const usadas = new Set();
  for (const m of D.movs.sort((a, b) => a.f.localeCompare(b.f))) {
    const c = (porBanco.get(`${m.cta}|${cent(m.imp)}`) ?? []).filter((p) => !usadas.has(p.k) && Math.abs(dia(p.f) - dia(m.f)) <= 3);
    if (!c.length) continue;            // no es un gasto de una pata de la contadora: fuera del universo
    const real = c[0]; usadas.add(real.k);
    let viaImporte = false;
    // 1. proveedor
    let rfc = rfcPorTexto(m.concepto, padron);
    if (!rfc && POR_IMPORTE) {
      // Sin nombre en el concepto: la ÚNICA factura de cualquier proveedor por ese importe, en la ventana y sin pagar.
      // `--placebo`: lo mismo con el importe + $1.00 — cuánto «encuentra» el azar.
      const objetivo = cent(m.imp) + (PLACEBO ? 100 : 0);
      const todas = (porTotal.get(objetivo) ?? []).filter((x) => dia(x.f) >= dia(m.f) - 60 && dia(x.f) <= dia(m.f) + 5 && !((pagadaEn.get(x.u) ?? '9999') < m.f));
      if (todas.length === 1) { rfc = todas[0].rfc; viaImporte = true; }
    }
    if (!rfc) { contar('no_arma · sin RFC por el concepto', m.imp); continue; }
    // 2. facturas
    const abiertas = (facturasDe.get(rfc) ?? []).filter((x) => dia(x.f) >= dia(m.f) - 180 && dia(x.f) <= dia(m.f) + 5 && !((pagadaEn.get(x.u) ?? '9999') < m.f));
    let F = abiertas.filter((x) => Math.abs(cent(x.tot) - cent(m.imp)) <= 100);
    if (F.length > 1) { contar('no_arma · varias facturas por el mismo importe', m.imp); continue; }
    if (!F.length) {
      const cand = abiertas.filter((x) => x.tot < m.imp + 1).sort((a, b) => b.tot - a.tot).slice(0, 20); const sols = [];
      const rec = (i, s, sel) => { if (sols.length > 1) return; if (sel.length >= 2 && Math.abs(s - cent(m.imp)) <= 100) { sols.push([...sel]); return; } if (sel.length >= 4 || i >= cand.length || s > cent(m.imp) + 100) return; sel.push(cand[i]); rec(i + 1, s + cent(cand[i].tot), sel); sel.pop(); rec(i + 1, s, sel); };
      rec(0, 0, []);
      if (sols.length !== 1) { contar(sols.length ? 'no_arma · combinación ambigua' : 'no_arma · ninguna factura cuadra', m.imp); continue; }
      F = sols[0];
    }
    if (F.some((x) => x.ret > 0)) { contar('no_arma · factura con retención', m.imp); continue; }
    // 3. cuenta
    const cuenta = moda(rfc, m.f);
    if (!cuenta) { contar('no_arma · RFC sin historia', m.imp); continue; }
    // 4. asiento
    const base = F.reduce((a, x) => a + cent(x.tot) - cent(x.iva) - cent(x.ieps), 0);
    const iva = F.reduce((a, x) => a + cent(x.iva), 0); const ieps = F.reduce((a, x) => a + cent(x.ieps), 0);
    const nuestra = [{ cuenta, ca: 'C', imp: base / 100 }, ...(iva ? [{ cuenta: '1060000000', ca: 'C', imp: iva / 100 }] : []),
      ...(ieps ? [{ cuenta: '1470100000', ca: 'C', imp: ieps / 100 }] : []), { cuenta: m.cta, ca: 'A', imp: m.imp }];
    const dif = cent(m.imp) - base - iva - ieps;
    if (dif) nuestra.push({ cuenta: dif > 0 ? '5201000000' : '4200010000', ca: dif > 0 ? 'C' : 'A', imp: Math.abs(dif) / 100 });
    const ellaUuids = new Set(real.ls.map((l) => l.u).filter(Boolean));
    const mismasF = F.every((x) => ellaUuids.has(x.u));
    const via = viaImporte ? ' [RFC por importe]' : '';
    if (iguales(nuestra, real.ls)) contar(`ARMA · igual a la suya${via}`, m.imp);
    else contar(`ARMA · difiere (${!mismasF ? 'otra factura' : real.ls.some((l) => l.ca === 'C' && l.cuenta === cuenta) ? 'importes' : 'otra cuenta'})${via}`, m.imp);
  }
  const tot = Object.values(res).reduce((a, x) => a + x.n, 0);
  console.log(`[CP.8.86] simulación «gasto con factura» · ${DESDE} → ${HASTA} · ${tot} egresos de banco que son gasto de una pata para la contadora`);
  for (const [k, v] of Object.entries(res).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(46)} ${String(v.n).padStart(5)}  $${(v.imp / 1e6).toFixed(2)} M`);
  const ar = Object.entries(res).filter(([k]) => k.startsWith('ARMA')).reduce((a, [, v]) => a + v.n, 0);
  console.log(`  → arma ${ar} de ${tot} (${(100 * ar / tot).toFixed(1)} %) · iguales ${res['ARMA · igual a la suya']?.n ?? 0} de ${ar} (${(100 * (res['ARMA · igual a la suya']?.n ?? 0) / ar).toFixed(1)} %)`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e && e.stack); process.exit(1); });
