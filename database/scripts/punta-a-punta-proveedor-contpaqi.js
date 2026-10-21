#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.70]` — **De punta a punta, sin oráculo:** del movimiento de banco (cuenta, importe, fecha) a la póliza
 * completa de pago a proveedor. La póliza de la contadora SÓLO califica; nada de ella entra a la predicción.
 *
 *   proveedor   L1 de la cadena Kepler (`cadena-pago-kepler-contpaqi.js --salida`), o el REP único en la ventana
 *   facturas    REP del proveedor (ADD); si no hay, la cadena Kepler completa
 *   notas       las relacionadas en el ADD que cuadran con lo pagado (o las de la cadena)
 *   cuenta      la ya usada con ese RFC antes de la fecha (si no, `gl_supplier_accounts`)
 *   2120        regla de 20 mil + mes anterior, O la factura está en la provisión de su mes
 *   nota        relación 03 = devolución · redondeo < $1 · compuerta: Σ cargos = Σ abonos
 *   parcial / notas juntadas por factura con el REP → NO se arma: va a confirmar (con `ARMA_PARCIAL=1` se mide)
 *
 *   respaldos `[CP.8.71]`: proveedor por el NOMBRE en el concepto del banco (46 de 50 bien) y facturas por importe
 *   (una, o la combinación única) cuando no hay REP ni cadena. La cadena repara el RFC de Kepler (ver allá).
 *
 * Primera medición 2026-10-21 (sin respaldos ni RFC reparado): se arman solas 948 (51.8 %),
 * iguales 868, distintas 80 (8.4 % de lo armado: 11 doble registro de la provisión, 5 par de tarjeta, 4 mixta
 * sin partir, 16 descuento/devolución sin efecto fiscal, 8 liga, 11 frontera 2120, 3 cuenta, 4 anticipo, 18
 * otros — centavos de la base). A confirmar 443 (la propuesta acertaría en 246). Sin armar: 298 sin REP y
 * cadena incompleta, 74 sin proveedor, 51 no cuadran, 9 sin cuenta, 8 REP ambiguo.
 * Con `[CP.8.71]`: **se arman 1,142 (62.4 %)**, iguales 1,051, distintas 91 (8.0 %; error del puente 29 = 2.5 %:
 * liga 10, frontera 2120 12, cuenta 3, anticipo 4). A confirmar 505 (279 ya correctas). El cruce «nota del REP =
 * nota aplicada en Kepler» NO alcanza para armar solo (107 de 182, 59 %): queda detrás de `CRUCE_KEPLER=1`.
 *
 *   node database/scripts/cadena-pago-kepler-contpaqi.js --salida /tmp/cadena.json
 *   CONTPAQI_SQL_PASSWORD=… node database/scripts/punta-a-punta-proveedor-contpaqi.js /tmp/cadena.json
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
const igual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const MODO_PROV = process.env.MODO_PROV || 'o';
const cadena = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); await c.query('SET default_transaction_read_only = on');
  const base = `FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
       AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio WHERE p.source='contpaqi'`;
  const lineas = (await c.query(`SELECT p.ejercicio, l.periodo, l.folio, p.fecha::date::text fecha, l.cuenta, l.cargo_abono ca, l.importe::float8 imp, upper(l.cfdi_uuid) u
      ${base} AND p.ejercicio IN (2025,2026) AND p.tipo_pol='2'`)).rows;
  const cf = new Map((await c.query(`SELECT upper(uuid) u, emisor_rfc rfc, emisor_nombre nom, tipo_comprobante tc, fecha::date::text f, total::float8 tot,
      coalesce((impuestos->>'iva_trasladado')::float8,0) iva, coalesce((impuestos->>'ieps_trasladado')::float8,0) ieps,
      coalesce((impuestos->>'subtotal_iva_16')::float8,0) s16
      FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante IN ('I','E') AND fecha >= '2024-06-01'`, [MEGA])).rows.map((r) => [r.u, r]));
  const mapa = new Map((await c.query(`SELECT upper(rfc) rfc, substr(cuenta_proveedor,5) suf FROM finance.gl_supplier_accounts
      WHERE tenant_id=$1 AND activo AND deleted_at IS NULL AND rfc IS NOT NULL`, [MEGA])).rows.map((r) => [r.rfc, r.suf]));
  const prov = new Map(); const mesesConProv = new Set();
  for (const x of (await c.query(`SELECT l.cuenta, round(l.importe::numeric,2)::float8 imp, min(p.fecha)::date::text f
      ${base} AND p.ejercicio IN (2025,2026) AND p.tipo_pol='3' AND l.cuenta LIKE '2120%' AND l.cargo_abono='A' GROUP BY 1,2`)).rows) {
    prov.set(`${x.cuenta}|${x.imp.toFixed(2)}`, x.f); mesesConProv.add(ym(x.f));
  }
  // Movimientos de banco (con el tenant: RLS forzado) para leer el concepto que capturó tesorería.
  await c.query('BEGIN READ ONLY'); await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [MEGA]);
  const movs = (await c.query(`SELECT a.contpaqi_cuenta cta, m.movement_date::date::text f, m.amount_out::float8 imp, coalesce(m.concept,'') con
      FROM finance.bank_movements m JOIN finance.bank_accounts a ON a.id=m.bank_account_id
     WHERE m.deleted_at IS NULL AND m.amount_out > 0 AND m.movement_date >= '2025-12-20' AND a.contpaqi_cuenta IS NOT NULL`)).rows;
  await c.query('ROLLBACK');
  await c.end();
  const movIdx = new Map(); for (const x of movs) { const k = `${x.cta}|${x.imp.toFixed(2)}`; if (!movIdx.has(k)) movIdx.set(k, []); movIdx.get(k).push(x); }
  const conceptoDe = (cta, imp, fecha) => { const xs = (movIdx.get(`${cta}|${r2(imp).toFixed(2)}`) || []).filter((x) => Math.abs(dia(x.f) - dia(fecha)) <= 3); return xs.length === 1 ? xs[0].con : null; };
  // Nombre normalizado (sin acentos, sin razón social) → RFC del emisor; sólo si el nombre lleva a UN RFC.
  const norm = (s) => String(s ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(S\.?\s*A\.?|DE|DEL|LA|LOS|LAS|Y|C\.?\s*V\.?|S\.?\s*DE\s*R\.?\s*L\.?|SAPI|SA|CV|RL|S|R|L|SC|SPR)\b/g, ' ').replace(/[^A-Z0-9]/g, '');
  const rfcsPorNombre = new Map();
  for (const x of cf.values()) { const k = norm(x.nom); if (k.length < 5) continue; if (!rfcsPorNombre.has(k)) rfcsPorNombre.set(k, new Set()); rfcsPorNombre.get(k).add(x.rfc); }
  const nombres = [...rfcsPorNombre.entries()].filter(([, s]) => s.size === 1).map(([k, s]) => [k, [...s][0]]);
  const rfcPorTexto = (texto) => {
    const t = norm(texto); if (t.length < 6) return null;
    const exacto = rfcsPorNombre.get(t); if (exacto && exacto.size === 1) return [...exacto][0];
    const hits = new Set(nombres.filter(([k]) => (k.length >= 8 && t.includes(k)) || (t.length >= 8 && k.startsWith(t))).map(([, r]) => r));
    return hits.size === 1 ? [...hits][0] : null;
  };
  let m = await sql.connect(SRC('DB_Directory'));
  const ADD = (await m.request().query(`SELECT DB_DocumentsMetadata db FROM DatabaseDirectory WHERE RFC='${RFC}' ORDER BY Syncronized DESC`)).recordset[0].db; await m.close();
  m = await sql.connect(SRC(ADD));
  const rel = (await m.request().query(`SELECT cm.UUID nota, r.UUID rel, r.TipoRelacion tr FROM Comprobante cm JOIN CfdiRelacionados r ON r.GuidDocument=cm.GuidDocument
     WHERE cm.RFCReceptor='${RFC}' AND cm.TipoComprobante='E' AND cm.Fecha>='2025-06-01'`)).recordset;
  const rep = (await m.request().query(`SELECT c.UUID rep, c.RFCEmisor rfc, p.IdPago, p.FechaPago fp, p.Monto monto, d.IdDocumento doc, d.ImpPagado pagado, d.ImpSaldoInsoluto ins
      FROM Comprobante c JOIN Pagos p ON p.GuidDocument=c.GuidDocument JOIN Pagos_Doc_Rel d ON d.GuidDocument=c.GuidDocument AND d.IdPago=p.IdPago
     WHERE c.RFCReceptor='${RFC}' AND c.TipoComprobante='P' AND p.FechaPago>='2025-12-01'`)).recordset;
  await m.close();
  const notasDe = new Map(); const trNota = new Map();
  for (const x of rel) { trNota.set(U(x.nota), x.tr); if (!['01', '03', '07'].includes(x.tr)) continue; const k = U(x.rel); if (!notasDe.has(k)) notasDe.set(k, new Set()); notasDe.get(k).add(U(x.nota)); }
  const reps = new Map();
  for (const x of rep) { const k = `${U(x.rep)}|${x.IdPago}`; if (!reps.has(k)) reps.set(k, { rfc: U(x.rfc), fp: x.fp, monto: Number(x.monto), det: new Map() }); reps.get(k).det.set(U(x.doc), { pagado: Number(x.pagado), ins: Number(x.ins) }); }
  const rl = [...reps.values()];

  const esCompra = (cta) => /^(2120|5010|5020)/.test(cta); const esNota = (cta) => /^(505|506|507|508)/.test(cta);
  // Cuenta del proveedor por historia: la última usada con ese RFC ANTES de la fecha.
  const usoRfc = new Map();
  for (const l of lineas) if (l.u && cf.has(l.u) && l.ca === 'C' && esCompra(l.cuenta)) { const rf = cf.get(l.u).rfc; if (!usoRfc.has(rf)) usoRfc.set(rf, []); usoRfc.get(rf).push({ f: l.fecha, suf: l.cuenta.slice(4) }); }
  for (const v of usoRfc.values()) v.sort((a, b) => (a.f < b.f ? -1 : 1));
  const cuentaDe = (rf, fecha) => { const h = (usoRfc.get(rf) || []).filter((x) => x.f < fecha); return h.length ? h[h.length - 1].suf : mapa.get(rf) ?? null; };

  const asentar = (fecha, F, factor, N, notaVirtual, extra, B, banco, suf) => {
    const gen = []; const add = (ca, cuenta, imp) => { if (r2(imp) > 0.004) gen.push({ ca, cuenta, imp: r2(imp) }); };
    for (const u of F) {
      const x = cf.get(u); const k = factor.get(u) ?? 1;
      const fp = prov.get(`2120${suf}|${r2(x.tot).toFixed(2)}`);
      const regla = x.tot >= 20000 && ym(x.f) < ym(fecha); const enProv = !!fp && fp <= fecha && fp >= x.f.slice(0, 7);
      const provisionada = MODO_PROV === 'regla' ? regla : MODO_PROV === 'provision' ? (mesesConProv.has(ym(x.f)) ? enProv : regla) : (regla || enProv);
      if (provisionada) {
        add('C', '2120' + suf, x.tot * k); add('C', '1470100000', x.ieps * k); add('A', '1470110000', x.ieps * k);
        add('C', '1060000000', x.iva * k); add('A', '1470040000', x.iva * k);
      } else {
        const b16 = x.iva > 0 ? (x.s16 > 0 ? x.s16 : x.iva / 0.16) : 0;
        add('C', '5020' + suf, b16 * k); add('C', '1060000000', x.iva * k); add('C', '1470100000', x.ieps * k);
        const resto = (x.tot - b16 - x.iva - x.ieps) * k; if (Math.abs(resto) >= 1) add('C', '5010' + suf, resto);
      }
    }
    const notaDe = (x, q, dev) => {
      const b16 = x.iva > 0 ? (x.s16 > 0 ? x.s16 : x.iva / 0.16) : 0;
      add('A', (dev ? '5080' : '5070') + suf, b16 * q); add('A', '1060000000', x.iva * q); add('A', '1470100000', x.ieps * q);
      const resto = (x.tot - b16 - x.iva - x.ieps) * q; if (Math.abs(resto) >= 1) add('A', (dev ? '5060' : '5050') + suf, resto);
    };
    for (const u of N) notaDe(cf.get(u), 1, trNota.get(u) === '03');
    for (const [u, monto] of notaVirtual) { const x = cf.get(u); notaDe(x, monto / x.tot, false); }
    if (extra > 1) add('C', '1050' + suf, extra);
    add('A', banco, B);
    const dif = r2(gen.filter((g) => g.ca === 'C').reduce((a, g) => a + g.imp, 0) - gen.filter((g) => g.ca === 'A').reduce((a, g) => a + g.imp, 0));
    if (Math.abs(dif) >= 1) return null;   // compuerta: no cuadra con lo pagado → no se arma
    if (dif > 0) add('A', '4200010000', dif); else if (dif < 0) add('C', '5201000000', -dif);
    return gen;
  };
  const estricta = (ls, gen) => { const pend = [...gen]; for (const l of ls) { const i = pend.findIndex((g) => g.ca === l.ca && g.cuenta === l.cuenta && Math.abs(g.imp - r2(l.imp)) <= 0.02); if (i < 0) return false; pend.splice(i, 1); } return !pend.length; };
  const agregada = (ls, gen) => {
    const s = new Map(); const n = new Map();
    for (const l of ls) { const k = `${l.ca}|${l.cuenta}`; s.set(k, (s.get(k) || 0) + l.imp); n.set(k, (n.get(k) || 0) + 1); }
    for (const g of gen) { const k = `${g.ca}|${g.cuenta}`; s.set(k, (s.get(k) || 0) - g.imp); n.set(k, (n.get(k) || 0) + 1); }
    const red = (s.get('A|4200010000') || 0) - (s.get('C|5201000000') || 0); s.delete('A|4200010000'); s.delete('C|5201000000');
    if (Math.abs(red) > 0.05) return false;
    for (const [k, v] of s) if (Math.abs(v) > 0.03 * (n.get(k) || 1)) return false;
    return true;
  };

  const texto = {}; const diagImp = {}; const rfcDif = {}; const ejR = [];
  const facturasRfc = new Map(); for (const x of cf.values()) if (x.tc === 'I') { if (!facturasRfc.has(x.rfc)) facturasRfc.set(x.rfc, []); facturasRfc.get(x.rfc).push(x); }
  // Ya pagadas: UUID de factura en una póliza de egreso anterior (estado de ContPAQi, disponible al armar).
  const pagadaAntes = new Map();
  for (const l of lineas) if (l.u && l.ca === 'C' && esCompra(l.cuenta)) { const f0 = pagadaAntes.get(l.u); if (!f0 || l.fecha < f0) pagadaAntes.set(l.u, l.fecha); }
  const pol = new Map();
  for (const l of lineas) { if (l.ejercicio !== 2026) continue; const k = `${l.periodo}|${l.folio}`; if (!pol.has(k)) pol.set(k, { fecha: l.fecha, ls: [] }); pol.get(k).ls.push(l); }
  const porCamino = {}; const ejC = []; const causas = {}; const ejO = []; const R = { polizas: 0, arma_igual: 0, arma_distinta: 0, distinta_facturas: 0, distinta_asiento: 0 }; const noArma = {}; const fuente = {};
  const na = (k) => { noArma[k] = (noArma[k] || 0) + 1; };
  for (const [k, p] of pol) {
    const ls = p.ls;
    if (!ls.some((l) => l.ca === 'C' && esCompra(l.cuenta))) continue;
    const bancos = ls.filter((l) => l.ca === 'A' && l.cuenta.startsWith('102'));
    if (bancos.length !== 1) continue;   // factoraje (sin banco) y varios bancos: fuera, como en v3
    R.polizas += 1;
    const B = bancos[0].imp; const banco = bancos[0].cuenta; const ch = cadena[k];
    // 1) proveedor
    let rfc = ch?.rfc || null;
    const enVentana = (x) => Math.abs(x.monto - B) <= 1 && Math.abs(dia(x.fp) - dia(p.fecha)) <= 5;
    let candRep = rl.filter((x) => enVentana(x) && (!rfc || x.rfc === rfc));
    if (!rfc && candRep.length === 1) rfc = candRep[0].rfc;
    // Respaldo: el nombre del proveedor que tesorería escribió en el concepto del banco.
    const verdadRfc = (() => { const u = ls.find((l) => l.ca === 'C' && esCompra(l.cuenta) && l.u && cf.has(l.u))?.u; return u ? cf.get(u).rfc : null; })();
    let porTexto = false;
    if (!rfc) {
      const con = conceptoDe(banco, B, p.fecha); const rt = con ? rfcPorTexto(con) : null;
      const kt = !con ? 'sin movimiento de banco único' : !rt ? 'el nombre no lleva a un RFC' : rt === verdadRfc ? 'RFC = el de la contadora' : 'RFC DISTINTO';
      texto[kt] = (texto[kt] || 0) + 1;
      if (rt) { rfc = rt; porTexto = true; candRep = rl.filter((x) => enVentana(x) && x.rfc === rfc); }
    }
    if (!rfc) { na('sin proveedor (ni Kepler ni REP único ni nombre en el banco)'); continue; }
    // 2) facturas
    let F = null; let src = null; let repOk = candRep.length === 1 ? candRep[0] : null;
    if (repOk && [...repOk.det.keys()].every((u) => cf.has(u))) { F = [...repOk.det.keys()]; src = 'REP'; }
    else if (ch && !ch.incompleto && ch.facturas.length) { F = ch.facturas; src = 'cadena Kepler'; repOk = null; }
    // Respaldo `[CP.8.61]`: por importe. Facturas abiertas del RFC (−180/+30 días, no pagadas en una póliza anterior):
    // UNA con el total = pagado, o la ÚNICA combinación (2..6) que suma lo pagado.
    if (!F && candRep.length <= 1) {
      const abiertas = [...(facturasRfc.get(rfc) || [])].filter((x) => dia(x.f) <= dia(p.fecha) + 30 && dia(p.fecha) - dia(x.f) <= 180 && !(pagadaAntes.has(x.u) && pagadaAntes.get(x.u) < p.fecha));
      const unas = abiertas.filter((x) => Math.abs(x.tot - B) <= 1);
      if (unas.length === 1) { F = [unas[0].u]; src = 'importe (una)'; }
      else if (!unas.length) {
        const cand = abiertas.filter((x) => x.tot < B + 1).sort((a, b) => b.tot - a.tot).slice(0, 24); const sols = [];
        const rec = (i, s, sel) => { if (sols.length > 1) return; if (sel.length >= 2 && Math.abs(s - B) <= 1) { sols.push([...sel]); return; } if (sel.length >= 6 || i >= cand.length || s > B + 1) return; sel.push(cand[i].u); rec(i + 1, s + cand[i].tot, sel); sel.pop(); rec(i + 1, s, sel); };
        rec(0, 0, []);
        if (sols.length === 1) { F = sols[0]; src = 'importe (combinación)'; }
      }
      if (porTexto && F) src += ' · proveedor por nombre';
    }
    if (!F && candRep.length <= 1) {
      // Diagnóstico con la respuesta (sólo para entender, no predice): ¿por qué el importe no alcanzó?
      const vF = [...new Set(ls.filter((l) => l.ca === 'C' && esCompra(l.cuenta) && l.u).map((l) => l.u))];
      const tieneNota = ls.some((l) => l.ca === 'A' && esNota(l.cuenta));
      const sv = vF.reduce((a, u) => a + (cf.get(u)?.tot ?? 0), 0);
      const cat = !vF.length ? 'ella no asoció UUID de compra' : vF.some((u) => !cf.has(u)) ? 'su factura no está en fiscal.cfdis'
        : cf.get(vF[0]).rfc !== rfc ? 'proveedor identificado distinto' : tieneNota ? 'lleva nota (Σ facturas − notas)'
        : Math.abs(sv - B) > 1 ? (sv > B ? 'pago parcial sin REP' : 'pagó de más (anticipo / otra cosa)')
        : vF.length > 6 ? 'más de 6 facturas' : 'importe ambiguo (otra combinación también suma)';
      diagImp[cat] = (diagImp[cat] || 0) + 1;
      if (cat === 'proveedor identificado distinto') {
        const vr = cf.get(vF[0]).rfc;
        const kind = !rfc ? '?' : rfc.replace(/[^A-Z0-9&Ñ]/g, '') === vr ? 'mismo RFC con otro formato' : rfc.slice(0, 3) === vr.slice(0, 3) ? 'RFC parecido (mismas 3 letras)' : 'otro RFC';
        rfcDif[kind] = (rfcDif[kind] || 0) + 1;
        if (ejR.length < 10) ejR.push(`${k} Kepler «${rfc}» (${porTexto ? 'nombre' : 'cadena'}) · CFDI ${vr} ${cf.get(vF[0]).nom}`);
      }
    }
    if (!F) { na(candRep.length > 1 ? 'REP ambiguo y cadena incompleta' : 'sin REP, cadena incompleta y sin importe único'); continue; }
    const suf = cuentaDe(rfc, p.fecha); if (!suf) { na('proveedor sin cuenta (ni historia ni mapa)'); continue; }
    // 3) notas
    const sumF = F.reduce((a, u) => a + cf.get(u).tot, 0); const tol = (n) => 1 + 0.01 * n;
    let gen = null; let camino = 'completo'; let virt = [];
    if (Math.abs(sumF - B) <= tol(F.length)) gen = asentar(p.fecha, F, new Map(), [], [], 0, B, banco, suf);
    if (!gen) {
      const cand = [...new Set(F.flatMap((u) => [...(notasDe.get(u) || [])]))].filter((n) => cf.has(n) && cf.get(n).f <= p.fecha).slice(0, 20);
      const meta = sumF - B; const sols = [];
      const rec = (i, s, sel) => { if (sols.length > 1) return; if (sel.length && Math.abs(s - meta) <= tol(sel.length)) { sols.push([...sel]); return; } if (i >= cand.length || s > meta + 1) return; sel.push(cand[i]); rec(i + 1, s + cf.get(cand[i]).tot, sel); sel.pop(); rec(i + 1, s, sel); };
      if (meta > 1) rec(0, 0, []);
      if (sols.length === 1) { gen = asentar(p.fecha, F, new Map(), sols[0], [], 0, B, banco, suf); camino = 'notas del ADD'; }
      else if (src === 'cadena Kepler' && ch.notas.length) { camino = 'notas de la cadena'; } if (camino === 'notas de la cadena') gen = asentar(p.fecha, F, new Map(), ch.notas.filter((n) => cf.has(n)), [], 0, B, banco, suf); 
    }
    if (!gen && repOk) {
      // parcial / notas juntadas: por factura con el REP (pendiente > 30 % = parcialidad real)
      const factor = new Map(); virt = []; let pagado = 0;
      for (const u of F) {
        const x = cf.get(u); const d = repOk.det.get(u); pagado += d.pagado;
        const baseF = d.ins / x.tot <= 0.3 ? x.tot : x.tot - d.ins; factor.set(u, baseF / x.tot);
        if (baseF - d.pagado >= 0.5) virt.push([u, baseF - d.pagado]);
      }
      gen = asentar(p.fecha, F, factor, [], virt, B - pagado, B, banco, suf); camino = 'REP por factura';
    }
    if (!gen) { na(`no cuadra con lo pagado (${src})`); continue; }
    if (camino === 'REP por factura' && !process.env.ARMA_PARCIAL) {
      // Dos métodos independientes: la nota que propone el REP (total − pagado) y lo que Kepler aplicó en este pago.
      const notaRep = virt.reduce((a, [, mto]) => a + mto, 0); const kn = ch?.kNotas;
      const coincide = kn != null && notaRep > 0.5 && Math.abs(notaRep - kn) <= 1 + 0.002 * notaRep;
      const ok0 = estricta(ls, gen) || agregada(ls, gen);
      // Medido: con el cruce se armarían 182 y saldrían iguales 107 (59 %) → NO alcanza; sólo con CRUCE_KEPLER=1.
      if (!coincide || !process.env.CRUCE_KEPLER) { na(`a confirmar: parcial o notas juntadas (la propuesta acertaría ${ok0 ? 'SÍ' : 'no'})`); continue; }
      camino = 'REP por factura = Kepler';
    }
    fuente[src] = (fuente[src] || 0) + 1;
    const verdadF = new Set(ls.filter((l) => l.ca === 'C' && esCompra(l.cuenta) && l.u).map((l) => l.u));
    const ok = estricta(ls, gen) || agregada(ls, gen); const kc = camino + ' · ' + (ok ? 'igual' : 'DISTINTA'); porCamino[kc] = (porCamino[kc] || 0) + 1; if (!ok && camino === 'completo' && (ejC.length < 5)) ejC.push(k + ' real: ' + ls.map((l) => l.ca + ' ' + l.cuenta + ' ' + r2(l.imp)).join(', ') + ' || gen: ' + gen.map((g) => g.ca + ' ' + g.cuenta + ' ' + g.imp).join(', '));
    if (ok) R.arma_igual += 1;
    else {
      R.arma_distinta += 1; if (verdadF.size && !igual(new Set(F), verdadF)) R.distinta_facturas += 1; else R.distinta_asiento += 1;
      // causa
      const pend = [...gen]; const sinPar = [];
      for (const l of ls) { const i = pend.findIndex((g) => g.ca === l.ca && g.cuenta === l.cuenta && Math.abs(g.imp - r2(l.imp)) <= 0.02); if (i >= 0) pend.splice(i, 1); else sinPar.push({ ...l, imp: r2(l.imp) }); }
      const todos = [...sinPar, ...pend]; const pref = new Set(todos.map((x) => x.cuenta.slice(0, 4)));
      const mismos = (() => { const a = sinPar.map((l) => `${l.ca}${l.imp.toFixed(2)}`).sort(); const b = pend.map((g) => `${g.ca}${g.imp.toFixed(2)}`).sort(); return a.length === b.length && a.every((x, i) => x === b[i]); })();
      let causa;
      if (verdadF.size && !igual(new Set(F), verdadF)) causa = 'facturas distintas (liga)';
      else if (todos.some((x) => x.cuenta === '2140800000')) causa = 'tarjeta: ella agrega el par 2140800000';
      else if (mismos && [...pref].every((q) => ['5010', '5020'].includes(q))) causa = '501 vs 502 (ella no partió la mixta)';
      else if (mismos && [...pref].every((q) => /^50[5-8]0$/.test(q))) causa = 'nota: descuento vs devolución';
      else if (pref.has('2120') && [...pref].some((q) => ['5010', '5020'].includes(q))) {
        const enP = F.some((u) => { const x = cf.get(u); const fp = prov.get(`2120${suf}|${r2(x.tot).toFixed(2)}`); return !!fp && fp <= p.fecha; });
        causa = enP && sinPar.some((l) => /^50[12]0/.test(l.cuenta)) ? '2120: estaba provisionada y ella pagó como directa (doble registro)' : '2120 vs directa (frontera)';
      } else if (mismos) causa = 'cuenta del proveedor';
      else if (todos.some((x) => x.cuenta.startsWith('1050'))) causa = 'anticipo 1050';
      else causa = 'otro';
      causas[causa] = (causas[causa] || 0) + 1;
      if (causa === 'otro' && ejO.length < 4) ejO.push(`${k} real: ${sinPar.map((l) => `${l.ca} ${l.cuenta} ${l.imp}`).join(', ')} · gen: ${pend.map((g) => `${g.ca} ${g.cuenta} ${g.imp}`).join(', ')}`);
    }
  }
  const armadas = R.arma_igual + R.arma_distinta;
  console.log(`[CP.8.70] punta a punta, sin oráculo · pólizas de pago a proveedor 2026 con un banco: ${R.polizas}`);
  console.log(`se arman ${armadas} (${(armadas / R.polizas * 100).toFixed(1)} %): iguales ${R.arma_igual} (${(R.arma_igual / R.polizas * 100).toFixed(1)} % del total) · distintas ${R.arma_distinta} (${(R.arma_distinta / armadas * 100).toFixed(1)} % de lo armado)`);
  console.table(R); console.log('fuente de las facturas de lo armado:', fuente); console.table(porCamino); console.log('causa de las distintas:'); console.table(causas); for (const e of ejO) console.log(e); console.log('proveedor por el nombre del banco (cuando Kepler y REP no lo dan):'); console.table(texto); console.log('por qué no alcanzó el importe:'); console.table(diagImp); console.table(rfcDif); for (const e of ejR) console.log(e); console.log('no se arman:'); console.table(noArma);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
