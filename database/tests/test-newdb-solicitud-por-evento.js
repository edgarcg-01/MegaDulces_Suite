#!/usr/bin/env node
'use strict';
/**
 * `[PGP.122]` R1 por evento — el disparador de `kepler_ods.kdm1` que avisa `solicitud_gasto_kepler` (migración
 * 20261118085331). Ejerce el `up()` REAL y escucha con una conexión aparte. Los avisos sólo salen al CONFIRMAR, así que
 * esta prueba confirma de verdad: siembra con la sucursal `ZZ` (que ninguna réplica usa) y la borra al final; si la
 * tabla no existía, la crea con lo mínimo y la quita; deja el disparador como lo encontró.
 *
 *   A. Alta de una X-A-15 con la marca de la Suite → UN aviso `alta` (un lote de 3 filas es UN aviso: por sentencia).
 *   B. ⭐ Lo que NO avisa: X-A-15 con otra marca, X-A-10 con la marca, X-A-15 serie 2, y un UPDATE que no cambia c43.
 *   C. La cancelación (`c43` A → C) → `cambio`; y escrita como la ingesta (INSERT … ON CONFLICT DO UPDATE … WHERE IS
 *      DISTINCT FROM), también.
 *   D. ⭐ PRUEBA NEGATIVA: con `down()`, la misma alta NO avisa (el aviso lo da el disparador y no otra cosa).
 *   E. `up()` dos veces: dos disparadores, no cuatro.
 *   F. Lo que le cuesta a un lote de la ingesta (2,000 filas que NO son de la Suite), con y sin el disparador.
 *
 * NO MEDIDO aquí: que la escritura pase cuando el disparador falla (no hay forma barata de hacerlo fallar sin cambiar su
 * código; atrapa el error y avisa con WARNING), y la ingesta real de prod.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/t_pgp122_evento \
 *     node database/tests/test-newdb-solicitud-por-evento.js
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-solicitud-por-evento', { url: URL });
const { Client } = require('pg');
const mig = require('../migrations-newdb/20261118085331_pgp122_solicitud_por_evento.js');

let ok = 0; let mal = 0;
const check = (cond, msg) => { if (cond) { ok++; console.log(`  ✔ ${msg}`); } else { mal++; console.log(`  ✘ ${msg}`); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!URL) { console.log('NO MEDIDO: sin DATABASE_URL_NEW'); process.exit(2); }
  const db = new Client({ connectionString: URL });
  const oido = new Client({ connectionString: URL });
  await db.connect(); await oido.connect();
  // El `up()` habla con knex.raw: un envoltorio sobre la misma conexión (cada sentencia se confirma sola).
  const knex = { raw: (sql, params) => db.query(sql, params) };

  const avisos = [];
  oido.on('notification', (n) => { if (n.channel === mig.CANAL) avisos.push(n.payload); });
  await oido.query(`LISTEN ${mig.CANAL}`);
  const recibir = async () => { await espera(300); return avisos.splice(0); };

  const habia = (await db.query(`SELECT to_regclass('kepler_ods.kdm1') IS NOT NULL AS hay`)).rows[0].hay;
  const disparadoresAntes = habia ? (await db.query(
    `SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'kepler_ods.kdm1'::regclass AND tgname LIKE 'tg_solicitud_suite_%'`)).rows[0].n : 0;
  try {
    if (!habia) {
      await db.query(`CREATE SCHEMA IF NOT EXISTS kepler_ods`);
      await db.query(`CREATE TABLE kepler_ods.kdm1 (sucursal text, c1 text, c2 text, c3 text, c4 numeric, c5 numeric, c6 text,
        c26 text, c43 text, PRIMARY KEY (sucursal, c1, c2, c3, c4, c5, c6))`);
    }
    await db.query(`DELETE FROM kepler_ods.kdm1 WHERE sucursal = 'ZZ'`);
    await mig.up(knex);
    await recibir();
    const fila = (c4, c5, c6, c26, c43 = 'A') => db.query(
      `INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c26, c43) VALUES ('ZZ', 'ZZ', 'X', 'A', $1, $2, $3, $4, $5)`, [c4, c5, c6, c26, c43]);

    console.log('A. el alta de la Suite avisa');
    await fila(15, 1, '0000001', 'SUITE SG-0a1b2c3d');
    check(JSON.stringify(await recibir()) === '["alta"]', 'una X-A-15 con la marca → un aviso «alta»');
    await db.query(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c26, c43)
      SELECT 'ZZ', 'ZZ', 'X', 'A', 15, 1, lpad(g::text, 7, '0'), 'SUITE SG-' || g, 'A' FROM generate_series(2, 4) g`);
    check((await recibir()).length === 1, 'un lote de 3 es UN aviso (por sentencia, no por fila)');

    console.log('B. lo que no avisa');
    await fila(15, 1, '0000010', 'CAPTURA KEPLER');
    await fila(10, 1, '0000011', 'SUITE SG-ffffffff');
    await fila(15, 2, '0000012', 'SUITE SG-eeeeeeee');
    check((await recibir()).length === 0, 'otra marca, un X-A-10 con la marca, y la serie 2: cero avisos');
    await db.query(`UPDATE kepler_ods.kdm1 SET c43 = c43 WHERE sucursal = 'ZZ'`);
    check((await recibir()).length === 0, 'un UPDATE que no cambia c43 ni c26: cero avisos');

    console.log('C. la cancelación avisa');
    await db.query(`UPDATE kepler_ods.kdm1 SET c43 = 'C' WHERE sucursal = 'ZZ' AND c6 = '0000001'`);
    check(JSON.stringify(await recibir()) === '["cambio"]', 'c43 A → C → un aviso «cambio»');
    await db.query(`UPDATE kepler_ods.kdm1 SET c43 = 'C' WHERE sucursal = 'ZZ' AND c6 = '0000010'`);
    check((await recibir()).length === 0, 'cancelar una solicitud que NO es de la Suite: cero avisos');
    await db.query(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c26, c43)
      VALUES ('ZZ', 'ZZ', 'X', 'A', 15, 1, '0000002', 'SUITE SG-2', 'C')
      ON CONFLICT (sucursal, c1, c2, c3, c4, c5, c6) DO UPDATE SET c43 = EXCLUDED.c43, c26 = EXCLUDED.c26
      WHERE (kepler_ods.kdm1.c43, kepler_ods.kdm1.c26) IS DISTINCT FROM (EXCLUDED.c43, EXCLUDED.c26)`);
    check(JSON.stringify(await recibir()) === '["cambio"]', 'escrita como la ingesta (ON CONFLICT DO UPDATE): avisa «cambio»');

    console.log('E. up() dos veces');
    await mig.up(knex);
    const n = (await db.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'kepler_ods.kdm1'::regclass AND tgname LIKE 'tg_solicitud_suite_%'`)).rows[0].n;
    check(n === 2, `dos disparadores tras correrla dos veces (hay ${n})`);

    console.log('F. el costo para un lote de la ingesta (2,000 filas que no son de la Suite)');
    const lote = async (desde) => {
      const t = Date.now();
      await db.query(`INSERT INTO kepler_ods.kdm1 (sucursal, c1, c2, c3, c4, c5, c6, c26, c43)
        SELECT 'ZZ', 'ZZ', 'U', 'D', 40, 1, lpad(g::text, 7, '0'), 'VENTA', 'A' FROM generate_series($1::int, $1::int + 1999) g`, [desde]);
      return Date.now() - t;
    };
    const con = await lote(100000);

    console.log('D. PRUEBA NEGATIVA: sin el disparador no hay aviso');
    await mig.down(knex);
    await recibir();
    const sin = await lote(200000);
    await fila(15, 1, '0000099', 'SUITE SG-99999999');
    check((await recibir()).length === 0, 'con down(), la misma alta de la Suite: cero avisos');
    const quedan = (await db.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'kepler_ods.kdm1'::regclass AND tgname LIKE 'tg_solicitud_suite_%'`)).rows[0].n;
    const fn = (await db.query(`SELECT to_regprocedure('finance.tg_solicitud_suite_kdm1()') IS NOT NULL AS hay`)).rows[0].hay;
    check(quedan === 0 && !fn, 'down() quita los dos disparadores y la función');
    console.log(`  · 2,000 filas: ${con} ms con el disparador, ${sin} ms sin él (un dato, no una cota)`);
  } catch (e) {
    mal++; console.log(`  ✘ ${e.message}`);
  } finally {
    await db.query(`DELETE FROM kepler_ods.kdm1 WHERE sucursal = 'ZZ'`).catch(() => undefined);
    if (!habia) {
      await mig.down(knex).catch(() => undefined);
      await db.query(`DROP TABLE IF EXISTS kepler_ods.kdm1`).catch(() => undefined);
    } else if (disparadoresAntes > 0) {
      await mig.up(knex).catch(() => undefined); // estaba instalado: se deja instalado
    } else {
      await mig.down(knex).catch(() => undefined);
    }
    await oido.end(); await db.end();
  }
  console.log(`\n${ok} ✔ · ${mal} ✘`);
  process.exit(mal ? 1 : 0);
})();
