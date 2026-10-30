#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[CP.9.3]` — Las vistas de control sobre la réplica de ContPAQi: qué CFDI está en qué póliza
 * (`analytics.v_contpaqi_cfdi_poliza`) y qué ejercicio está cerrado (`analytics.v_contpaqi_ejercicio`).
 *
 * Aplica la migración `20261030114159` DENTRO de una transacción, sobre tablas `contpaqi_ods.ct_*` sintéticas con las
 * columnas y tipos de la réplica real (medidos en prod el 2026-10-30), y al final hace ROLLBACK: la base queda como
 * estaba.
 *
 * Qué prueba:
 *   · sin la réplica, la migración no crea nada;
 *   · los tres caminos de asociación, a nivel movimiento y a nivel póliza, con el UUID y el GUID en cualquier caso y con
 *     espacios; las asociaciones sin destino, con GUID vacío o con UUID vacío quedan fuera;
 *   · un movimiento con GUID vacío no se liga con nada;
 *   · el ejercicio cerrado con su póliza de cierre y las pólizas que entraron después; el abierto, sin ellas;
 *   · los índices sirven a la vista: con `enable_seqscan = off` la búsqueda por UUID los usa;
 *   · aplicarla dos veces da lo mismo;
 *   · ⛔ prueba negativa: un GUID de movimiento repetido (multiplicaría filas) y un ejercicio «cerrado» cuya póliza de
 *     cierre no es del periodo 14 hacen que la migración ABORTE;
 *   · el `down` quita las dos vistas y los diez índices.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-contpaqi-vistas-control.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-contpaqi-vistas-control', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261030114159_cp93_vistas_de_control_contpaqi.js');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

