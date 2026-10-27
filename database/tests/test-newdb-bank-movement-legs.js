#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
/**
 * `[OPS-AUD.11.1]` (ADR-104) — La tabla de piernas de tesorería se mantiene por TRIGGER desde
 * `kepler_ods.kdm1`, y da EXACTAMENTE lo mismo que la vista vigente `analytics.kepler_bank_movements`.
 *
 * Aplica la migración `20261027124906` DENTRO de una transacción, siembra datos sintéticos en
 * `kdb1`/`kdm1` y al final hace ROLLBACK: la base queda como estaba.
 *
 * Qué prueba:
 *   · paridad fila por fila contra la vista vieja (las dos direcciones), en cada paso;
 *   · alta, cambio, cancelación (c43='C'), cambio de cuenta fuera del catálogo, baja, TRUNCATE;
 *   · traspaso con dos piernas, y con destino fuera del catálogo (una pierna);
 *   · reescritura idéntica: no toca la tabla (sin churn);
 *   · kdb1: quitar una clave borra sus piernas, devolverla las repone; reescribir kdb1 sin cambiar
 *     claves NO reconstruye;
 *   · ⛔ un error dentro del trigger NO frena el kdm1 y queda registrado;
 *   · ⛔ el árbitro (`bank_movement_legs_drift`) detecta una pierna borrada a mano (prueba negativa).
 *
 *   DATABASE_URL_NEW=postgresql://postgres:postgres@127.0.0.1:5432/postgres_platform \
 *     node database/tests/test-newdb-bank-movement-legs.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const URL = process.env.DATABASE_URL_NEW;
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-bank-movement-legs', { url: URL });
const { Client } = require('pg');
const migracion = require('../migrations-newdb/20261027124906_ops_aud11_bank_movement_legs.js');

let ok = 0, bad = 0;
const t = (name, cond, extra) => {
  if (cond) { ok++; console.log(`  ✔ ${name}`); }
  else { bad++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`); }
};

// Las columnas que la tabla guarda y la vista publica con el mismo significado.
const COLS = `sucursal, doc_tipo, folio, clave_banco, flujo, importe, signo, fecha_valor, fecha_captura,
  concepto, metodo, beneficiario, es_traspaso, contra_clave, pierna, entidad_code`;

(async () => {
  if (!URL) { console.error('falta DATABASE_URL_NEW'); process.exit(1); }
  const c = new Client({ connectionString: URL });
  await c.connect();
  const q = async (sql, b) => (await c.query(sql, b)).rows;
  // La migración espera un knex: con `raw` alcanza. Los `?` se traducen sólo si hay binds.
  const knexLike = {
    raw: (sql, binds) => {
      if (!binds) return c.query(sql);
      let i = 0;
      return c.query(sql.replace(/\?/g, () => `$${++i}`), binds);
    },
  };

  console.log('\n=== [OPS-AUD.11.1] piernas de tesorería mantenidas por trigger ===\n');
  await c.query('BEGIN');
  try {
    const hay = await q(`SELECT to_regclass('kepler_ods.kdm1') a, to_regclass('kepler_ods.kdb1') b,
                                to_regclass('analytics.kepler_bank_movements') v`);
    if (!hay[0].a || !hay[0].b || !hay[0].v) {
      console.log('  NO MEDIDO — esta base no tiene kdm1/kdb1/kepler_bank_movements');
      await c.query('ROLLBACK'); await c.end(); process.exit(0);
    }
    // Base limpia DENTRO de la transacción: lo que hubiera se revierte al final.
    await c.query('DELETE FROM kepler_ods.kdm1');
    await c.query('DELETE FROM kepler_ods.kdb1');

    await migracion.up(knexLike);
    const trg = await q(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tg_bml_%' AND NOT tgisinternal`);
    t('la migración crea los 8 triggers (4 en kdm1, 4 en kdb1)', trg[0].n === 8, `n=${trg[0].n}`);

    const paridad = async (etiqueta) => {
      const [r] = await q(`
        WITH v AS (SELECT ${COLS} FROM analytics.kepler_bank_movements),
             l AS (SELECT ${COLS} FROM analytics.bank_movement_legs)
        SELECT (SELECT count(*) FROM (SELECT * FROM v EXCEPT ALL SELECT * FROM l) a)::int AS faltan,
               (SELECT count(*) FROM (SELECT * FROM l EXCEPT ALL SELECT * FROM v) b)::int AS sobran,
               (SELECT count(*) FROM v)::int AS vista`);
      t(`${etiqueta}: igual a la vista vieja (vista=${r.vista})`, r.faltan === 0 && r.sobran === 0,
        `faltan=${r.faltan} sobran=${r.sobran}`);
      return r.vista;
    };
    const piernas = async (where = 'true') =>
      (await q(`SELECT count(*)::int n FROM analytics.bank_movement_legs WHERE ${where}`))[0].n;

    // ── Catálogo: caja, banco y una cuenta puente ──────────────────────────────
    await c.query(`INSERT INTO kepler_ods.kdb1 (sucursal, c1, c2, c3, c5) VALUES
      ('01','0011','CAJA GENERAL','EFECTIVO','1020001'),
      ('01','0201','BANBAJIO','','1020201'),
      ('01','9001','PUENTE','','2050001')`);

    // ── Alta de documentos ────────────────────────────────────────────────────
    const doc = (suc, c1, c2, c3, c4, folio, c45, extra = {}) => ({
      sucursal: suc, c1, c2, c3, c4, c5: 1, c6: folio, c45, c9: '2026-10-27', c68: '2026-10-27 10:00',
      c16: 1500, c24: `concepto ${folio}`, c31: null, c32: 'beneficiario', c10: 'E01', c43: null, c47: null, ...extra,
    });
    const filas = [
      doc('01', '01', 'X', 'A', 45, 'T1', '0011'),                                   // entrada a caja
      doc('01', '01', 'X', 'D', 26, 'T2', '0201', { c16: 2500.5 }),                 // salida de banco
      doc('01', '01', 'N', 'A', 26, 'T3', '0201', { c47: '0011', c16: 800 }),       // traspaso: 2 piernas
      doc('01', '01', 'X', 'A', 45, 'T4', '0011', { c43: 'C' }),                    // cancelado: nada
      doc('01', '01', 'X', 'A', 45, 'T5', '7777'),                                  // cuenta fuera del catálogo: nada
      doc('01', '02', 'X', 'A', 45, 'T6', '0011'),                                  // c1 ≠ sucursal: nada
      doc('01', '01', 'N', 'A', 26, 'T7', '0201', { c47: '8888' }),                 // destino fuera: 1 pierna
      doc('01', '01', 'Y', 'Z', 99, 'T8', '9001', { c31: 'Cob' }),                  // flujo por método (Cob)
    ];
    const campos = Object.keys(filas[0]);
    const valores = filas.map((f, i) => `(${campos.map((_, j) => `$${i * campos.length + j + 1}`).join(',')})`).join(',');
    await c.query(`INSERT INTO kepler_ods.kdm1 (${campos.join(',')}) VALUES ${valores}`,
      filas.flatMap((f) => campos.map((k) => f[k])));

    t('alta: 6 piernas (T1, T2, T3×2, T7, T8)', (await piernas()) === 6, `n=${await piernas()}`);
    t('traspaso T3: origen en banco y destino en caja',
      (await piernas(`folio='T3' AND pierna='origen' AND clave_banco='0201'`)) === 1
      && (await piernas(`folio='T3' AND pierna='destino' AND clave_banco='0011'`)) === 1);
    await paridad('alta');

    // ── Reescritura idéntica: no toca la tabla ────────────────────────────────
    const antes = await q(`SELECT id, xmin::text x FROM analytics.bank_movement_legs ORDER BY id`);
    await c.query(`UPDATE kepler_ods.kdm1 SET c16 = c16`);
    const despues = await q(`SELECT id, xmin::text x FROM analytics.bank_movement_legs ORDER BY id`);
    t('reescritura idéntica de TODO kdm1: ninguna pierna se reescribe (sin churn)',
      JSON.stringify(antes) === JSON.stringify(despues));

    // ── Cambios ───────────────────────────────────────────────────────────────
    await c.query(`UPDATE kepler_ods.kdm1 SET c16 = 1750.25 WHERE c6='T1'`);
    t('cambio de importe: la pierna refleja 1750.25',
      (await piernas(`folio='T1' AND importe=1750.25`)) === 1);
    await c.query(`UPDATE kepler_ods.kdm1 SET c43 = 'C' WHERE c6='T2'`);
    t('cancelación (c43=C): la pierna desaparece', (await piernas(`folio='T2'`)) === 0);
    await c.query(`UPDATE kepler_ods.kdm1 SET c45 = '7777' WHERE c6='T8'`);
    t('cuenta que sale del catálogo: la pierna desaparece', (await piernas(`folio='T8'`)) === 0);
    await c.query(`UPDATE kepler_ods.kdm1 SET c43 = NULL WHERE c6='T4'`);
    t('descancelación: la pierna aparece', (await piernas(`folio='T4'`)) === 1);
    await paridad('cambios');

    await c.query(`DELETE FROM kepler_ods.kdm1 WHERE c6='T3'`);
    t('baja de un traspaso: se van sus dos piernas', (await piernas(`folio='T3'`)) === 0);
    await paridad('baja');

    // ── kdb1 ──────────────────────────────────────────────────────────────────
    const idsAntes = await q(`SELECT id FROM analytics.bank_movement_legs ORDER BY id`);
    await c.query(`UPDATE kepler_ods.kdb1 SET c2 = c2 || ' (renombrada)' WHERE c1='0011'`);
    const idsDespues = await q(`SELECT id FROM analytics.bank_movement_legs ORDER BY id`);
    t('kdb1 cambia el NOMBRE (no la clave): no reconstruye (mismos ids)',
      idsAntes.length > 0 && JSON.stringify(idsAntes) === JSON.stringify(idsDespues));
    await paridad('kdb1 renombrada');
    await c.query(`DELETE FROM kepler_ods.kdb1 WHERE c1='0011'`);
    t('kdb1 pierde la clave 0011: se van las piernas de caja', (await piernas(`clave_banco='0011'`)) === 0);
    await paridad('kdb1 sin 0011');
    await c.query(`INSERT INTO kepler_ods.kdb1 (sucursal, c1, c2, c3, c5) VALUES ('01','0011','CAJA GENERAL','EFECTIVO','1020001')`);
    t('kdb1 recupera la clave: vuelven las piernas de caja', (await piernas(`clave_banco='0011'`)) > 0);
    await paridad('kdb1 restaurada');

    // ── ⛔ Prueba negativa del árbitro: una pierna borrada a mano se detecta ──
    const [d0] = await q(`SELECT * FROM analytics.bank_movement_legs_drift()`);
    t('árbitro en limpio: 0 faltan, 0 sobran', Number(d0.faltan) === 0 && Number(d0.sobran) === 0, JSON.stringify(d0));
    await c.query(`DELETE FROM analytics.bank_movement_legs WHERE id = (SELECT min(id) FROM analytics.bank_movement_legs)`);
    const [d1] = await q(`SELECT * FROM analytics.bank_movement_legs_drift()`);
    t('PRUEBA NEGATIVA árbitro: una pierna borrada a mano → faltan=1', Number(d1.faltan) === 1 && Number(d1.sobran) === 0, JSON.stringify(d1));
    const n = await q(`SELECT analytics.bank_movement_legs_rebuild() n`);
    const [d2] = await q(`SELECT * FROM analytics.bank_movement_legs_drift()`);
    t(`reconstruir lo repara (${n[0].n} piernas) → 0 y 0`, Number(d2.faltan) === 0 && Number(d2.sobran) === 0, JSON.stringify(d2));

    // ── ⛔ Un error dentro del trigger NO frena la ingesta ────────────────────
    await c.query(`ALTER TABLE analytics.bank_movement_legs ADD CONSTRAINT ck_prueba_falla CHECK (importe <> 999.99)`);
    await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal,c1,c2,c3,c4,c5,c6,c45,c16,c9)
                   VALUES ('01','01','X','A',45,1,'T9','0011',999.99,'2026-10-27')`);
    t('PRUEBA NEGATIVA error: el renglón de kdm1 SÍ se escribe',
      (await q(`SELECT count(*)::int n FROM kepler_ods.kdm1 WHERE c6='T9'`))[0].n === 1);
    const errs = await q(`SELECT tabla, operacion, sqlstate FROM analytics.bank_movement_legs_errors`);
    t('… y el error queda registrado (kdm1 · INSERT · 23514)',
      errs.length === 1 && errs[0].tabla === 'kdm1' && errs[0].operacion === 'INSERT' && errs[0].sqlstate === '23514',
      JSON.stringify(errs));
    const [d3] = await q(`SELECT * FROM analytics.bank_movement_legs_drift()`);
    t('… y el árbitro lo ve como 1 faltante', Number(d3.faltan) === 1, JSON.stringify(d3));
    await c.query(`ALTER TABLE analytics.bank_movement_legs DROP CONSTRAINT ck_prueba_falla`);
    await c.query(`DELETE FROM kepler_ods.kdm1 WHERE c6='T9'`);

    // ── Un escritor de kdm1 SIN permisos sobre la tabla de piernas ───────────
    await c.query(`CREATE ROLE bml_prueba_escritor NOLOGIN`);
    await c.query(`GRANT USAGE ON SCHEMA kepler_ods TO bml_prueba_escritor`);
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON kepler_ods.kdm1 TO bml_prueba_escritor`);
    await c.query(`SAVEPOINT rol`);
    await c.query(`SET ROLE bml_prueba_escritor`);
    await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal,c1,c2,c3,c4,c5,c6,c45,c16,c9)
                   VALUES ('01','01','X','A',45,1,'T10','0011',321,'2026-10-27')`);
    await c.query(`RESET ROLE`);
    t('un rol que sólo escribe kdm1 genera su pierna (los triggers son SECURITY DEFINER)',
      (await piernas(`folio='T10'`)) === 1);
    // ⛔ Negativa: con SECURITY INVOKER el mismo alta TUMBA la escritura de kdm1 (el registro del
    //    error también se queda sin permiso). Es la razón del SECURITY DEFINER.
    await c.query(`ALTER FUNCTION analytics.tg_kdm1_bank_movement_legs() SECURITY INVOKER`);
    await c.query(`SET ROLE bml_prueba_escritor`);
    let tumbo = false;
    try {
      await c.query(`INSERT INTO kepler_ods.kdm1 (sucursal,c1,c2,c3,c4,c5,c6,c45,c16,c9)
                     VALUES ('01','01','X','A',45,1,'T11','0011',322,'2026-10-27')`);
    } catch { tumbo = true; }
    await c.query(`ROLLBACK TO SAVEPOINT rol`);
    await c.query(`RESET ROLE`);
    t('PRUEBA NEGATIVA: con SECURITY INVOKER ese mismo alta SÍ se cae', tumbo);
    const sd = await q(`SELECT prosecdef FROM pg_proc WHERE oid = 'analytics.tg_kdm1_bank_movement_legs()'::regprocedure`);
    t('… y tras el ROLLBACK TO la función vuelve a ser SECURITY DEFINER', sd[0].prosecdef === true);
    await c.query(`DELETE FROM kepler_ods.kdm1 WHERE c6 IN ('T10','T11')`);

    // ── TRUNCATE ──────────────────────────────────────────────────────────────
    await c.query(`TRUNCATE kepler_ods.kdm1`);
    t('TRUNCATE de kdm1: la tabla de piernas queda vacía', (await piernas()) === 0);
    await paridad('truncate');

    // ── down deshace todo ─────────────────────────────────────────────────────
    await migracion.down(knexLike);
    const resto = await q(`SELECT to_regclass('analytics.bank_movement_legs') t,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname LIKE 'tg_bml_%') g,
      (SELECT count(*)::int FROM pg_proc WHERE proname IN ('kdm1_legs','bank_movement_legs_rebuild','bank_movement_legs_drift')) f`);
    t('down: sin tabla, sin triggers, sin funciones', !resto[0].t && resto[0].g === 0 && resto[0].f === 0, JSON.stringify(resto[0]));
  } catch (e) {
    bad++;
    console.log(`  ✘ excepción: ${e.message}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
  console.log(`\n${ok} ✔ · ${bad} ✘\n`);
  process.exit(bad ? 1 : 0);
})();
