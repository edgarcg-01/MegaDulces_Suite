#!/usr/bin/env node
'use strict';
/**
 * `[CANON.6.6]` El `warehouse_id` se resuelve AL ESCRIBIR (migración 20261111160714), no con el barrido
 * nocturno. Contra una base real, dentro de una transacción que se revierte:
 *
 *   A. La regla (`commercial.warehouse_id_de`) y sus dos triggers, sobre tablas TEMPORALES con las mismas
 *      columnas: lote 1 por `warehouse_code` (code, kepler_code, con espacios), lote 2 por `sucursal`
 *      (además wincaja_source_branch); el `warehouse_id` que trae el escritor NO se pisa; un código
 *      desconocido o de otro tenant deja NULL y el renglón SÍ se escribe; un UPDATE que lo deja en NULL lo
 *      vuelve a resolver.
 *   B. El cableado: el trigger queda puesto en cada tabla viva de la migración que exista en esta base.
 *   PRUEBA NEGATIVA: sin el trigger, el mismo INSERT deja el almacén en NULL — si eso saliera resuelto,
 *   la prueba no estaría midiendo el trigger.
 *
 * Sin base: NO MEDIDO, nunca ✔.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-warehouse-id-al-escribir');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '99999999-6666-4000-8000-000000000066';
const MIG = require(path.join(__dirname, '../migrations-newdb', '20261111160714_canon66_warehouse_id_al_escribir.js'));
let pass = 0, fail = 0, nm = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };
const salir = () => { console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`); process.exit(fail ? 1 : (pass ? 0 : 2)); };

(async () => {
  console.log('\n[CANON.6.6] warehouse_id al escribir\n');
  let knex;
  try {
    knex = require('knex')(require('../knexfile-newdb.js').development);
    await knex.raw('SELECT 1');
  } catch (e) {
    noMedido(`sin base (${String(e.message).slice(0, 80)})`);
    if (knex) await knex.destroy().catch(() => {});
    return salir();
  }
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const hayWh = await trx.raw(`SELECT to_regclass('commercial.warehouses') AS t`);
      if (!hayWh.rows[0].t) { noMedido('no existe commercial.warehouses en esta base'); throw new Error('ROLLBACK'); }

      await MIG.up(trx);

      const wh = (await trx.raw(
        `INSERT INTO commercial.warehouses (tenant_id, code, name, kepler_code, wincaja_source_branch)
         VALUES (?, 'T66X', 'Almacén de prueba CANON.6.6', 'K66X', 'W66X') RETURNING id`, [T])).rows[0].id;

      // A. La regla, sobre tablas temporales con las columnas de los dos lotes.
      await trx.raw(`CREATE TEMP TABLE t66_codigo (tenant_id uuid, warehouse_code text, warehouse_id uuid, n int) ON COMMIT DROP`);
      await trx.raw(`CREATE TEMP TABLE t66_sucursal (tenant_id uuid, sucursal text, warehouse_id uuid, n int) ON COMMIT DROP`);
      await trx.raw(`CREATE TRIGGER trg_warehouse_id_al_escribir BEFORE INSERT OR UPDATE ON t66_codigo FOR EACH ROW EXECUTE FUNCTION commercial.tg_warehouse_id_por_codigo()`);
      await trx.raw(`CREATE TRIGGER trg_warehouse_id_al_escribir BEFORE INSERT OR UPDATE ON t66_sucursal FOR EACH ROW EXECUTE FUNCTION commercial.tg_warehouse_id_por_sucursal()`);
      const ya = '99999999-6666-4000-8000-0000000000aa';
      await trx.raw(`INSERT INTO t66_codigo VALUES (?, 'K66X', NULL, 1), (?, '  T66X ', NULL, 2), (?, 'W66X', NULL, 3), (?, 'ZZ99', NULL, 4), (?, 'K66X', NULL, 5), (?, 'K66X', ?, 6)`,
        [T, T, T, T, OTRO, T, ya]);
      await trx.raw(`INSERT INTO t66_sucursal VALUES (?, 'W66X', NULL, 1), (?, 'K66X', NULL, 2)`, [T, T]);
      const c = Object.fromEntries((await trx.raw(`SELECT n, warehouse_id::text AS w FROM t66_codigo`)).rows.map((r) => [r.n, r.w]));
      const s = Object.fromEntries((await trx.raw(`SELECT n, warehouse_id::text AS w FROM t66_sucursal`)).rows.map((r) => [r.n, r.w]));
      ok(c[1] === wh, 'lote 1: por kepler_code resuelve al almacén');
      ok(c[2] === wh, 'lote 1: por code, con espacios alrededor, resuelve');
      ok(c[3] === null, 'lote 1: wincaja_source_branch NO cuenta (regla del barrido 1)');
      ok(c[4] === null, 'código desconocido: queda NULL y el renglón SÍ se escribe');
      ok(c[5] === null, 'otro tenant: no resuelve al almacén de este tenant');
      ok(c[6] === ya, 'el warehouse_id que trae el escritor NO se pisa');
      ok(s[1] === wh, 'lote 2: por wincaja_source_branch resuelve');
      ok(s[2] === wh, 'lote 2: por kepler_code resuelve');
      await trx.raw(`UPDATE t66_codigo SET warehouse_id = NULL WHERE n = 1`);
      const u = (await trx.raw(`SELECT warehouse_id::text AS w FROM t66_codigo WHERE n = 1`)).rows[0].w;
      ok(u === wh, 'UPDATE que lo deja en NULL: se vuelve a resolver');

      // PRUEBA NEGATIVA: sin el trigger, el mismo INSERT deja NULL.
      await trx.raw(`DROP TRIGGER trg_warehouse_id_al_escribir ON t66_codigo`);
      await trx.raw(`INSERT INTO t66_codigo VALUES (?, 'K66X', NULL, 7)`, [T]);
      const neg = (await trx.raw(`SELECT warehouse_id FROM t66_codigo WHERE n = 7`)).rows[0].warehouse_id;
      ok(neg === null, 'NEGATIVA: sin el trigger el almacén queda NULL (la prueba mide al trigger)');

      // B. El cableado en las tablas vivas que existan en esta base.
      let puestas = 0, aplicables = 0;
      for (const [esq, tab, col] of MIG.TABLAS) {
        const r = (await trx.raw(
          `SELECT c.relkind::text AS k,
                  (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name IN ('warehouse_id','tenant_id', ?)) AS cols,
                  EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = c.oid AND tg.tgname = 'trg_warehouse_id_al_escribir') AS tiene
             FROM pg_class c WHERE c.oid = to_regclass(?)`, [esq, tab, col, `${esq}.${tab}`])).rows[0];
        if (!r || !(r.k === 'r' || r.k === 'p') || r.cols !== 3) continue;
        aplicables++;
        if (r.tiene) puestas++; else ok(false, `${esq}.${tab}: le falta el trigger`);
      }
      if (aplicables) ok(puestas === aplicables, `cableado: trigger en ${puestas} de ${aplicables} tablas vivas presentes en esta base`);
      else noMedido('ninguna de las 18 tablas existe en esta base');

      throw new Error('ROLLBACK');
    });
  } catch (e) {
    if (e.message !== 'ROLLBACK') { ok(false, `error inesperado: ${String(e.message).slice(0, 160)}`); }
  } finally {
    await knex.destroy();
  }
  salir();
})();
