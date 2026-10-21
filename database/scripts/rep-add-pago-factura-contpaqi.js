#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.64]` — **El ADD de ContPAQi ya dice qué facturas paga cada pago y a qué factura va cada nota.**
 *
 * Dos tablas del ADD (la base de metadatos de CFDI de ContPAQi, SQL Server) que la Suite no lee:
 *   - `Pagos` + `Pagos_Doc_Rel`: el complemento de pago (REP) que EMITE EL PROVEEDOR al cobrarnos una
 *     factura PPD — con el UUID de cada factura que liquida y cuánto (`ImpPagado`, `ImpSaldoAnt`).
 *     ⚠️ `fiscal.cfdis` no los tiene: el feed del ADD sólo trae tipos I,E (los 176 `P` son de descarga masiva).
 *   - `CfdiRelacionados`: la nota de crédito (E) relaciona por SAT el UUID de la factura (tipo 01/03).
 *     ⚠️ `fiscal.cfdis.xml` sólo está en 129 de 2,995 notas; el XML no sirve para esto, la tabla sí.
 *
 * Método: banco → UN REP del mismo RFC con monto ±$1 y fecha de pago ±5 días → sus facturas; notas = la
 * ÚNICA combinación de notas relacionadas a esas facturas que hace Σ facturas − Σ notas = pagado.
 * Árbitro: lo que asentó la contadora. ⚠️ La nota se califica por IMPORTE (505–508 + reversa de 1060/
 * 1470100), no por UUID: ella junta varias notas en un renglón con el UUID de una sola (o de ninguna).
 * PLACEBO: monto +$137. Con `<salida-cadena.json>` (de `cadena-pago-kepler-contpaqi.js --salida`) cruza
 * los dos métodos.
 *
 * Medido 2026-10-21 (1,837 pólizas): REP único 1,467 (placebo 0) · facturas = contadora 1,424 (97.1 %) ·
 * póliza completa 1,257 (68.4 %) con 18 distintas (1.4 % de lo armado) · 186 no cuadran (174 pagos
 * parciales) · REP vs cadena: coinciden 670 de 686, con 3 errores; cuando difieren, acierta el REP 16 de 16.
 *
 *   CONTPAQI_SQL_PASSWORD=… node database/scripts/rep-add-pago-factura-contpaqi.js [salida-cadena.json]
 *
 * Sólo lectura en las dos bases.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const sql = require('mssql');
