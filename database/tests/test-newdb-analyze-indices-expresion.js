#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[CP.9.3c]` — `analyzeIndicesSinEstadisticas` (`database/importers/lib/analyze-if-stale.js`): un índice de EXPRESIÓN
 * creado después de la carga deja ciego al planificador hasta que un ANALYZE junta las estadísticas de la expresión.
 *
 * Reproduce el caso de prod con las migraciones REALES de CP.9.3 (`20261030114159`) y CP.9.3b (`20261030121451`) sobre
 * tablas `contpaqi_ods` sintéticas, dentro de una transacción que termina en ROLLBACK: la base queda como estaba.
 *
 * Qué prueba:
 *   · CONTROL, con respuesta conocida: con las tablas analizadas ANTES de crear los índices (como las dejó en prod el
 *     autoanalyze de la carga), un UUID se estima en el 0.5 % de la tabla —300 de 60,000; en prod fueron 4,999 de
 *     999,786— y la búsqueda por UUID de la consulta del dictamen recorre la tabla entera;
 *   · la función analiza exactamente las tablas con índices de expresión sin estadísticas; después el UUID se estima en
 *     pocas filas y el plan usa el índice SIN forzar nada. ⛔ La prueba de CP.9.3 apagaba `enable_seqscan`: probaba que
 *     el índice SE PUEDE usar, no que el planificador lo ELIGE, y por eso no vio esto;
 *   · una segunda vuelta no analiza nada: la sincronía no repite el ANALYZE en cada vuelta;
 *   · una tabla vacía se analiza una vez y no queda como pendiente; una expresión siempre nula no deja falsa alarma;
 *   · ⛔ NEGATIVA: un rol que no es dueño no puede analizar (ANALYZE sólo avisa) y la función lo DICE en `siguenSin`;
 *   · un nombre de schema inválido se rechaza.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-analyze-indices-expresion.js
 */
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-analyze-indices-expresion', { url: URL });
const { Client } = require('pg');
const { analyzeIndicesSinEstadisticas } = require('../importers/lib/analyze-if-stale');
const cp93 = require('../migrations-newdb/20261030114159_cp93_vistas_de_control_contpaqi.js');
const cp93b = require('../migrations-newdb/20261030121451_cp93b_impuestos_por_movimiento_contpaqi.js');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

// Las columnas que usan las dos migraciones, con los tipos de la réplica en prod (los de sus propias pruebas).
const TABLAS = {
  ct_asoccfdis: 'id integer PRIMARY KEY, uuid text, guidref text, apptype text',
  ct_asocdoctosadministrativos: 'id integer PRIMARY KEY, uuid text, guidpoliza text',
  ct_asoccfdinodosdepago: 'id integer PRIMARY KEY, uuidrep text, guidreferencia text, aplicationtype text, numnodopago integer',
  ct_movimientospoliza: 'id integer PRIMARY KEY, guid text, idpoliza integer, nummovto integer, idcuenta integer, tipomovto boolean, importe double precision',
  ct_polizas: 'id integer PRIMARY KEY, guid text, ejercicio integer, periodo integer, tipopol integer, folio integer, fecha timestamp, concepto text',
  ct_cuentas: 'id integer PRIMARY KEY, codigo text, nombre text',
  ct_ejercicios: 'id integer PRIMARY KEY, ejercicio integer, fecinieje timestamp, fecfineje timestamp, periodos integer, idpolcierre integer',
  ct_movimientosimpuestos: `id integer PRIMARY KEY, idpoliza integer, nummovto integer, idpersona integer, idcuenta integer,
    uuid text, ejercicioasignado integer, periodoasignado integer, impuesto integer, nombreimplocal text,
    tipomovimiento integer, tipofactor integer, tasaocuota double precision, impbase double precision,
    impimpuesto double precision, imptotal double precision, ivanoacred double precision, aplicaimpuesto boolean,
    desglosado boolean`,
  ct_personas: 'id integer PRIMARY KEY, rfc text, nombre text',
};
/** Las tablas que llevan los nueve índices de expresión de CP.9.3 y CP.9.3b. */
const CON_INDICE_DE_EXPRESION = ['ct_asoccfdinodosdepago', 'ct_asoccfdis', 'ct_asocdoctosadministrativos',
  'ct_movimientospoliza', 'ct_movimientosimpuestos', 'ct_polizas'];
