#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[CP.9.3b]` — Los impuestos por movimiento de ContPAQi (`analytics.v_contpaqi_impuesto_movimiento`).
 *
 * Aplica la migración `20261030121451` DENTRO de una transacción, sobre tablas `contpaqi_ods.ct_*` sintéticas con las
 * columnas y tipos de la réplica real (medidos en prod el 2026-10-30), y al final hace ROLLBACK.
 *
 * Qué prueba:
 *   · sin la réplica, la migración no crea nada;
 *   · los códigos: impuesto 0–5, tipo de movimiento 0–2 y tipo de factor 0–3, con el 0 como `sin_clasificar`;
 *   · la tasa en por ciento (16 → base × 0.16), y el signo de una nota de crédito se conserva, no se voltea;
 *   · UUID, nombre local, RFC y cuenta normalizados; vacío → nulo; sin persona → nulo;
 *   · una fila de impuesto sin su póliza queda fuera;
 *   · la búsqueda por UUID y por póliza usa los índices nuevos;
 *   · aplicarla dos veces da lo mismo;
 *   · ⛔ prueba negativa: con la tasa guardada como fracción (0.16) la migración ABORTA — y no pasa en vacío, que es
 *     lo que haría si sólo mirara las filas de 16;
 *   · el `down` quita la vista y los dos índices.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-contpaqi-impuestos.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-contpaqi-impuestos', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261030121451_cp93b_impuestos_por_movimiento_contpaqi.js');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