const { Client } = require('pg');
const RFC = process.env.CONTPAQI_RFC || 'LOGL851014AQ5';
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const SRC = (database) => {
  // Sin contraseña por defecto en el código: el repo es público.
  if (!process.env.CONTPAQI_SQL_PASSWORD) throw new Error('falta CONTPAQI_SQL_PASSWORD (usuario de sólo lectura del ADD)');
  return { server: process.env.CONTPAQI_SQL_HOST || '192.168.0.35', user: process.env.CONTPAQI_SQL_USER || 'platform_ro',
    password: process.env.CONTPAQI_SQL_PASSWORD, database,
    options: { instanceName: process.env.CONTPAQI_SQL_INSTANCE || 'COMPAC', encrypt: false, trustServerCertificate: true },
    connectionTimeout: 20000, requestTimeout: 300000 };
};
const dia = (s) => Math.floor(Date.parse(String(s instanceof Date ? s.toISOString() : s).slice(0, 10)) / 86400000);
const U = (s) => String(s || '').trim().toUpperCase();
const igual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const cadena = process.argv[2] ? JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8')) : {};
(async () => {
  let m = await sql.connect(SRC('DB_Directory'));
  const ADD = (await m.request().query(`SELECT DB_DocumentsMetadata db FROM DatabaseDirectory WHERE RFC='${RFC}' ORDER BY Syncronized DESC`)).recordset[0].db; await m.close();
  m = await sql.connect(SRC(ADD));
  const rel = (await m.request().query(`SELECT c.UUID nota, c.Total tot, r.UUID rel, r.TipoRelacion tr
      FROM Comprobante c JOIN CfdiRelacionados r ON r.GuidDocument=c.GuidDocument
     WHERE c.RFCReceptor='${RFC}' AND c.TipoComprobante='E' AND c.Fecha>='2025-06-01'`)).recordset;
  const rep = (await m.request().query(`SELECT c.UUID rep, c.RFCEmisor rfc, c.FechaTimbrado ft, p.IdPago, p.FechaPago fp, p.Monto monto,
         d.IdDocumento doc, d.ImpPagado pagado, d.ImpSaldoAnt saldo, d.NumParcialidad parc
      FROM Comprobante c JOIN Pagos p ON p.GuidDocument=c.GuidDocument JOIN Pagos_Doc_Rel d ON d.GuidDocument=c.GuidDocument AND d.IdPago=p.IdPago
     WHERE c.RFCReceptor='${RFC}' AND c.TipoComprobante='P' AND p.FechaPago>='2025-12-01'`)).recordset;
  await m.close();
  const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); await pg.query('SET default_transaction_read_only = on');
  const ver = (await pg.query(`
    WITH l AS (SELECT p.periodo, p.folio, p.fecha, l.cuenta, l.cargo_abono ca, l.importe::float8 imp, upper(l.cfdi_uuid) u
        FROM analytics.gl_polizas p JOIN analytics.gl_poliza_lines l ON l.tenant_id=p.tenant_id AND l.source=p.source
         AND l.ejercicio=p.ejercicio AND l.periodo=p.periodo AND l.tipo_pol=p.tipo_pol AND l.folio=p.folio
       WHERE p.source='contpaqi' AND p.ejercicio=2026 AND p.tipo_pol='2')
    SELECT periodo, folio, min(fecha)::text fecha, sum(imp) FILTER (WHERE cuenta LIKE '102%' AND ca='A') banco,
           array_agg(DISTINCT u) FILTER (WHERE u IS NOT NULL AND ca='C' AND (cuenta LIKE '2120%' OR cuenta LIKE '5010%' OR cuenta LIKE '5020%')) facturas,
           array_agg(DISTINCT u) FILTER (WHERE u IS NOT NULL AND ca='A' AND (cuenta LIKE '505%' OR cuenta LIKE '506%' OR cuenta LIKE '507%' OR cuenta LIKE '508%')) notas,
           -- importe de las notas como lo asentó la contadora: devoluciones/descuentos + la reversa del impuesto
           coalesce(sum(imp) FILTER (WHERE ca='A' AND (cuenta LIKE '505%' OR cuenta LIKE '506%' OR cuenta LIKE '507%' OR cuenta LIKE '508%'
             OR cuenta = '1060000000' OR cuenta = '1470100000')), 0) notas_imp,
           count(DISTINCT cuenta) FILTER (WHERE cuenta LIKE '102%' AND ca='A') n_bancos
      FROM l GROUP BY 1,2 HAVING bool_or(ca='C' AND (cuenta LIKE '2120%' OR cuenta LIKE '5010%' OR cuenta LIKE '5020%'))`)).rows
    .filter((r) => r.facturas && r.facturas.length && Number(r.n_bancos) === 1);
  const cf = new Map((await pg.query(`SELECT upper(uuid) u, emisor_rfc rfc, total::float8 tot FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND fecha>='2025-05-01'`, [MEGA])).rows.map((r) => [r.u, r]));
  await pg.end();

  const notasDe = new Map(); const totNota = new Map();
  for (const x of rel) { if (!['01', '03', '07'].includes(x.tr)) continue; const k = U(x.rel); if (!notasDe.has(k)) notasDe.set(k, new Set()); notasDe.get(k).add(U(x.nota)); totNota.set(U(x.nota), Number(x.tot)); }
  const reps = new Map();
  for (const x of rep) { const k = `${U(x.rep)}|${x.IdPago}`; if (!reps.has(k)) reps.set(k, { rfc: x.rfc, fp: x.fp, ft: x.ft, monto: Number(x.monto), docs: new Set(), det: [] }); reps.get(k).docs.add(U(x.doc)); reps.get(k).det.push({ doc: U(x.doc), parc: Number(x.parc), pagado: Number(x.pagado), saldo: Number(x.saldo) }); }
  const rl = [...reps.values()];
  const diag = {}; const ej = {}; const noc = {}; const ejn = {};

  // Retraso del REP: días entre la fecha del pago y el timbrado del REP.
  const lag = { mismo_dia: 0, '1-3': 0, '4-7': 0, '8-15': 0, '16-31': 0, mas_31: 0 };
  for (const x of rl) { const d = dia(x.ft) - dia(x.fp); const k = d <= 0 ? 'mismo_dia' : d <= 3 ? '1-3' : d <= 7 ? '4-7' : d <= 15 ? '8-15' : d <= 31 ? '16-31' : 'mas_31'; lag[k] += 1; }

  const r = { polizas: ver.length, rep_unico: 0, fact_ok: 0, fact_err: 0, completa_ok: 0, completa_err: 0, no_cuadra: 0, notas_amb: 0, falta_cfdi: 0 };
  const cruce = { ambos_completos: 0, coinciden: 0, coinciden_y_ok: 0, coinciden_y_err: 0, difieren: 0, difieren_rep_ok: 0, difieren_cadena_ok: 0,
    solo_rep_ok: 0, solo_rep_err: 0, solo_cadena_ok: 0, solo_cadena_err: 0, ninguno: 0 };
  for (const p of ver) {
    const verdadF = new Set(p.facturas); const verdadN = new Set(p.notas || []);
    const rfc = cf.get(p.facturas[0])?.rfc;
    let predRep = null;
    const k = rl.filter((x) => x.rfc === rfc && Math.abs(x.monto - p.banco) <= 1 && Math.abs(dia(x.fp) - dia(p.fecha)) <= 5);
    if (k.length === 1) {
      r.rep_unico += 1;
      const fs = k[0].docs;
      if (igual(fs, verdadF)) r.fact_ok += 1; else r.fact_err += 1;
      const tf = [...fs].map((u) => cf.get(u)?.tot);
      if (tf.some((t) => t == null)) r.falta_cfdi += 1;
      else {
        const sumaF = tf.reduce((a, b) => a + b, 0);
        const cand = [...new Set([...fs].flatMap((u) => [...(notasDe.get(u) || [])]))].filter((n) => totNota.has(n)).slice(0, 20);
        const meta = sumaF - p.banco; const sols = [];
        const rec = (i, s, sel) => { if (sols.length > 1) return; if (Math.abs(s - meta) <= 1 + 0.01 * sel.length) { sols.push([...sel]); return; } if (i >= cand.length || s > meta + 1) return; sel.push(cand[i]); rec(i + 1, s + totNota.get(cand[i]), sel); sel.pop(); rec(i + 1, s, sel); };
        rec(0, 0, []);
        if (!sols.length) {
          r.no_cuadra += 1;
          const parcial = k[0].det.some((d) => d.parc > 1 || d.pagado < d.saldo - 1);
          const conSaldoPrevio = k[0].det.some((d) => d.saldo < (cf.get(d.doc)?.tot ?? 0) - 1);
          const cat = parcial ? 'pago parcial (parcialidad > 1 o queda saldo)' : conSaldoPrevio ? 'saldo anterior < total (nota aplicada antes)' : `otro (dif ${meta > 0 ? '+' : ''}${Math.round(meta)})`;
          const ck = cat.startsWith('otro') ? 'otro' : cat;
          noc[ck] = (noc[ck] || 0) + 1; if (igual(fs, verdadF)) noc[`${ck} · facturas = contadora`] = (noc[`${ck} · facturas = contadora`] || 0) + 1; if ((ejn[ck] ??= []).length < 4) ejn[ck].push(`${p.periodo}|${p.folio} banco ${p.banco.toFixed(2)} Σfact ${sumaF.toFixed(2)} cand notas ${cand.length} · ${cat}`);
        }
        else if (sols.length > 1) r.notas_amb += 1;
        else {
          predRep = { f: fs, n: new Set(sols[0]) };
          const sumaN = [...predRep.n].reduce((a, n) => a + totNota.get(n), 0);
          if (igual(fs, verdadF) && Math.abs(sumaN - Number(p.notas_imp)) <= 1 + 0.01 * predRep.n.size) {
            r.completa_ok += 1; if (igual(predRep.n, verdadN)) r.uuid_nota_igual = (r.uuid_nota_igual || 0) + 1;
          } else {
            r.completa_err += 1;
            const cat = !igual(fs, verdadF) ? 'facturas distintas' : !verdadN.size ? 'contadora SIN nota, método CON'
              : !predRep.n.size ? 'contadora CON nota, método SIN' : 'notas distintas';
            diag[cat] = (diag[cat] || 0) + 1;
            if ((ej[cat] ??= []).length < 4) ej[cat].push(`${p.periodo}|${p.folio} banco ${p.banco.toFixed(2)} · facturas ${[...fs].map((u) => cf.get(u).tot.toFixed(2)).join('+')} · notas método ${[...predRep.n].map((n) => totNota.get(n).toFixed(2)).join('+') || '—'} · notas contadora ${[...verdadN].map((n) => (totNota.get(n) ?? cf.get(n)?.tot ?? NaN).toFixed(2)).join('+') || '—'}`);
          }
        }
      }
    }
    const ch = cadena[`${p.periodo}|${p.folio}`];
    const predCad = ch && !ch.incompleto ? { f: new Set(ch.facturas), n: new Set(ch.notas) } : null;
    const ok = (x) => igual(x.f, verdadF);  // facturas (la nota la califica la compuerta de cuadre)
    if (predRep && predCad) {
      cruce.ambos_completos += 1;
      if (igual(predRep.f, predCad.f)) { cruce.coinciden += 1; if (ok(predRep)) cruce.coinciden_y_ok += 1; else cruce.coinciden_y_err += 1; }
      else { cruce.difieren += 1; if (ok(predRep)) cruce.difieren_rep_ok += 1; if (ok(predCad)) cruce.difieren_cadena_ok += 1; }
    } else if (predRep) { if (ok(predRep)) cruce.solo_rep_ok += 1; else cruce.solo_rep_err += 1; }
    else if (predCad) { if (ok(predCad)) cruce.solo_cadena_ok += 1; else cruce.solo_cadena_err += 1; }
    else cruce.ninguno += 1;
  }
  console.log(`REP en el ADD: ${rl.length} pagos · retraso del timbrado del REP respecto del pago:`); console.table(lag);
  console.log('Método REP + notas relacionadas + compuerta de cuadre:'); console.table(r);
  console.log('Por qué no coincide la póliza completa:'); console.table(diag);
  for (const [k, v] of Object.entries(ej)) { console.log(k); for (const x of v) console.log('   ' + x); }
  console.log('Por qué no cuadra (186):'); console.table(noc);
  for (const [k, v] of Object.entries(ejn)) { console.log(k); for (const x of v) console.log('   ' + x); }
  console.log('Cruce REP vs cadena Kepler (facturas):'); console.table(cruce);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
