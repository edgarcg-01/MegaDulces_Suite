#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[PQ.59]` — La historia de la ficha de Kepler se mantiene por TRIGGER desde `kepler_ods.kdii`.
 *
 * Aplica la migración `20261104113213` DENTRO de una transacción, siembra fichas sintéticas y al
 * final hace ROLLBACK: la base queda como estaba. Si la base no tiene `kepler_ods.kdii` (el CI no
 * trae ODS), la crea con las columnas que la regla lee — también dentro de la transacción.
 *
 * Qué prueba:
 *   · la carga inicial: una fila `inicial` por ficha, y correr `up()` dos veces no duplica;
 *   · alta, cambio de factor, cambio de costo, baja y vuelta a nacer, cada uno con SU fila;
 *   · reescritura idéntica y cambio de una columna que NO se versiona: cero filas (sin churn);
 *   · TRUNCATE + recarga idéntica: cero filas;
 *   · dos cambios en UNA transacción quedan en orden y la vista de vigencia los encadena;
 *   · ⛔ prueba NEGATIVA: un error dentro del trigger NO frena el kdii y queda registrado;
 *   · `down()` deja la base sin rastro.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-pq59-historia-fichas.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq59-historia-fichas', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261104113213_pq59_historia_de_fichas_kepler.js');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  const knexLike = {
    raw: (sql, binds) => {
      if (!binds) return c.query(sql);
      let i = 0;
      return c.query(sql.replace(/\?/g, () => `$${++i}`), binds);
    },
  };
  const filas = async (sku) => q(`SELECT operacion, u3, f3, costo1 FROM analytics.kepler_ficha_history
                                  WHERE sucursal = '01' AND sku = $1 ORDER BY observado_at, id`, [sku]);
  const total = async () => Number((await q(`SELECT count(*) n FROM analytics.kepler_ficha_history`))[0].n);

  console.log('\n=== [PQ.59] historia de fichas mantenida por trigger ===\n');
  await c.query('BEGIN');
  try {
    await c.query('CREATE SCHEMA IF NOT EXISTS kepler_ods');
    await c.query('CREATE SCHEMA IF NOT EXISTS analytics');
    const hay = await q(`SELECT to_regclass('kepler_ods.kdii') k`);
    if (!hay[0].k) {
      await c.query(`CREATE TABLE kepler_ods.kdii (
        sucursal text NOT NULL, c1 text NOT NULL, c11 text, c77 text, c78 numeric, c79 numeric,
        c80 text, c81 numeric, c83 text, c84 numeric, c90 text, PRIMARY KEY (sucursal, c1))`);
      console.log('  (kepler_ods.kdii no existía: creada mínima dentro de la transacción)');
    }
    const tieneC90 = (await q(`SELECT 1 FROM information_schema.columns
                                WHERE table_schema='kepler_ods' AND table_name='kdii' AND column_name='c90'`)).length > 0;
    await c.query('DELETE FROM kepler_ods.kdii');
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c11, c77, c78, c79, c80, c81, c83, c84) VALUES
      ('01', 'T-1', 'PAQ', '31.97', 31.97, 319.70, 'PAQ', 1, 'CJA', 10),
      ('01', 'T-2', 'PZA', '2.47', 29.69, 356.31, 'PAQ', 12, 'CJA', 144)`);

    await migracion.up(knexLike);
    const trg = await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tg_kfh_%' AND NOT tgisinternal`);
    t('la migración crea los 3 triggers en kdii', trg[0].n === 3, `n=${trg[0].n}`);
    t('carga inicial: una fila «inicial» por ficha', (await total()) === 2, `n=${await total()}`);
    await migracion.up(knexLike);
    t('correr up() otra vez no duplica la carga inicial', (await total()) === 2, `n=${await total()}`);

    // Alta
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c11, c77, c78, c79, c80, c81, c83, c84)
                   VALUES ('01', 'T-3', 'PZA', '1.00', 0, 20, 'PZA', 1, 'CJA', 20)`);
    let f = await filas('T-3');
    t('alta: deja una fila «alta» con la caja', f.length === 1 && f[0].operacion === 'alta' && Number(f[0].f3) === 20, JSON.stringify(f));

    // Reescritura idéntica (lo que hace la reconciliación)
    const antes = await total();
    await c.query(`UPDATE kepler_ods.kdii SET c84 = c84, c77 = c77`);
    t('reescritura idéntica de TODAS las fichas: cero filas', (await total()) === antes, `${antes} -> ${await total()}`);

    // Columna que no se versiona
    if (tieneC90) {
      await c.query(`UPDATE kepler_ods.kdii SET c90 = '99.99' WHERE c1 = 'T-1'`);
      t('cambiar una columna que no se versiona (precio c90): cero filas', (await total()) === antes);
    }

    // Cambio de factor (el caso 97392: la caja eran 25, no 10)
    await c.query(`UPDATE kepler_ods.kdii SET c84 = 25 WHERE sucursal = '01' AND c1 = 'T-1'`);
    f = await filas('T-1');
    t('cambio de factor: fila «cambio» con la caja nueva', f.length === 2 && f[1].operacion === 'cambio' && Number(f[1].f3) === 25, JSON.stringify(f));

    // Cambio de costo (texto con formato: mismo valor = no cambia; valor distinto = cambia)
    await c.query(`UPDATE kepler_ods.kdii SET c77 = ' 31.970 ' WHERE c1 = 'T-1'`);
    t('mismo costo escrito distinto (« 31.970 »): cero filas', (await filas('T-1')).length === 2);
    await c.query(`UPDATE kepler_ods.kdii SET c77 = '33.10' WHERE c1 = 'T-1'`);
    f = await filas('T-1');
    t('cambio de costo base: fila «cambio» con 33.10', f.length === 3 && Number(f[2].costo1) === 33.10, JSON.stringify(f));

    // Baja y vuelta a nacer
    await c.query(`DELETE FROM kepler_ods.kdii WHERE c1 = 'T-2'`);
    f = await filas('T-2');
    t('baja: fila «baja»', f.length === 2 && f[1].operacion === 'baja', JSON.stringify(f));
    await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c11, c77, c78, c79, c80, c81, c83, c84)
                   VALUES ('01', 'T-2', 'PZA', '2.47', 29.69, 356.31, 'PAQ', 12, 'CJA', 144)`);
    f = await filas('T-2');
    t('vuelve a nacer igual que antes: fila «alta» (después de una baja sí cuenta)', f.length === 3 && f[2].operacion === 'alta', JSON.stringify(f));

    // TRUNCATE + recarga idéntica
    const fichas = await q(`SELECT * FROM kepler_ods.kdii`);
    const n0 = await total();
    await c.query('TRUNCATE kepler_ods.kdii');
    for (const r of fichas) {
      const cols = Object.keys(r);
      await c.query(`INSERT INTO kepler_ods.kdii (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map((k) => r[k]));
    }
    t('TRUNCATE + recarga idéntica: cero filas', (await total()) === n0, `${n0} -> ${await total()}`);

    // Dos cambios en la MISMA transacción, en orden, y la vigencia los encadena
    await c.query(`UPDATE kepler_ods.kdii SET c84 = 30 WHERE c1 = 'T-3'`);
    await c.query(`UPDATE kepler_ods.kdii SET c84 = 40 WHERE c1 = 'T-3'`);
    const v = await q(`SELECT f3, vigente_desde, vigente_hasta FROM analytics.v_kepler_ficha_vigencia
                        WHERE sucursal = '01' AND sku = 'T-3' ORDER BY vigente_desde`);
    t('dos cambios en una transacción: 3 versiones en orden (20 → 30 → 40)',
      v.length === 3 && v.map((x) => Number(x.f3)).join() === '20,30,40', JSON.stringify(v.map((x) => x.f3)));
    t('la vigencia encadena: «hasta» de cada versión = «desde» de la siguiente; la última abierta',
      v.length === 3 && +v[0].vigente_hasta === +v[1].vigente_desde && +v[1].vigente_hasta === +v[2].vigente_desde && v[2].vigente_hasta === null);

    // ⛔ Prueba negativa: el trigger falla y el kdii se escribe igual.
    await c.query(`ALTER TABLE analytics.kepler_ficha_history ADD CONSTRAINT pq59_boom CHECK (sku <> 'BOOM')`);
    let paso = true;
    try {
      await c.query(`INSERT INTO kepler_ods.kdii (sucursal, c1, c11, c77, c78, c79, c80, c81, c83, c84)
                     VALUES ('01', 'BOOM', 'PZA', '1', 1, 1, 'PZA', 1, 'PZA', 1)`);
    } catch (e) { paso = false; console.log('    (el INSERT falló:', e.message, ')'); }
    const enKdii = (await q(`SELECT 1 FROM kepler_ods.kdii WHERE c1 = 'BOOM'`)).length === 1;
    t('⛔ un error dentro del trigger NO frena el kdii', paso && enKdii);
    const errs = await q(`SELECT operacion, sqlstate FROM analytics.kepler_ficha_history_errors`);
    t('… y queda registrado (INSERT, 23514 check_violation)',
      errs.length === 1 && errs[0].operacion === 'INSERT' && errs[0].sqlstate === '23514', JSON.stringify(errs));
    await c.query(`ALTER TABLE analytics.kepler_ficha_history DROP CONSTRAINT pq59_boom`);

    // down()
    await migracion.down(knexLike);
    const resto = await q(`SELECT to_regclass('analytics.kepler_ficha_history') h, to_regclass('analytics.v_kepler_ficha_vigencia') v,
                                  (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'tg_kfh_%') trg`);
    t('down() quita tabla, vista y triggers', !resto[0].h && !resto[0].v && resto[0].trg === 0, JSON.stringify(resto[0]));
  } catch (e) {
    bad++; console.log('  ✘ excepción:', e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘`);
  process.exit(bad ? 1 : 0);
})();
