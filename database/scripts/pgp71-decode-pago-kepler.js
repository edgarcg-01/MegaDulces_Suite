#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `[PGP.71]` C0 de O3 — **qué escribe un pago `X-D-26` en Kepler, medido sobre los pagos reales.**
 *
 * Sólo lectura, contra `kepler_ods` en PRODUCCIÓN (verificada por `system_identifier`, no por el
 * nombre de la base). Universo: pagos por transferencia a proveedores de compra (`c10 LIKE 'C%'`,
 * sin Caja General `0011`) de oficinas (`00`) desde el 2026-08-01. Resultado del 2026-11-04 en
 * `FASE_PGP_PAGO_A_PROVEEDOR.md` §4 «C0 de O3 re-medido».
 *
 * Cada medición trae su CONTROL: una pregunta cuya respuesta ya se sabe por otro camino.
 *
 *   node database/scripts/pgp71-decode-pago-kepler.js
 */
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');
require(path.join(RAIZ, 'node_modules', 'dotenv')).config({ path: path.join(RAIZ, '.env'), quiet: true });
const { urlDeProd, PROD_CLUSTER_ID } = require(path.join(RAIZ, 'database', 'scripts', 'lib', 'destino-prod.js'));
const { Client } = require(path.join(RAIZ, 'node_modules', 'pg'));

const DESDE = process.env.DESDE || '2026-08-01';
const W = `m.sucursal='00' AND m.c2='X' AND m.c3='D' AND btrim(m.c4::text)='26' AND m.c9 >= '${DESDE}'
  AND m.c31='Tra' AND btrim(m.c10) LIKE 'C%' AND m.c43 <> 'C' AND btrim(m.c45) <> '0011'`;
// Lo aplicado a cada factura (abono) desde kdxf.
const AP = `ap AS (SELECT sucursal, c2, c7, c8, c9, sum(c10) aplicado FROM kepler_ods.kdxf WHERE sucursal='00' GROUP BY 1,2,3,4,5),
  fa AS (SELECT e.*, e.c11 - coalesce(ap.aplicado, 0) saldo, row_number() OVER (PARTITION BY e.c2 ORDER BY e.c6) rn
           FROM kepler_ods.kdxe e LEFT JOIN ap ON ap.sucursal=e.sucursal AND ap.c2=e.c2 AND ap.c7=e.c4 AND ap.c8=e.c5 AND ap.c9=e.c6
          WHERE e.sucursal='00' AND e.c3='A' AND e.c7 >= '2026-01-01')`;

