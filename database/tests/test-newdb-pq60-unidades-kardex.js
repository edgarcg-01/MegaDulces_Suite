#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[PQ.60]` — Las unidades del kardex desde el último conteo se mantienen por TRIGGER desde
 * `kepler_ods.kdij`.
 *
 * Aplica la migración `20261104113800` DENTRO de una transacción, siembra kardex sintético que
 * reproduce los dos casos reales y al final hace ROLLBACK. Si la base no tiene `kepler_ods.kdij`
 * (el CI no trae ODS), la crea con su llave real — también dentro de la transacción.
 *
 * Qué prueba:
 *   · 97392 BON-BON: entra 708 «CJA», un conteo N-A-30 en PAQ, salen PAQ → desde el conteo sólo PAQ;
 *   · 48067 ZUKO: ventas en PZA y en PAQ sin conteo → dos unidades (existencia mezclada);
 *   · alta en otra unidad después del conteo → mezcla; un conteo nuevo → limpio otra vez;
 *   · cambio de rótulo de un renglón, baja de renglones, baja del último renglón (desaparece);
 *   · una sentencia que toca dos llaves recalcula las dos; TRUNCATE + recarga;
 *   · ⛔ prueba NEGATIVA: un error dentro del trigger NO frena el kdij y queda registrado;
 *   · `down()` deja la base sin rastro.
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-pq60-unidades-kardex.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq60-unidades-kardex', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261104113800_pq60_unidades_del_kardex_por_evento.js');

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
  // Un renglón de kardex: (sucursal, almacén, sku, doc 'X-A-40', folio, renglón, fecha, cantidad, unidad, E/S)
  let folio = 0;
  const mov = (suc, alm, sku, doc, fecha, cant, u, es) => {
    const [g, n, tp] = doc.split('-');
    folio++;
    return c.query(`INSERT INTO kepler_ods.kdij (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c30)
                    VALUES ($1, $2, 1, $3, $4, $5, $6, 1, $7, 1, $8, $9, $10, $11)`,
    [suc, alm, sku, g, n, Number(tp), String(folio).padStart(7, '0'), fecha, cant, u, es]);
  };
  const est = async (sku, suc = '00') => (await q(`SELECT unidades, netos, ultimo_conteo, movimientos FROM analytics.kardex_unit_state
                                                    WHERE sucursal = $1 AND almacen = $1 AND sku = $2`, [suc, sku]))[0];

  console.log('\n=== [PQ.60] unidades del kardex desde el último conteo, por trigger ===\n');
  await c.query('BEGIN');
  try {
    await c.query('CREATE SCHEMA IF NOT EXISTS kepler_ods');
    await c.query('CREATE SCHEMA IF NOT EXISTS analytics');
    if (!(await q(`SELECT to_regclass('kepler_ods.kdij') k`))[0].k) {
      await c.query(`CREATE TABLE kepler_ods.kdij (
        sucursal text NOT NULL, c1 text NOT NULL, c2 numeric NOT NULL, c3 text NOT NULL, c4 text NOT NULL,
        c5 text NOT NULL, c6 numeric NOT NULL, c7 numeric NOT NULL, c8 text NOT NULL, c9 numeric NOT NULL,
        c10 timestamp, c11 double precision, c12 text, c30 text,
        PRIMARY KEY (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9))`);
      console.log('  (kepler_ods.kdij no existía: creada con su llave real dentro de la transacción)');
    }
    await c.query('DELETE FROM kepler_ods.kdij');

    // Antes de la migración: los dos casos reales.
    await mov('00', '00', '97392', 'X-A-40', '2026-09-14 10:00', 708, 'CJA', 'E');
    await mov('00', '00', '97392', 'N-A-30', '2026-09-30 12:00', 16992, 'PAQ', 'E');
    await mov('00', '00', '97392', 'U-D-41', '2026-10-09 09:00', 2390, 'PAQ', 'S');
    await mov('00', '00', '48067', 'U-D-10', '2026-10-21 09:00', 8, 'PZA', 'S');
    await mov('00', '00', '48067', 'U-D-10', '2026-10-25 09:00', 1, 'PAQ', 'S');

    await migracion.up(knexLike);
    const trg = await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tg_kus_%' AND NOT tgisinternal`);
    t('la migración crea los 4 triggers en kdij', trg[0].n === 4, `n=${trg[0].n}`);

    let e = await est('97392');
    t('97392: desde el conteo sólo PAQ (la «CJA» de antes del conteo no cuenta)',
      e && e.unidades.join() === 'PAQ' && String(e.ultimo_conteo).length > 0, JSON.stringify(e));
    t('97392: neto PAQ desde el conteo = −2390 (sin el renglón del conteo)', e && Number(e.netos.PAQ) === -2390, JSON.stringify(e && e.netos));
    e = await est('48067');
    t('48067 ZUKO: sin conteo, PZA y PAQ → mezclada', e && e.unidades.join() === 'PAQ,PZA' && e.ultimo_conteo === null, JSON.stringify(e));

    // Alta en otra unidad después del conteo → mezcla
    await mov('00', '00', '97392', 'X-A-40', '2026-10-20 10:00', 10, 'CJA', 'E');
    e = await est('97392');
    t('alta en CJA después del conteo → 97392 mezclada (CJA, PAQ)', e && e.unidades.join() === 'CJA,PAQ', JSON.stringify(e));

    // Conteo nuevo → limpio
    await mov('00', '00', '97392', 'N-D-30', '2026-10-25 12:00', 5, 'PAQ', 'S');
    e = await est('97392');
    t('un conteo nuevo (N-D-30) → sin unidades desde entonces', e && e.unidades.length === 0 && e.movimientos === 0, JSON.stringify(e));

    // Cambio de rótulo (ZUKO corregido en el renglón)
    await c.query(`UPDATE kepler_ods.kdij SET c12 = 'PAQ' WHERE c3 = '48067' AND c12 = 'PZA'`);
    e = await est('48067');
    t('cambio de rótulo de un renglón → 48067 queda sólo en PAQ', e && e.unidades.join() === 'PAQ', JSON.stringify(e));

    // Una sentencia, dos llaves
    await c.query(`INSERT INTO kepler_ods.kdij (sucursal, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c30) VALUES
      ('01','01',1,'A-1','U','D',10,1,'9000001',1,'2026-11-01',3,'PZA','S'),
      ('01','01',1,'A-2','U','D',10,1,'9000001',2,'2026-11-01',1,'CJA','S'),
      ('01','01',1,'A-2','U','D',10,1,'9000001',3,'2026-11-01',4,'PZA','S')`);
    const a1 = await est('A-1', '01'); const a2 = await est('A-2', '01');
    t('una sentencia que toca dos llaves recalcula las dos', a1 && a1.unidades.join() === 'PZA' && a2 && a2.unidades.join() === 'CJA,PZA',
      JSON.stringify([a1, a2]));

    // Baja de renglones y del último
    await c.query(`DELETE FROM kepler_ods.kdij WHERE c3 = 'A-2' AND c12 = 'CJA'`);
    t('baja de un renglón → A-2 sólo PZA', (await est('A-2', '01')).unidades.join() === 'PZA');
    await c.query(`DELETE FROM kepler_ods.kdij WHERE c3 = 'A-2'`);
    t('baja del último renglón → la llave desaparece', (await est('A-2', '01')) === undefined);

    // TRUNCATE + recarga
    const filas = await q(`SELECT * FROM kepler_ods.kdij`);
    const antes = await q(`SELECT sucursal, almacen, sku, unidades FROM analytics.kardex_unit_state ORDER BY 1, 2, 3`);
    await c.query('TRUNCATE kepler_ods.kdij');
    t('TRUNCATE → estado vacío', Number((await q(`SELECT count(*) n FROM analytics.kardex_unit_state`))[0].n) === 0);
    for (const r of filas) {
      const cols = Object.keys(r);
      await c.query(`INSERT INTO kepler_ods.kdij (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, cols.map((k) => r[k]));
    }
    const despues = await q(`SELECT sucursal, almacen, sku, unidades FROM analytics.kardex_unit_state ORDER BY 1, 2, 3`);
    t('… y la recarga reconstruye el mismo estado', JSON.stringify(antes) === JSON.stringify(despues), `${JSON.stringify(antes)} vs ${JSON.stringify(despues)}`);

    // ⛔ Prueba negativa: el trigger falla y el kdij se escribe igual.
    await c.query(`ALTER TABLE analytics.kardex_unit_state ADD CONSTRAINT pq60_boom CHECK (sku <> 'BOOM')`);
    let paso = true;
    try { await mov('00', '00', 'BOOM', 'U-D-10', '2026-11-02', 1, 'PZA', 'S'); }
    catch (err) { paso = false; console.log('    (el INSERT falló:', err.message, ')'); }
    const enKdij = (await q(`SELECT 1 FROM kepler_ods.kdij WHERE c3 = 'BOOM'`)).length === 1;
    t('⛔ un error dentro del trigger NO frena el kdij', paso && enKdij);
    const errs = await q(`SELECT operacion, sqlstate FROM analytics.kardex_unit_state_errors`);
    t('… y queda registrado (INSERT, 23514)', errs.length === 1 && errs[0].operacion === 'INSERT' && errs[0].sqlstate === '23514', JSON.stringify(errs));
    await c.query(`ALTER TABLE analytics.kardex_unit_state DROP CONSTRAINT pq60_boom`);

    await migracion.down(knexLike);
    const resto = await q(`SELECT to_regclass('analytics.kardex_unit_state') e, (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'tg_kus_%') trg`);
    t('down() quita tabla y triggers', !resto[0].e && resto[0].trg === 0, JSON.stringify(resto[0]));
  } catch (err) {
    bad++; console.log('  ✘ excepción:', err.message);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined); // ya revertida o sin conexión: nada que deshacer
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘`);
  process.exit(bad ? 1 : 0);
})();
