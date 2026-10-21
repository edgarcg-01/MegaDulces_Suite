#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.63]` — **La cadena estructural: banco → pago Kepler → entradas (kdxf) → CFDI.** Medida contra
 * los UUID que la contadora asoció en ContPAQi.
 *
 * `[CP.8.61]` reconstruía la factura por importe (RFC + total) y tocaba techo: 32 % de los pagos. Eso
 * fue porque se buscó el dato «qué facturas paga cada pago» en las tablas equivocadas. **Kepler sí lo
 * guarda** (Fase ECA, 2026-10-07): `kdxf` casa cada pago con los documentos que liquida, y por cuánto.
 *
 *   L1 · banco → pago Kepler (X-D-25/26/60, proveedor `C%`): la cuenta de tesorería `c45` son los últimos
 *        dígitos de la cuenta (`3041` = Banorte 3041) + importe ±$1 + fecha Kepler entre −2 y +7 días.
 *   L2 · pago → entradas: `kdxf` (estructural: «el cargo c4/c5/c6 se aplicó al abono c7/c8/c9 por c10»).
 *   L3 · entrada (`kdxe`, A) → CFDI: RFC del acreedor (`kdxd.c10`) + total ±$1 + fecha; si hay más de uno,
 *        desempata la referencia `kdxe.c16` (trae los últimos dígitos del folio: «0-F-2734» → 262734).
 *
 * ⛔ El UUID sale SÓLO de Kepler y del CFDI. La respuesta de la contadora se usa para CALIFICAR, nunca
 * para resolver. PLACEBO: la misma cadena con el importe del banco +$137 en L1.
 *
 *   node database/scripts/cadena-pago-kepler-contpaqi.js
 *
 * Sólo lectura.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require('pg');

