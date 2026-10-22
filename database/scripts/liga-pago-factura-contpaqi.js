#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.61]` — **¿Qué factura paga un movimiento de banco?** Medición con árbitro.
 *
 * R1/R2 del catálogo de asientos (`FASE_CP8_ATERRIZAJE.md` §3.5) necesitan la FACTURA de cada
 * pago: su total (corte de $20 mil con impuestos), su mes, sus impuestos y su UUID. El pago de
 * Kepler no la trae, y los complementos de pago (REP) cubren poco (466 ligas, desde julio).
 *
 * El árbitro son los UUID que la contadora asoció en sus pólizas de pago a proveedor de 2026.
 * El método: RFC del proveedor + total del CFDI = importe del pago (±$1), factura de hasta 180 días
 * antes y hasta 30 días DESPUÉS del pago (se paga y luego se factura: rentas, anticipos), sin las
 * ya pagadas en un pago anterior. Si hay más de un candidato, NO se elige.
 * PLACEBO: el mismo método con el importe +$137.
 * Varias facturas: la ÚNICA combinación (2..6) de facturas abiertas del RFC que suma el pago.
 *
 * Medido 2026-10-21 (1,837 pólizas con UUID y un solo banco):
 *   una factura (705)     82.8 % exacto · 0.1 % error · 6.5 % ambiguo · 10.5 % sin candidato · placebo 0.0 %
 *   varias facturas (419) 48.4 % exacto · 1.7 % error → las combinaciones NO se arman solas
 *   con nota de crédito (713) fuera: la nota no se arma sola (respuesta de contabilidad)
 *
 *   node database/scripts/liga-pago-factura-contpaqi.js
 *
 * Sólo lectura.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require('pg');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const VENTANA_ANTES = 180;
