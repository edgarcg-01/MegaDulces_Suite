#!/usr/bin/env node
'use strict';
/**
 * `[CP.8.66]` — **Nota de crédito: ¿descuento (5050/5070) o devolución (5060/5080)?** La contadora dijo que lo
 * decide el uso del CFDI, y no alcanza (casi todas son G02). Se miden tres fuentes contra la cuenta que ella usó:
 *   (1) Kepler: documento CxP de la nota (`kdxe` 55 nota / 40 devolución), por RFC + importe + fecha.
 *   (2) ADD: descripción y clave SAT de los conceptos del CFDI de egreso.
 *   (3) ADD: `CfdiRelacionados.TipoRelacion` (01 nota de crédito · 03 devolución de mercancía).
 *
 * Medido 2026-10-21 (768 notas con familia inequívoca, 151 devoluciones):
 *   relación 03 → devolución 90 de 93 · relación 01 → descuento 608 de 667 · regla «03 = devolución»:
 *   704 de 768 (91.7 %). Clave 84111506 → descuento 539/588. Kepler liga por importe sólo 90 de 768.
 *   Historial del proveedor (familia mayoritaria previa): 87.1 %, peor que la relación.
 *
 *   CONTPAQI_SQL_PASSWORD=… node database/scripts/nota-familia-contpaqi.js
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
const dia = (s) => Math.floor(Date.parse(String(s instanceof Date ? s.toISOString() : s).slice(0, 10)) / 86400000);
const U = (s) => String(s || '').trim().toUpperCase();
(async () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); await pg.query('SET default_transaction_read_only = on');
  // Verdad: renglones de nota con UUID en pólizas de egreso 2026 → familia por UUID.
  const ver = (await pg.query(`SELECT upper(cfdi_uuid) u, bool_or(cuenta ~ '^50[57]0') descu, bool_or(cuenta ~ '^50[68]0') devol
      FROM analytics.gl_poliza_lines WHERE source='contpaqi' AND ejercicio=2026 AND cargo_abono='A' AND cuenta ~ '^50[5-8]0' AND cfdi_uuid IS NOT NULL GROUP BY 1`)).rows
    .filter((r) => r.descu !== r.devol).map((r) => ({ u: r.u, fam: r.devol ? 'devolución' : 'descuento' }));
  const cf = new Map((await pg.query(`SELECT upper(uuid) u, emisor_rfc rfc, total::float8 tot, fecha::date::text f, receptor_uso_cfdi uso
      FROM fiscal.cfdis WHERE tenant_id=$1 AND rol='recibidas' AND tipo_comprobante='E'`, [MEGA])).rows.map((r) => [r.u, r]));
  const kx = (await pg.query(`SELECT DISTINCT ON (x.c2, x.c4, x.c5, x.c6) x.c2, x.c4::int t, x.c7::date::text f, x.c11::float8 imp, x.c16 ref,
      upper(btrim(coalesce(d.c10,''))) rfc FROM kepler_ods.kdxe x LEFT JOIN kepler_ods.kdxd d ON d.c2=x.c2
     WHERE x.c4 IN (40,55) AND x.c7 >= '2025-10-01' AND x.c2 LIKE 'C%' ORDER BY x.c2, x.c4, x.c5, x.c6`)).rows;
  await pg.end();
  let m = await sql.connect(SRC('DB_Directory'));
  const ADD = (await m.request().query(`SELECT DB_DocumentsMetadata db FROM DatabaseDirectory WHERE RFC='${RFC}' ORDER BY Syncronized DESC`)).recordset[0].db; await m.close();
  m = await sql.connect(SRC(ADD));
  const con = (await m.request().query(`SELECT cm.UUID u, c.CveProdSer cps, c.Descripcion d FROM Comprobante cm JOIN Conceptos c ON c.GuidDocument=cm.GuidDocument
     WHERE cm.RFCReceptor='${RFC}' AND cm.TipoComprobante='E' AND cm.Fecha>='2025-10-01'`)).recordset;
  const rel = (await m.request().query(`SELECT cm.UUID u, r.TipoRelacion tr FROM Comprobante cm JOIN CfdiRelacionados r ON r.GuidDocument=cm.GuidDocument
     WHERE cm.RFCReceptor='${RFC}' AND cm.TipoComprobante='E' AND cm.Fecha>='2025-10-01'`)).recordset;
  await m.close();
  const concDe = new Map(); for (const x of con) { const k = U(x.u); if (!concDe.has(k)) concDe.set(k, []); concDe.get(k).push(x); }
  const trDe = new Map(rel.map((x) => [U(x.u), x.tr]));
  const tab = {}; const cuenta = (k) => { tab[k] = (tab[k] || 0) + 1; };
  const tk = {}; const ttr = {}; const cruce = {}; const tcps = {}; const tdesc = {};
  for (const v of ver) {
    const x = cf.get(v.u); if (!x) { cuenta('sin CFDI en fiscal.cfdis'); continue; }
    // (1) Kepler
    const c1 = kx.filter((k) => k.rfc === x.rfc && Math.abs(k.imp - x.tot) <= 1 && Math.abs(dia(k.f) - dia(x.f)) <= 20);
    const tipos = [...new Set(c1.map((k) => k.t))];
    const kk = `${v.fam} · Kepler ${tipos.length === 1 ? (tipos[0] === 40 ? 'X-D-40 devolución' : 'X-D-55 nota') : tipos.length ? 'ambos' : 'sin doc'}`; tk[kk] = (tk[kk] || 0) + 1;
    // (2) conceptos
    const cs = concDe.get(v.u) || [];
    const txt = cs.map((c) => String(c.d || '')).join(' ').toUpperCase();
    const pal = /DEVOL/.test(txt) ? 'dice DEVOL' : /DESC|BONIF|REBAJ|PROMO/.test(txt) ? 'dice DESC/BONIF' : cs.length ? 'otra descripción' : 'sin conceptos';
    tdesc[`${v.fam} · ${pal}`] = (tdesc[`${v.fam} · ${pal}`] || 0) + 1;
    const cps = [...new Set(cs.map((c) => c.cps))].join('/') || '—';
    const kc = `${v.fam} · ${cps === '84111506' ? '84111506 (servicio de facturación)' : cps.length > 10 ? 'varias claves' : 'clave de producto ' + (cps === '—' ? '—' : 'mercancía')}`; tcps[kc] = (tcps[kc] || 0) + 1;
    // (3) relación
    const kt = `${v.fam} · relación ${trDe.get(v.u) || '—'}`; ttr[kt] = (ttr[kt] || 0) + 1;
    // Cruce relación × clave, para ver si juntas deciden.
    const claveTipo = cps === '84111506' ? 'servicio' : cps === '—' ? 'sin' : 'mercancía';
    const cel = `rel ${trDe.get(v.u) || '—'} · clave ${claveTipo}`;
    (cruce[cel] ??= { descuento: 0, devolución: 0 })[v.fam] += 1;
  }
  console.log(`notas con familia inequívoca en 2026: ${ver.length} (devolución ${ver.filter((v) => v.fam === 'devolución').length})`);
  console.log('(1) Kepler'); console.table(tk);
  console.log('(2a) descripción del concepto'); console.table(tdesc);
  console.log('(2b) ClaveProdServ'); console.table(tcps);
  console.table(cruce); console.log('(3) TipoRelacion (01 nota de crédito · 03 devolución de mercancía)'); console.table(ttr);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