const MEGA = '00000000-0000-0000-0000-00000000d01c';
const TOL = 1;
const dia = (s) => Math.floor(Date.parse(String(s).slice(0, 10)) / 86400000);
const digitos = (s) => String(s ?? '').replace(/[^0-9]/g, '');

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const sid = (await c.query('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;

  // ── La verdad: pólizas de pago a proveedor 2026 con UUID y un solo banco ──
  const ver = (await c.query(`
    WITH l AS (
      SELECT p.periodo, p.folio, p.fecha, l.cuenta, l.cargo_abono ca, l.importe::float8 imp, upper(l.cfdi_uuid) u
        FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
         AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
       WHERE p.source='contpaqi' AND p.ejercicio=2026 AND p.tipo_pol='2')
    SELECT periodo, folio, min(fecha)::text fecha,
           max(cuenta) FILTER (WHERE cuenta LIKE '102%' AND ca='A') banco_cta,
           sum(imp) FILTER (WHERE cuenta LIKE '102%' AND ca='A') banco,
           array_agg(DISTINCT u) FILTER (WHERE u IS NOT NULL AND ca='C' AND (cuenta LIKE '2120%' OR cuenta LIKE '5010%' OR cuenta LIKE '5020%')) facturas,
           array_agg(DISTINCT u) FILTER (WHERE u IS NOT NULL AND ca='A' AND (cuenta LIKE '505%' OR cuenta LIKE '506%' OR cuenta LIKE '507%' OR cuenta LIKE '508%')) notas,
           count(DISTINCT cuenta) FILTER (WHERE cuenta LIKE '102%' AND ca='A') n_bancos
      FROM l GROUP BY 1,2
     HAVING bool_or(ca='C' AND (cuenta LIKE '2120%' OR cuenta LIKE '5010%' OR cuenta LIKE '5020%'))`)).rows
    .filter((r) => r.facturas && r.facturas.length && Number(r.n_bancos) === 1);

  // ── Cuentas de banco → código de tesorería de Kepler ──
  const etiquetas = new Map((await c.query(`SELECT contpaqi_cuenta, account_label FROM finance.bank_accounts
     WHERE tenant_id=$1 AND contpaqi_cuenta IS NOT NULL`, [MEGA])).rows.map((r) => [r.contpaqi_cuenta, String(r.account_label)]));
  const casaTesoreria = (c45, cta) => {
    const e = etiquetas.get(cta); const t = String(c45 ?? '').trim();
    return !!e && !!t && (t === e || t.endsWith(e) || e.endsWith(t));
  };

  // ── Kepler: pagos a proveedor, casamientos, documentos, RFC del acreedor ──
  const pagos = (await c.query(`
    SELECT DISTINCT ON (c4, c5, c6, c10) sucursal, c4::int t, c5::int s, c6 folio, c10 acreedor,
           c9::date::text f, c16::float8 monto, btrim(coalesce(c45,'')) c45
      FROM kepler_ods.kdm1
     WHERE c2='X' AND c3='D' AND c4 IN (25,26,60) AND c10 LIKE 'C%' AND c9 >= '2025-12-15'
     ORDER BY c4, c5, c6, c10, (btrim(c1)=sucursal) DESC`)).rows;
  const casam = (await c.query(`
    SELECT DISTINCT c2 acreedor, c4::int pt, c5::int ps, c6 pf, c7::int dt, c8::int ds, c9 df, c10::float8 apl
      FROM kepler_ods.kdxf`)).rows;
  const docs = new Map((await c.query(`
    SELECT DISTINCT ON (c2, c4, c5, c6) c2, c4::int t, c5::int s, c6 folio, c7::date::text f, c11::float8 imp, c16 ref
      FROM kepler_ods.kdxe ORDER BY c2, c4, c5, c6, (btrim(c1)=sucursal) DESC`)).rows
    .map((r) => [`${r.c2}|${r.t}|${r.s}|${r.folio}`, r]));
  const acreedores = (await c.query(`SELECT DISTINCT ON (c2) c2, upper(btrim(coalesce(c10,''))) rfc, c3 nombre
      FROM kepler_ods.kdxd ORDER BY c2, (coalesce(btrim(c10),'') <> '') DESC`)).rows;
  const cfdis = (await c.query(`SELECT upper(uuid) u, emisor_rfc rfc, emisor_nombre nom, tipo_comprobante tc, folio, total::float8 tot, fecha::date::text f
      FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante IN ('I','E') AND fecha >= '2025-05-01'`, [MEGA])).rows;
  const porRfc = new Map();
  for (const x of cfdis) { const k = `${x.rfc}|${x.tc}`; if (!porRfc.has(k)) porRfc.set(k, []); porRfc.get(k).push(x); }
  // `[CP.8.63]` 45 % de las entradas de proveedor tienen el acreedor SIN RFC en `kdxd`. Se recupera por el
  // NOMBRE cuando coincide con UN solo emisor de CFDI (medido: 1,297 de 5,099). Nunca por parecido.
  const norm = (s) => String(s ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(S\.?\s*A\.?|DE|C\.?\s*V\.?|S\.?\s*DE\s*R\.?\s*L\.?|SAPI|SA|CV|RL|S|R|L)\b/g, ' ').replace(/[^A-Z0-9]/g, '');
  const rfcPorNombre = new Map();
  for (const x of cfdis) { const k = norm(x.nom); if (!k) continue; const s = rfcPorNombre.get(k) ?? new Set(); s.add(x.rfc); rfcPorNombre.set(k, s); }
  const rfcDe = new Map();
  let porNombre = 0;
  for (const a of acreedores) {
    if (a.rfc) { rfcDe.set(a.c2, a.rfc); continue; }
    const s = rfcPorNombre.get(norm(a.nombre));
    if (s && s.size === 1) { rfcDe.set(a.c2, [...s][0]); porNombre += 1; }
  }

  const aplicacionesDe = new Map();
  for (const a of casam) {
    const k = `${a.acreedor}|${a.pt}|${a.ps}|${a.pf}`;
    if (!aplicacionesDe.has(k)) aplicacionesDe.set(k, []);
    aplicacionesDe.get(k).push(a);
  }
  // Notas aplicadas a un documento: los cargos 55 (nota) / 40 (devolución) que casan contra ESE abono.
  const notasDe = new Map();
  for (const a of casam) {
    if (![55, 40].includes(a.pt)) continue;
    const k = `${a.acreedor}|${a.dt}|${a.ds}|${a.df}`;
    if (!notasDe.has(k)) notasDe.set(k, []);
    notasDe.get(k).push(a);
  }

  const buscarCfdi = (rfc, tc, imp, fecha, ref) => {
    const ventana = (porRfc.get(`${rfc}|${tc}`) || []).filter((x) => dia(x.f) <= dia(fecha) + 15 && dia(fecha) - dia(x.f) <= 90);
    const d = digitos(ref).slice(-4);
    const conRef = (xs) => (d.length >= 3 ? xs.filter((x) => digitos(x.folio).endsWith(d)) : []);
    // 1) importe exacto ±$1; si hay varios, desempata el folio de la referencia.
    const exactos = ventana.filter((x) => Math.abs(x.tot - imp) <= TOL);
    if (exactos.length === 1) return exactos[0];
    if (exactos.length > 1) { const r1 = conRef(exactos); return r1.length === 1 ? r1[0] : 'ambiguo'; }
    // 2) `[CP.8.63]` sin importe exacto: el folio de la referencia, SÓLO si la diferencia es chica (≤ 3 %).
    //    Medido: 1,186 de 11,385 entradas sólo se ligan así (descuentos o centavos al facturar).
    const r2 = conRef(ventana).filter((x) => Math.abs(x.tot - imp) <= Math.max(TOL, 0.03 * imp));
    return r2.length === 1 ? r2[0] : null;
  };

  const r = { total: ver.length, l1: 0, l1_amb: 0, l1_placebo: 0, l2: 0, cadena_ok: 0, cadena_err: 0, cadena_inc: 0,
    con_nota: 0, notas_ok: 0, sin_rfc: 0 };
  const motivos = {};
  const nota = (k) => { motivos[k] = (motivos[k] || 0) + 1; };
  // `--salida <archivo>`: lo que predijo la cadena por póliza, para cruzarla con otro método.
  const salida = {};
  for (const p of ver) {
    const tienenNota = (p.notas || []).length > 0;
    if (tienenNota) r.con_nota += 1;
    const enVentana = (x, monto) => casaTesoreria(x.c45, p.banco_cta) && Math.abs(x.monto - monto) <= TOL
      && dia(x.f) - dia(p.fecha) >= -2 && dia(x.f) - dia(p.fecha) <= 7;
    const k1 = pagos.filter((x) => enVentana(x, p.banco));
    if (pagos.some((x) => enVentana(x, p.banco + 137))) r.l1_placebo += 1;
    if (k1.length !== 1) { if (k1.length > 1) { r.l1_amb += 1; nota('L1 ambiguo'); } else nota('L1 sin pago Kepler'); continue; }
    r.l1 += 1;
    const pg = k1[0];
    const aps = (aplicacionesDe.get(`${pg.acreedor}|${pg.t}|${pg.s}|${pg.folio}`) || []).filter((a) => a.dt === 20);
    if (!aps.length) { nota('L2 pago sin aplicar en kdxf'); continue; }
    r.l2 += 1;
    const rfc = rfcDe.get(pg.acreedor);
    if (!rfc) { r.sin_rfc += 1; nota('L3 acreedor sin RFC en kdxd'); continue; }
    const pred = new Set(); const predNotas = new Set(); let incompleto = false;
    for (const a of aps) {
      const d = docs.get(`${pg.acreedor}|${a.dt}|${a.ds}|${a.df}`);
      if (!d) { incompleto = true; continue; }
      const x = buscarCfdi(rfc, 'I', d.imp, d.f, d.ref);
      if (!x || x === 'ambiguo') { incompleto = true; nota(x ? 'L3 factura ambigua' : 'L3 factura sin CFDI'); continue; }
      pred.add(x.u);
      for (const n of notasDe.get(`${pg.acreedor}|${a.dt}|${a.ds}|${a.df}`) || []) {
        const dn = docs.get(`${pg.acreedor}|${n.pt}|${n.ps}|${n.pf}`);
        const y = dn ? buscarCfdi(rfc, 'E', dn.imp, dn.f, dn.ref) : null;
        if (y && y !== 'ambiguo') predNotas.add(y.u);
      }
    }
    const verdad = new Set(p.facturas);
    const igual = pred.size === verdad.size && [...pred].every((u) => verdad.has(u));
    salida[`${p.periodo}|${p.folio}`] = { facturas: [...pred], notas: [...predNotas], incompleto };
    if (incompleto) { r.cadena_inc += 1; continue; }
    // ⭐ `[CP.8.63]` Compuerta que NO mira la respuesta: Σ facturas − Σ notas tiene que dar lo que salió
    // del banco (±$1 por documento, por los centavos que van a Otros ingresos). Si no cuadra, a revisión.
    const totalDe = (u) => cfdis.find((x) => x.u === u)?.tot ?? 0;
    const neto = [...pred].reduce((a, u) => a + totalDe(u), 0) - [...predNotas].reduce((a, u) => a + totalDe(u), 0);
    if (Math.abs(neto - p.banco) > TOL * (pred.size + predNotas.size)) {
      r.no_cuadra = (r.no_cuadra || 0) + 1;
      if (igual) r.no_cuadra_eran_ok = (r.no_cuadra_eran_ok || 0) + 1;
      continue;
    }
    if (igual) {
      r.cadena_ok += 1;
      if (tienenNota) {
        const vn = new Set(p.notas);
        if (predNotas.size === vn.size && [...predNotas].every((u) => vn.has(u))) r.notas_ok += 1;
      }
    } else { r.cadena_err += 1; nota('cadena completa pero OTRAS facturas'); }
  }

  const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)} %` : '—');
  console.log(`\n[CP.8.63] cadena banco → Kepler → CFDI · system_identifier ${sid}`);
  console.log(`acreedores sin RFC en kdxd recuperados por nombre: ${porNombre}`);
  console.log(`pólizas de pago a proveedor 2026 (con UUID, un banco): ${r.total} · de ellas con nota de crédito: ${r.con_nota}`);
  console.log(`L1 banco → UN pago Kepler:            ${r.l1} (${pct(r.l1, r.total)}) · ambiguo ${r.l1_amb} · PLACEBO ${r.l1_placebo} (${pct(r.l1_placebo, r.total)})`);
  console.log(`L2 pago aplicado a entradas (kdxf):  ${r.l2} (${pct(r.l2, r.total)})`);
  console.log(`CADENA COMPLETA = facturas de la contadora: ${r.cadena_ok} (${pct(r.cadena_ok, r.total)})`);
  console.log(`   ⛔ cadena completa con OTRAS facturas:  ${r.cadena_err} (${pct(r.cadena_err, r.total)})`);
  console.log(`   incompleta (algún eslabón sin resolver): ${r.cadena_inc}`);
  console.log(`   la suma no da lo pagado → a revisión: ${r.no_cuadra || 0} (de ésas, la cadena acertaba en ${r.no_cuadra_eran_ok || 0})`);
  console.log(`   de las correctas con nota de crédito, las notas también coinciden: ${r.notas_ok} de ${ver.filter((p) => (p.notas || []).length).length}`);
  console.log('\ndónde se corta:');
  for (const [k, v] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  const iSal = process.argv.indexOf('--salida');
  if (iSal !== -1) require('fs').writeFileSync(process.argv[iSal + 1], JSON.stringify(salida));
  await c.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