const VENTANA_DESPUES = 30;
const TOLERANCIA = 1;

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const sid = (await c.query('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;

  // La verdad: por póliza de pago, el abono a banco y los UUID tipo I que cargó (la factura pagada).
  const ver = (await c.query(`
    WITH l AS (
      SELECT p.periodo, p.folio, p.fecha, l.cuenta, l.cargo_abono ca, l.importe::float8 imp, upper(l.cfdi_uuid) u
        FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
         AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
       WHERE p.source='contpaqi' AND p.ejercicio=2026 AND p.tipo_pol='2')
    SELECT periodo, folio, min(fecha)::text fecha,
           sum(imp) FILTER (WHERE cuenta LIKE '102%' AND ca='A') banco,
           array_agg(DISTINCT u) FILTER (WHERE u IS NOT NULL AND ca='C'
             AND (cuenta LIKE '2120%' OR cuenta LIKE '5010%' OR cuenta LIKE '5020%')) facturas,
           bool_or(cuenta LIKE '505%' OR cuenta LIKE '506%' OR cuenta LIKE '507%' OR cuenta LIKE '508%') con_nota,
           count(DISTINCT cuenta) FILTER (WHERE cuenta LIKE '102%' AND ca='A') n_bancos
      FROM l GROUP BY 1,2
     HAVING bool_or(ca='C' AND (cuenta LIKE '2120%' OR cuenta LIKE '5010%' OR cuenta LIKE '5020%'))`)).rows
    // ⚠️ `count()` llega como texto: compararlo contra 1 sin Number() dejaba el universo en cero.
    .filter((r) => r.facturas && r.facturas.length && Number(r.n_bancos) === 1);

  const cf = new Map((await c.query(`SELECT upper(uuid) u, emisor_rfc rfc, total::float8 tot, fecha::date::text f
      FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante='I' AND fecha >= '2025-06-01'`, [MEGA])).rows
    .map((r) => [r.u, r]));
  const porRfc = new Map();
  for (const x of cf.values()) { if (!porRfc.has(x.rfc)) porRfc.set(x.rfc, []); porRfc.get(x.rfc).push(x); }
  const dia = (s) => Math.floor(Date.parse(s) / 86400000);
  // Ya pagadas: UUID que la contadora asoció en un pago ANTERIOR a éste.
  const pagada = new Map();
  for (const p of ver) for (const u of p.facturas) { const d = dia(p.fecha); if (!pagada.has(u) || pagada.get(u) > d) pagada.set(u, d); }
  const abiertas = (rfc, fecha) => (porRfc.get(rfc) || []).filter((x) =>
    dia(x.f) <= dia(fecha) + VENTANA_DESPUES && dia(fecha) - dia(x.f) <= VENTANA_ANTES
    && !(pagada.has(x.u) && pagada.get(x.u) < dia(fecha)));
  const buscar = (rfc, imp, fecha) => abiertas(rfc, fecha).filter((x) => Math.abs(x.tot - imp) <= TOLERANCIA);

  const r = { con_nota: 0, una: 0, una_ok: 0, una_err: 0, una_amb: 0, una_sin: 0, placebo: 0,
    varias: 0, v_ok: 0, v_err: 0, v_amb: 0, v_sin: 0 };
  const errores = [];
  for (const p of ver) {
    const t = p.facturas.map((u) => cf.get(u)).filter(Boolean);
    if (!t.length) continue;
    const rfc = t[0].rfc;
    if (p.con_nota) { r.con_nota += 1; continue; }
    if (p.facturas.length === 1) {
      r.una += 1;
      const cands = buscar(rfc, p.banco, p.fecha);
      if (buscar(rfc, p.banco + 137, p.fecha).length) r.placebo += 1;
      if (!cands.length) r.una_sin += 1;
      else if (cands.length > 1) r.una_amb += 1;
      else if (cands[0].u === p.facturas[0]) r.una_ok += 1;
      else {
        r.una_err += 1;
        const v = cf.get(p.facturas[0]);
        errores.push(`pago ${p.fecha} ${p.banco.toFixed(2)} · contadora ${v.f} ${v.tot.toFixed(2)} · método ${cands[0].f} ${cands[0].tot.toFixed(2)}`);
      }
    } else {
      r.varias += 1;
      const cand = abiertas(rfc, p.fecha).sort((a, b) => b.tot - a.tot).slice(0, 24);
      const sols = [];
      const rec = (i, suma, sel) => {
        if (sols.length > 1) return;
        if (sel.length >= 2 && Math.abs(suma - p.banco) <= TOLERANCIA) { sols.push([...sel]); return; }
        if (sel.length >= 6 || i >= cand.length || suma > p.banco + TOLERANCIA) return;
        sel.push(cand[i].u); rec(i + 1, suma + cand[i].tot, sel); sel.pop(); rec(i + 1, suma, sel);
      };
      rec(0, 0, []);
      if (!sols.length) r.v_sin += 1;
      else if (sols.length > 1) r.v_amb += 1;
      else {
        const a = new Set(sols[0]);
        if (p.facturas.length === a.size && p.facturas.every((u) => a.has(u))) r.v_ok += 1; else r.v_err += 1;
      }
    }
  }
  const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)} %` : '—');
  console.log(`\n[CP.8.61] qué factura paga cada movimiento · system_identifier ${sid}`);
  console.log(`pólizas de pago a proveedor 2026 con UUID y un solo banco: ${ver.length}`);
  console.log(`  con nota de crédito (no se arman solas): ${r.con_nota}`);
  console.log(`\nuna factura (${r.una}): exacto ${pct(r.una_ok, r.una)} · ERROR ${pct(r.una_err, r.una)} · ambiguo ${pct(r.una_amb, r.una)} · sin candidato ${pct(r.una_sin, r.una)} · PLACEBO ${pct(r.placebo, r.una)}`);
  console.log(`varias facturas (${r.varias}): exacto ${pct(r.v_ok, r.varias)} · ERROR ${pct(r.v_err, r.varias)} · ambiguo ${pct(r.v_amb, r.varias)} · ninguna ${pct(r.v_sin, r.varias)}`);
  if (errores.length) { console.log('\nerrores de una factura:'); for (const e of errores) console.log('  ' + e); }
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