/** Filas de asociaciones y de movimientos: con el 0.5 % por defecto, un UUID se estima en 300. */
const N = 60000;
const TENANT = '00000000-0000-0000-0000-00000000d01c';
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
/** Cada UUID de asociación está dos veces (`md5('u' || i / 2)`): 300 de ellos, como un mes que revisa el dictamen. */
const UUIDS = Array.from({ length: 300 }, (_, i) => md5(`u${i * 97 + 5}`).toUpperCase());
const SQL_DICTAMEN = `SELECT cfdi_uuid FROM analytics.v_contpaqi_cfdi_poliza WHERE tenant_id = $1 AND cfdi_uuid = ANY($2) AND tipo_pol = 2`;

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const run = (sql) => c.query(sql);
  const knexLike = { raw: (sql) => c.query(sql) };
  const callado = { log: () => undefined };
  const estima = async (uuid) => (await q(`EXPLAIN (FORMAT JSON) SELECT 1 FROM contpaqi_ods.ct_asoccfdis WHERE upper(btrim(uuid)) = $1`,
    [uuid]))[0]['QUERY PLAN'][0].Plan['Plan Rows'];
  const plan = async () => (await q(`EXPLAIN ${SQL_DICTAMEN}`, [TENANT, UUIDS])).map((r) => r['QUERY PLAN']).join('\n');

  console.log('\n=== [CP.9.3c] ANALYZE de los índices de expresión de la réplica ===\n');
  await c.query('BEGIN');
  try {
    if (!(await q(`SELECT 1 FROM pg_namespace WHERE nspname = 'analytics'`)).length) {
      console.log('  NO MEDIDO — esta base no tiene el schema analytics');
      await c.query('ROLLBACK'); await c.end(); process.exit(0);
    }
    await c.query('CREATE SCHEMA IF NOT EXISTS contpaqi_ods');
    for (const [tabla, cols] of Object.entries(TABLAS)) {
      await c.query(`CREATE TABLE IF NOT EXISTS contpaqi_ods.${tabla} (${cols})`);
      await c.query(`DELETE FROM contpaqi_ods.${tabla}`);
    }
    await c.query(`INSERT INTO contpaqi_ods.ct_polizas SELECT i, md5('p' || i), 2026, 1 + i % 12, 2 + i % 2, i,
      '2026-01-01'::timestamp + (i % 300) * interval '1 day', 'POLIZA ' || i FROM generate_series(1, 6000) i`);
    await c.query(`INSERT INTO contpaqi_ods.ct_movimientospoliza SELECT i, md5('m' || i), 1 + i % 6000, 1 + i / 6000, 1, i % 2 = 0, i * 1.5
      FROM generate_series(1, ${N}) i`);
    await c.query(`INSERT INTO contpaqi_ods.ct_asoccfdis SELECT i, md5('u' || i / 2), md5('m' || i), 'Contabilidad' FROM generate_series(1, ${N}) i`);
    await c.query(`INSERT INTO contpaqi_ods.ct_asocdoctosadministrativos SELECT i, md5('d' || i), md5('p' || (1 + i % 6000)) FROM generate_series(1, 3000) i`);
    await c.query(`INSERT INTO contpaqi_ods.ct_asoccfdinodosdepago SELECT i, md5('n' || i), md5('m' || i * 7), 'Contabilidad', 1 FROM generate_series(1, 2000) i`);
    await c.query(`INSERT INTO contpaqi_ods.ct_movimientosimpuestos SELECT i, 1 + i % 6000, 1, 1, 1, md5('u' || i), 2026, 1, 2, NULL, 1, 1,
      16, 100, 16, 116, 0, true, false FROM generate_series(1, 20000) i`);
    await c.query(`INSERT INTO contpaqi_ods.ct_cuentas VALUES (1, '5010-001', 'COMPRAS')`);
    await c.query(`INSERT INTO contpaqi_ods.ct_personas VALUES (1, NULL, 'PERSONA')`);
    // Como en prod: autovacuum analizó las tablas después de la carga, y los índices se crearon DESPUÉS.
    await c.query(`ANALYZE ${Object.keys(TABLAS).map((x) => `contpaqi_ods.${x}`).join(', ')}`);
    await cp93.up(knexLike);
    await cp93b.up(knexLike);
    // Una tabla vacía y una cuya expresión siempre es nula, las dos con índice de expresión.
    await c.query('CREATE TABLE contpaqi_ods.zz_vacia (id integer, v text)');
    await c.query('CREATE INDEX zz_vacia_ix ON contpaqi_ods.zz_vacia (upper(v))');
    await c.query(`CREATE TABLE contpaqi_ods.zz_nulos (id integer, v text)`);
    await c.query(`INSERT INTO contpaqi_ods.zz_nulos SELECT i, '' FROM generate_series(1, 500) i`);
    await c.query(`CREATE INDEX zz_nulos_ix ON contpaqi_ods.zz_nulos (NULLIF(v, ''))`);

    const uuid = md5(`u${1234}`).toUpperCase();
    const antes = await estima(uuid);
    t('CONTROL: sin estadísticas de la expresión, un UUID se estima en el 0.5 % de la tabla (300 de 60,000)', antes === 300, `estima ${antes}`);
    const planAntes = await plan();
    t('CONTROL: así, la búsqueda por UUID de la consulta del dictamen recorre ct_asoccfdis entera',
      /Seq Scan on ct_asoccfdis\b/.test(planAntes), planAntes.slice(0, 300));

    t('un schema con nombre inválido se rechaza', await analyzeIndicesSinEstadisticas(run, 'contpaqi_ods; DROP', callado)
      .then(() => false, (e) => /inválido/.test(e.message)));

    // ⛔ NEGATIVA: un rol que no es dueño. ANALYZE no falla —avisa y se salta la tabla—, así que la función tiene que decirlo.
    await c.query('SAVEPOINT neg');
    let neg;
    try {
      await c.query('CREATE ROLE zz_cp93c_sin_dueno NOLOGIN');
      await c.query('GRANT USAGE ON SCHEMA contpaqi_ods TO zz_cp93c_sin_dueno');
      await c.query('GRANT SELECT ON ALL TABLES IN SCHEMA contpaqi_ods TO zz_cp93c_sin_dueno');
      await c.query('SET LOCAL ROLE zz_cp93c_sin_dueno');
      neg = await analyzeIndicesSinEstadisticas(run, 'contpaqi_ods', callado);
    } catch (e) { neg = { error: e.message }; }
    await c.query('ROLLBACK TO SAVEPOINT neg');
    t('NEGATIVA: sin ser dueño no analiza, y lo dice: ct_asoccfdis sigue sin estadísticas y no se reporta como analizada',
      !neg.error && neg.siguenSin.includes('ct_asoccfdis') && !neg.analizadas.includes('ct_asoccfdis'), JSON.stringify(neg));
    t('NEGATIVA: después de ella el UUID se sigue estimando en 300 (no analizó nada a escondidas)', (await estima(uuid)) === 300);

    const r1 = await analyzeIndicesSinEstadisticas(run, 'contpaqi_ods', callado);
    const esperadas = [...CON_INDICE_DE_EXPRESION, 'zz_nulos', 'zz_vacia'].sort();
    t('analiza exactamente las tablas con índices de expresión sin estadísticas (las 6 de CP.9.3 + la vacía + la de nulos)',
      JSON.stringify([...r1.analizadas].sort()) === JSON.stringify(esperadas), JSON.stringify(r1));
    t('ninguna queda pendiente: ni la vacía ni la de la expresión siempre nula', r1.siguenSin.length === 0, JSON.stringify(r1.siguenSin));

    const despues = await estima(uuid);
    t('con las estadísticas de la expresión el UUID se estima en pocas filas (hay 2)', despues <= 5, `estima ${despues}`);
    const planDespues = await plan();
    t('la búsqueda por UUID usa el índice SIN forzar nada (enable_seqscan encendido) y ya no recorre ct_asoccfdis',
      !/Seq Scan on ct_asoccfdis\b/.test(planDespues) && planDespues.includes('ix_cp93_asoc_uuid'), planDespues.slice(0, 400));

    const r2 = await analyzeIndicesSinEstadisticas(run, 'contpaqi_ods', callado);
    t('una segunda vuelta no analiza nada', r2.analizadas.length === 0 && r2.siguenSin.length === 0, JSON.stringify(r2));
  } catch (e) {
    bad++;
    console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘`);
  process.exit(bad ? 1 : 0);
})();