// Las columnas que usan las vistas, con los tipos de la réplica en prod (information_schema, 2026-10-30).
const TABLAS = {
  ct_asoccfdis: 'id integer PRIMARY KEY, uuid text, guidref text, apptype text',
  ct_asocdoctosadministrativos: 'id integer PRIMARY KEY, uuid text, guidpoliza text',
  ct_asoccfdinodosdepago: 'id integer PRIMARY KEY, uuidrep text, guidreferencia text, aplicationtype text, numnodopago integer',
  ct_movimientospoliza: 'id integer PRIMARY KEY, guid text, idpoliza integer, nummovto integer, idcuenta integer, tipomovto boolean, importe double precision',
  ct_polizas: 'id integer PRIMARY KEY, guid text, ejercicio integer, periodo integer, tipopol integer, folio integer, fecha timestamp, concepto text',
  ct_cuentas: 'id integer PRIMARY KEY, codigo text, nombre text',
  ct_ejercicios: 'id integer PRIMARY KEY, ejercicio integer, fecinieje timestamp, fecfineje timestamp, periodos integer, idpolcierre integer',
};
const G = (n) => `0000000${n}-AAAA-BBBB-CCCC-000000000000`.slice(-36);

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const knexLike = { raw: (sql) => c.query(sql) };
  const vistas = async () => (await q(`SELECT to_regclass('analytics.v_contpaqi_cfdi_poliza') a, to_regclass('analytics.v_contpaqi_ejercicio') b`))[0];
  const indices = async () => (await q(`SELECT count(*)::int n FROM pg_indexes WHERE schemaname = 'contpaqi_ods' AND indexname LIKE 'ix_cp93_%'`))[0].n;
  const falla = async (etiqueta, fn) => {
    await c.query('SAVEPOINT neg');
    let msg = null;
    try { await fn(); await migracion.up(knexLike); } catch (e) { msg = e.message; }
    await c.query('ROLLBACK TO SAVEPOINT neg');
    return msg;
  };

  console.log('\n=== [CP.9.3] vistas de control sobre la réplica de ContPAQi ===\n');
  await c.query('BEGIN');
  try {
    const hay = await q(`SELECT to_regclass('contpaqi_ods.ct_asoccfdis') r`);
    if (!(await q(`SELECT 1 FROM pg_namespace WHERE nspname = 'analytics'`)).length) {
      console.log('  NO MEDIDO — esta base no tiene el schema analytics');
      await c.query('ROLLBACK'); await c.end(); process.exit(0);
    }
    // Sin réplica: la migración no crea nada (sólo se puede ver si la base no trae ya las tablas).
    if (!hay[0].r) {
      await migracion.up(knexLike);
      const v = await vistas();
      t('sin la réplica, la migración no crea ninguna vista', !v.a && !v.b);
    } else console.log('  · NO MEDIDO «sin réplica»: esta base ya trae contpaqi_ods.ct_asoccfdis');

    await c.query('CREATE SCHEMA IF NOT EXISTS contpaqi_ods');
    for (const [tabla, cols] of Object.entries(TABLAS)) {
      await c.query(`CREATE TABLE IF NOT EXISTS contpaqi_ods.${tabla} (${cols})`);
      await c.query(`DELETE FROM contpaqi_ods.${tabla}`);
    }
    // Pólizas: P1 egresos oct-2026 · P2 egresos oct-2026 · P3 la de cierre 2024 (periodo 14) · P4/P5 de 2024 DESPUÉS del
    // cierre · P6 de 2024 ANTES · P7 una de periodo 5 (para la prueba negativa del cierre).
    await c.query(`INSERT INTO contpaqi_ods.ct_polizas VALUES
      (10, '${G(1)}', 2026, 10, 2, 5, '2026-10-07', ' PAGO PROVEEDOR '),
      (11, lower('${G(2)}'), 2026, 10, 2, 6, '2026-10-08', 'GASTO'),
      (20, '${G(3)}', 2024, 14, 3, 1000, '2024-12-31', 'POLIZA ANUAL DE RESULTADOS'),
      (21, '${G(4)}', 2024, 12, 3, 7, '2024-12-31', 'AJUSTE'),
      (22, '${G(5)}', 2024, 12, 3, 8, '2024-12-31', 'AJUSTE'),
      (5, '${G(6)}', 2024, 11, 3, 1, '2024-11-30', 'ANTES DEL CIERRE'),
      (6, '${G(7)}', 2024, 5, 3, 2, '2024-05-31', 'DE MAYO')`);
    await c.query(`INSERT INTO contpaqi_ods.ct_cuentas VALUES (1, ' 5010-001 ', 'COMPRAS'), (2, '2120-001', 'PROVEEDORES')`);
    // Movimientos: M1 (cargo, importe con basura de float) y M3 de P1; M2 con GUID VACÍO (como la póliza de cierre de 2018);
    // M4 HUÉRFANO: su póliza (99) todavía no llega a la réplica, como puede pasar a media vuelta de la sincronía.
    await c.query(`INSERT INTO contpaqi_ods.ct_movimientospoliza VALUES
      (100, '${G(11)}', 10, 1, 1, false, 100.004),
      (101, '', 20, 1, 2, true, 50),
      (102, lower('${G(13)}'), 10, 2, 2, true, 100.004),
      (104, '${G(14)}', 99, 1, 1, false, 5)`);
    await c.query(`INSERT INTO contpaqi_ods.ct_asoccfdis VALUES
      (1, ' abc00001-0000-0000-0000-000000000001 ', lower('${G(11)}'), 'Contabilidad'),
      (2, 'ABC00002-0000-0000-0000-000000000002', '${G(2)}', 'Contabilidad'),
      (3, 'ABC00003-0000-0000-0000-000000000003', 'FFFFFFFF-0000-0000-0000-000000000000', 'Contabilidad'),
      (4, 'ABC00004-0000-0000-0000-000000000004', '', 'Contabilidad'),
      (5, '  ', '${G(1)}', 'Contabilidad'),
      (6, 'ABC00007-0000-0000-0000-000000000007', '${G(14)}', 'Contabilidad')`);
    await c.query(`INSERT INTO contpaqi_ods.ct_asocdoctosadministrativos VALUES (1, 'abc00002-0000-0000-0000-000000000002', '${G(2)}')`);
    await c.query(`INSERT INTO contpaqi_ods.ct_asoccfdinodosdepago VALUES (1, 'ABC00006-0000-0000-0000-000000000006', '${G(13)}', 'Contabilidad      ', 1)`);
    await c.query(`INSERT INTO contpaqi_ods.ct_ejercicios VALUES
      (25, 2024, '2024-01-01', '2024-12-31', 12, 20),
      (29, 2025, '2025-01-01', '2025-12-31', 12, 0)`);

    await migracion.up(knexLike);
    const v = await vistas();
    t('crea las dos vistas', !!v.a && !!v.b);
    t('crea los 10 índices de la réplica', (await indices()) === 10, `n=${await indices()}`);

    const filas = await q(`SELECT * FROM analytics.v_contpaqi_cfdi_poliza ORDER BY origen, cfdi_uuid`);
    t('4 asociaciones con destino (fuera: sin destino, GUID vacío, UUID vacío y la del movimiento huérfano, sin abortar)',
      filas.length === 4 && !filas.some((f) => f.cfdi_uuid === 'ABC00007-0000-0000-0000-000000000007'), `n=${filas.length}`);
    const a1 = filas.find((f) => f.origen === 'asoc_cfdis' && f.cfdi_uuid === 'ABC00001-0000-0000-0000-000000000001');
    t('UUID y GUID en minúsculas y con espacios: se normalizan y ligan al MOVIMIENTO', a1 && a1.nivel === 'movimiento'
      && a1.poliza_id === 10 && a1.num_movto === 1, JSON.stringify(a1));
    t('el movimiento trae su cuenta sin espacios, cargo y el importe a 2 decimales', a1 && a1.cuenta === '5010-001'
      && a1.cargo_abono === 'C' && Number(a1.importe) === 100 && String(a1.importe) === '100.00', JSON.stringify(a1 && { c: a1.cuenta, ca: a1.cargo_abono, i: a1.importe }));
    t('la póliza trae ejercicio, periodo, tipo, folio y concepto sin espacios', a1 && a1.ejercicio === 2026 && a1.periodo === 10
      && a1.tipo_pol === 2 && a1.folio === 5 && a1.concepto === 'PAGO PROVEEDOR');
    const a2 = filas.find((f) => f.origen === 'asoc_cfdis' && f.cfdi_uuid === 'ABC00002-0000-0000-0000-000000000002');
    t('GUID de la PÓLIZA (en otro caso de letra): nivel póliza, sin movimiento', a2 && a2.nivel === 'poliza' && a2.poliza_id === 11
      && a2.num_movto === null && a2.cargo_abono === null && a2.importe === null, JSON.stringify(a2));
    const d1 = filas.find((f) => f.origen === 'documento_administrativo');
    t('documento administrativo: UUID normalizado, a la póliza', d1 && d1.cfdi_uuid === 'ABC00002-0000-0000-0000-000000000002'
      && d1.nivel === 'poliza' && d1.poliza_id === 11);
    const n1 = filas.find((f) => f.origen === 'nodo_de_pago');
    t('nodo de pago: al movimiento, abono, con su número de nodo y la app sin relleno', n1 && n1.nivel === 'movimiento'
      && n1.num_movto === 2 && n1.cargo_abono === 'A' && n1.num_nodo_pago === 1 && n1.app === 'Contabilidad', JSON.stringify(n1));
    t('nada liga con el movimiento de GUID vacío', !filas.some((f) => f.poliza_id === 20));
    t('tenant de la empresa en todas', filas.every((f) => f.tenant_id === '00000000-0000-0000-0000-00000000d01c'));

    const ej = await q(`SELECT * FROM analytics.v_contpaqi_ejercicio ORDER BY ejercicio`);
    const e24 = ej.find((e) => e.ejercicio === 2024);
    const e25 = ej.find((e) => e.ejercicio === 2025);
    t('2024 cerrado, con su póliza de cierre del periodo 14', e24 && e24.cerrado === true && e24.poliza_cierre_id === 20
      && e24.poliza_cierre_periodo === 14 && e24.poliza_cierre_folio === 1000, JSON.stringify(e24));
    t('2024: 2 pólizas entraron después del cierre (Id mayor), no la de antes', e24 && e24.polizas_despues_del_cierre === 2,
      `n=${e24 && e24.polizas_despues_del_cierre}`);
    t('2025 abierto, sin póliza de cierre ni conteo', e25 && e25.cerrado === false && e25.poliza_cierre_id === null
      && e25.polizas_despues_del_cierre === null, JSON.stringify(e25));

    // Los índices sirven a la vista: con el recorrido secuencial apagado, la búsqueda por UUID los usa.
    await c.query('SAVEPOINT plan');
    await c.query('SET LOCAL enable_seqscan = off');
    const plan = (await q(`EXPLAIN SELECT * FROM analytics.v_contpaqi_cfdi_poliza WHERE cfdi_uuid = 'ABC00001-0000-0000-0000-000000000001'`))
      .map((r) => r['QUERY PLAN']).join('\n');
    await c.query('ROLLBACK TO SAVEPOINT plan');
    t('la búsqueda por UUID usa los índices de las tres fuentes y el del GUID del movimiento',
      ['ix_cp93_asoc_uuid', 'ix_cp93_docadm_uuid', 'ix_cp93_nodo_uuid', 'ix_cp93_mov_guid'].every((i) => plan.includes(i)), plan.slice(0, 400));

    await migracion.up(knexLike);
    t('aplicarla otra vez no falla y da lo mismo', (await q(`SELECT count(*)::int n FROM analytics.v_contpaqi_cfdi_poliza`))[0].n === 4);

    // ⛔ Pruebas negativas: la verificación de la migración tiene que ABORTAR.
    const m1 = await falla('guid repetido', () => c.query(`INSERT INTO contpaqi_ods.ct_movimientospoliza VALUES (103, '${G(11)}', 11, 9, 1, false, 1)`));
    t('NEGATIVA: un GUID de movimiento repetido (duplicaría la asociación) aborta la migración', /otro camino/.test(m1 || ''), m1 || 'no abortó');
    const m2 = await falla('cierre sin testigo', () => c.query(`UPDATE contpaqi_ods.ct_ejercicios SET idpolcierre = 6 WHERE ejercicio = 2024`));
    t('NEGATIVA: un «cierre» cuya póliza es del periodo 5 aborta la migración', /no tienen su póliza de cierre/.test(m2 || ''), m2 || 'no abortó');
    const m3 = await falla('cierre de otro ejercicio', () => c.query(`UPDATE contpaqi_ods.ct_ejercicios SET idpolcierre = 20 WHERE ejercicio = 2025`));
    t('NEGATIVA: un «cierre» que apunta a la póliza de OTRO ejercicio aborta la migración', /no tienen su póliza de cierre/.test(m3 || ''), m3 || 'no abortó');

    await migracion.down(knexLike);
    const vd = await vistas();
    t('el down quita las dos vistas', !vd.a && !vd.b);
    t('el down quita los 10 índices', (await indices()) === 0, `n=${await indices()}`);
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