const MEDICIONES = [
  ['1 · El saldo de la factura vive en kdxe.c20 (control: el saldo de OTRA factura del mismo acreedor)',
    `WITH ${AP} SELECT count(*) FILTER (WHERE saldo > 0.01) abiertas,
       count(*) FILTER (WHERE saldo > 0.01 AND abs(c20 - saldo) < 0.01) c20_es_saldo,
       (SELECT count(*) FROM fa a JOIN fa b ON a.c2=b.c2 AND b.rn=a.rn+1 WHERE a.saldo>0.01 AND b.saldo>0.01) pares_placebo,
       (SELECT count(*) FROM fa a JOIN fa b ON a.c2=b.c2 AND b.rn=a.rn+1 WHERE a.saldo>0.01 AND b.saldo>0.01 AND abs(a.c20-b.saldo)<0.01) placebo_casa
     FROM fa`],
  ['2 · La cabecera contra su renglón kdxe (control: n = cada columna)',
    `SELECT count(*) n,
       count(*) FILTER (WHERE abs(m.c16::numeric - e.c11) < 0.01) importe, count(*) FILTER (WHERE abs(m.c42::numeric - m.c16::numeric) < 0.01) c42,
       count(*) FILTER (WHERE btrim(m.c11) = btrim(e.c16)) referencia, count(*) FILTER (WHERE btrim(m.c45) = btrim(e.c22)) c45,
       count(*) FILTER (WHERE btrim(m.c12) = btrim(e.c18)) concepto, count(*) FILTER (WHERE e.c20 = 0) remanente_cero
     FROM kepler_ods.kdm1 m JOIN kepler_ods.kdxe e ON e.sucursal=m.sucursal AND e.c3='D' AND btrim(e.c4::text)='26' AND e.c6=m.c6 AND btrim(e.c2)=btrim(m.c10)
    WHERE ${W}`],
  ['3 · IVA (c81/c82) e IEPS (c84) proporcionales a lo aplicado de cada factura',
    `WITH x AS (SELECT f.c6 pago, sum(f.c10 * (i.c14::numeric / nullif(i.c16::numeric, 0))) iva, sum(f.c10 * (i.c15::numeric / nullif(i.c16::numeric, 0))) ieps
                  FROM kepler_ods.kdxf f JOIN kepler_ods.kdm1 i ON i.sucursal=f.sucursal AND i.c2='X' AND i.c3='A' AND btrim(i.c4::text)=btrim(f.c7::text)
                   AND btrim(i.c5::text)=btrim(f.c8::text) AND i.c6=f.c9
                 WHERE f.sucursal='00' AND btrim(f.c4::text)='26' GROUP BY 1)
     SELECT count(*) n, count(*) FILTER (WHERE m.c81::numeric <> 0) iva_no_cero,
       count(*) FILTER (WHERE abs(m.c81::numeric - x.iva) < 0.02) c81, count(*) FILTER (WHERE abs(m.c82::numeric - x.iva) < 0.0001) c82,
       count(*) FILTER (WHERE abs(m.c84::numeric - x.ieps) < 0.02) c84
     FROM kepler_ods.kdm1 m JOIN x ON x.pago = m.c6 WHERE ${W}`],
  ['4 · Cada cuenta bancaria de la Suite resuelve a UN código de tesorería (kdb1)',
    `WITH k AS (SELECT btrim(c1) code, regexp_replace(upper(c2),'[^A-Z]','','g') banco, (regexp_match(c2,'([0-9]{3,})'))[1] dig FROM kepler_ods.kdb1 WHERE sucursal='00'),
          b AS (SELECT alias, regexp_replace(upper(bank),'[^A-Z]','','g') bb, regexp_replace(account_label,'[^0-9]','','g') d FROM finance.bank_accounts WHERE active AND kind='bank')
     SELECT count(*) cuentas, count(*) FILTER (WHERE n = 1) un_codigo, count(*) FILTER (WHERE n <> 1) ambiguas FROM (
       SELECT b.alias, count(k.code) n FROM b LEFT JOIN k ON b.d <> '' AND k.dig LIKE '%' || b.d
          AND (k.banco LIKE b.bb || '%' OR b.bb LIKE k.banco || '%' OR (b.bb = 'BBAJIO' AND k.banco = 'BAJIO')) GROUP BY 1) x`],
  ['5 · Conceptos mezclados en un pago (Kepler pide uno)',
    `WITH a AS (SELECT m.c6, count(DISTINCT btrim(e.c18)) nc FROM kepler_ods.kdm1 m
                JOIN kepler_ods.kdxf f ON f.sucursal=m.sucursal AND btrim(f.c4::text)='26' AND f.c6=m.c6
                JOIN kepler_ods.kdxe e ON e.sucursal=f.sucursal AND e.c3='A' AND e.c2=f.c2 AND e.c4=f.c7 AND e.c5=f.c8 AND e.c6=f.c9
               WHERE ${W} GROUP BY 1)
     SELECT count(*) pagos, count(*) FILTER (WHERE nc > 1) mezclados FROM a`],
];

(async () => {
  const c = new Client({ connectionString: urlDeProd(), statement_timeout: 240000 });
  await c.connect();
  const sid = (await c.query('SELECT system_identifier::text s FROM pg_control_system()')).rows[0].s;
  if (sid !== PROD_CLUSTER_ID) throw new Error(`No es producción: system_identifier ${sid}`);
  await c.query('SET default_transaction_read_only = on');
  for (const [titulo, sql] of MEDICIONES) {
    const r = await c.query(sql);
    console.log(`\n## ${titulo}`);
    console.table(r.rows);
  }
  await c.end();
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