// Las columnas que usa la vista, con los tipos de la réplica en prod (information_schema, 2026-10-30).
const TABLAS = {
  ct_movimientosimpuestos: `id integer PRIMARY KEY, idpoliza integer, nummovto integer, idpersona integer, idcuenta integer,
    uuid text, ejercicioasignado integer, periodoasignado integer, impuesto integer, nombreimplocal text,
    tipomovimiento integer, tipofactor integer, tasaocuota double precision, impbase double precision,
    impimpuesto double precision, imptotal double precision, ivanoacred double precision, aplicaimpuesto boolean,
    desglosado boolean`,
  ct_polizas: 'id integer PRIMARY KEY, guid text, ejercicio integer, periodo integer, tipopol integer, folio integer, fecha timestamp, concepto text',
  ct_cuentas: 'id integer PRIMARY KEY, codigo text, nombre text',
  ct_personas: 'id integer PRIMARY KEY, rfc text, nombre text',
};
const U = 'abc00001-0000-0000-0000-000000000001';

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const knexLike = { raw: (sql) => c.query(sql) };
  const vista = async () => (await q(`SELECT to_regclass('analytics.v_contpaqi_impuesto_movimiento') v`))[0].v;
  const indices = async () => (await q(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname = 'contpaqi_ods' AND indexname LIKE 'ix_cp93b_%'`))[0].n;

  console.log('\n=== [CP.9.3b] impuestos por movimiento de ContPAQi ===\n');
  await c.query('BEGIN');
  try {
    if (!(await q(`SELECT 1 FROM pg_namespace WHERE nspname = 'analytics'`)).length) {
      console.log('  NO MEDIDO — esta base no tiene el schema analytics');
      await c.query('ROLLBACK'); await c.end(); process.exit(0);
    }
    if (!(await q(`SELECT to_regclass('contpaqi_ods.ct_movimientosimpuestos') r`))[0].r) {
      await migracion.up(knexLike);
      t('sin la réplica, la migración no crea la vista', !(await vista()));
    } else console.log('  · NO MEDIDO «sin réplica»: esta base ya trae contpaqi_ods.ct_movimientosimpuestos');

    await c.query('CREATE SCHEMA IF NOT EXISTS contpaqi_ods');
    for (const [tabla, cols] of Object.entries(TABLAS)) {
      await c.query(`CREATE TABLE IF NOT EXISTS contpaqi_ods.${tabla} (${cols})`);
      await c.query(`DELETE FROM contpaqi_ods.${tabla}`);
    }
    await c.query(`INSERT INTO contpaqi_ods.ct_polizas VALUES (10, 'G1', 2026, 9, 2, 55, '2026-09-15', 'PAGO')`);
    await c.query(`INSERT INTO contpaqi_ods.ct_cuentas VALUES (1, ' 1190-001 ', 'IVA ACREDITABLE PAGADO')`);
    await c.query(`INSERT INTO contpaqi_ods.ct_personas VALUES (7, ' pro010101ab2 ', ' PROVEEDOR DE PRUEBA ')`);
    // (id, idpoliza, nummovto, idpersona, idcuenta, uuid, ej, per, impuesto, nombrelocal, tipomov, tipofactor, tasa, base, imp, total, ivanoacred, aplica, desglosado)
    await c.query(`INSERT INTO contpaqi_ods.ct_movimientosimpuestos VALUES
      (1, 10, 1, 7, 1, ' ${U} ', 2026, 9, 2, '', 1, 1, 16, 1000, 160, 1160, 0, true, true),
      (2, 10, 1, 7, 1, '${U}', 2026, 9, 2, NULL, 1, 1, 16, -500, -80, -580, 0, true, true),
      (3, 10, 2, 7, 1, '', 2026, 9, 3, NULL, 1, 2, 0.0586, 1000, 58.6, 1058.6, 0, true, true),
      (4, 10, 3, 7, 1, '${U}', 2026, 9, 1, NULL, 2, 1, 10, 1000, 100, 1100, 0, true, true),
      (5, 10, 4, 7, 1, '${U}', 2026, 9, 4, ' ISH ', 1, 1, 3, 1000, 30, 1030, 0, true, true),
      (6, 10, 5, NULL, 1, '${U}', 2026, 9, 5, 'Otras Erogaciones', 1, 1, 0, 0, 25, 25, 0, false, false),
      (7, 10, 6, 7, 1, '${U}', 2026, 9, 0, NULL, 0, 0, 0, 10, 0, 10, 0, false, false),
      (8, 10, 7, 7, 1, '${U}', 2026, 9, 2, NULL, 1, 3, 0, 300, 0, 300, 0, true, true),
      (9, 99, 1, 7, 1, '${U}', 2026, 9, 2, NULL, 1, 1, 16, 100, 16, 116, 0, true, true)`);

    await migracion.up(knexLike);
    t('crea la vista', !!(await vista()));
    t('crea los 2 índices de la réplica', (await indices()) === 2, `n=${await indices()}`);

    const f = await q(`SELECT * FROM analytics.v_contpaqi_impuesto_movimiento ORDER BY impuesto_id`);
    const por = new Map(f.map((r) => [r.impuesto_id, r]));
    t('8 filas: la del impuesto sin su póliza (99) queda fuera', f.length === 8 && !por.has(9), `n=${f.length}`);
    const iva = por.get(1);
    t('IVA trasladado a tasa: códigos decodificados', iva.impuesto === 'IVA' && iva.tipo_movimiento === 'traslado' && iva.tipo_factor === 'tasa');
    t('la tasa en por ciento: 16 sobre base 1000 da 160', Number(iva.tasa_o_cuota) === 16 && Number(iva.base) === 1000 && Number(iva.importe) === 160);
    t('UUID en mayúsculas y sin espacios; nombre local vacío → nulo', iva.cfdi_uuid === U.toUpperCase() && iva.nombre_local === null);
    t('la póliza y la persona: RFC en mayúsculas, nombre y cuenta sin espacios', iva.poliza_id === 10 && iva.folio === 55
      && iva.persona_rfc === 'PRO010101AB2' && iva.persona_nombre === 'PROVEEDOR DE PRUEBA' && iva.cuenta === '1190-001', JSON.stringify(iva));
    t('la nota de crédito conserva su signo negativo (la vista no lo voltea)', Number(por.get(2).base) === -500 && Number(por.get(2).importe) === -80);
    t('IEPS a cuota, sin UUID → nulo', por.get(3).impuesto === 'IEPS' && por.get(3).tipo_factor === 'cuota' && por.get(3).cfdi_uuid === null);
    t('ISR retenido', por.get(4).impuesto === 'ISR' && por.get(4).tipo_movimiento === 'retencion');
    t('impuesto local con su nombre', por.get(5).impuesto === 'local' && por.get(5).nombre_local === 'ISH');
    t('«Otras Erogaciones» no es impuesto; sin persona → nulo', por.get(6).impuesto === 'otras_erogaciones' && por.get(6).persona_rfc === null);
    t('el código 0 sale como sin_clasificar en los tres campos', por.get(7).impuesto === 'sin_clasificar'
      && por.get(7).tipo_movimiento === 'sin_clasificar' && por.get(7).tipo_factor === 'sin_clasificar');
    t('IVA exento', por.get(8).impuesto === 'IVA' && por.get(8).tipo_factor === 'exento');
    t('no publica imptotal (no significa lo mismo en el IEPS)', !('total' in iva) && !('imptotal' in iva));

    await c.query('SAVEPOINT plan');
    await c.query('SET LOCAL enable_seqscan = off');
    const planU = (await q(`EXPLAIN SELECT * FROM analytics.v_contpaqi_impuesto_movimiento WHERE cfdi_uuid = '${U.toUpperCase()}'`)).map((r) => r['QUERY PLAN']).join('\n');
    const planP = (await q(`EXPLAIN SELECT * FROM analytics.v_contpaqi_impuesto_movimiento WHERE poliza_id = 10`)).map((r) => r['QUERY PLAN']).join('\n');
    await c.query('ROLLBACK TO SAVEPOINT plan');
    t('la búsqueda por UUID usa su índice', planU.includes('ix_cp93b_imp_uuid'), planU.slice(0, 300));
    t('la búsqueda por póliza usa su índice', planP.includes('ix_cp93b_imp_poliza'), planP.slice(0, 300));

    await migracion.up(knexLike);
    t('aplicarla otra vez no falla y da lo mismo', (await q(`SELECT count(*)::int n FROM analytics.v_contpaqi_impuesto_movimiento`))[0].n === 8);

    // ⛔ Prueba negativa: la tasa como FRACCIÓN. Ninguna fila dice «16»: una verificación que sólo mirara ésas pasaría.
    await c.query('SAVEPOINT neg');
    let msg = null;
    try {
      await c.query(`UPDATE contpaqi_ods.ct_movimientosimpuestos SET tasaocuota = tasaocuota / 100 WHERE impuesto = 2 AND tipofactor = 1`);
      await migracion.up(knexLike);
    } catch (e) { msg = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT neg');
    t('NEGATIVA: con la tasa en fracción (0.16) la migración aborta, no pasa en vacío', /no está en por ciento/.test(msg || ''), msg || 'no abortó');

    await migracion.down(knexLike);
    t('el down quita la vista', !(await vista()));
    t('el down quita los 2 índices', (await indices()) === 0, `n=${await indices()}`);
  } catch (e) {
    bad++;
    console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘`);
  process.exit(bad ? 1 : 0);
})();
