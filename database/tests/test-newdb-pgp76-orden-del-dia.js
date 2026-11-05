#!/usr/bin/env node
'use strict';
/**
 * [PGP.76] El orden del día entero en UNA escritura — servicio REAL (ts-node) contra base real,
 * todo dentro de una transacción que se revierte al final (cero efecto).
 *
 * Es un endpoint que ESCRIBE (`POST days/:date/orden`), así que se ejerce con el mismo payload que
 * manda la pantalla: la lista completa de pendientes en su nuevo orden. Verifica:
 *   1. llevar el último al turno 1 deja 1..N sin huecos ni repetidos, en el orden pedido;
 *   2. ⛔ una lista que no es EXACTAMENTE la de pendientes (falta uno, sobra uno, repetido) se
 *      rechaza entera y NO toca ningún turno;
 *   3. un pago no pendiente (cancelado) no cuenta como pendiente ni se renumera;
 *   4. ⛔ un día ya autorizado (`released`) no se reordena.
 */
const path = require('path');
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true }); } catch { /* opcional */ }

// El módulo de authz exige un secreto al cargarse; éste sólo vive en el proceso de la prueba (como en DP.22).
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-pgp76-${'x'.repeat(40)}`;
const T = '00000000-0000-0000-0000-00000000d01c';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

let Servicio;
try {
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' },
  });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(__dirname, '../../tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: path.join(__dirname, '../..'), paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ PaymentCalendarService: Servicio } = require(path.join(__dirname, '../../libs/finance/src/lib/payment-calendar/payment-calendar.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio real con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pgp76-orden-del-dia');

/** El servicio real, con su `tk.run` dentro de un SAVEPOINT de la transacción del test. */
function servicio(trx) {
  const s = Object.create(Servicio.prototype);
  Object.assign(s, {
    logger: { log() {}, warn() {}, error() {}, debug() {} },
    tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: null }) },
    tk: { run: (fn) => trx.transaction((sp) => fn(sp)) },
  });
  return s;
}
async function rechaza(fn) {
  try { await fn(); return null; } catch (e) { return e?.constructor?.name ?? 'Error'; }
}

(async () => {
  console.log('\n[PGP.76] Orden del día en una escritura — servicio real, rollback al final\n');
  const ROLLBACK = new Error('rollback');
  try {
    await knex.transaction(async (trx) => {
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      const fecha = `2099-0${1 + (Date.now() % 9)}-1${Date.now() % 9}`;
      await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: fecha }).del();
      const [lot] = await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: fecha }).returning('*');
      const mk = async (amount, extra = {}) => (await trx('finance.payment_allocations')
        .insert({ tenant_id: T, lot_id: lot.id, classification: 'gasto', amount_assigned: amount, ...extra }).returning('*'))[0];
      const p = [await mk(100, { priority_rank: 1 }), await mk(200, { priority_rank: 2 }), await mk(300, { priority_rank: 3 }), await mk(400, { priority_rank: 4 })];
      const cancelado = await mk(999, { priority_rank: 7, status: 'cancelled' });
      const s = servicio(trx);
      const turnos = async () => new Map((await trx('finance.payment_allocations').where({ lot_id: lot.id }).select('id', 'priority_rank')).map((r) => [r.id, r.priority_rank]));

      // 1. El último al turno 1, en UNA llamada.
      const nuevo = [p[3].id, p[0].id, p[1].id, p[2].id];
      const r = await s.reorderDay(fecha, nuevo, 'smoke_pgp76');
      let t = await turnos();
      ok(nuevo.every((id, i) => t.get(id) === i + 1), 'el último quedó en el turno 1 y los demás se recorrieron uno (1..4, en el orden pedido)');
      ok(Array.isArray(r) && r.length === 4 && r[0].id === p[3].id && r[0].priority_rank === 1, 'la respuesta trae el orden que quedó');
      ok(new Set([...nuevo].map((id) => t.get(id))).size === 4, 'sin turnos repetidos');
      // 3. El cancelado no se toca.
      ok(t.get(cancelado.id) === 7, 'el pago cancelado no cuenta como pendiente ni se renumera');
      const audit = await trx('finance.payment_allocations').where({ id: p[3].id }).first();
      ok(audit.updated_by === 'smoke_pgp76', 'queda quién lo ordenó (updated_by)');

      // 2. Listas que no son exactamente la de pendientes: se rechazan enteras.
      const antes = await turnos();
      const casos = [
        ['falta uno', [p[0].id, p[1].id, p[2].id]],
        ['sobra el cancelado', [...nuevo, cancelado.id]],
        ['repetido', [p[0].id, p[0].id, p[1].id, p[2].id]],
        ['vacía', []],
      ];
      for (const [nombre, ids] of casos) {
        const err = await rechaza(() => s.reorderDay(fecha, ids, 'smoke_pgp76'));
        ok(!!err, `⛔ lista «${nombre}» se rechaza (${err})`);
      }
      t = await turnos();
      ok([...antes].every(([id, rk]) => t.get(id) === rk), 'ningún rechazo tocó un solo turno');

      // 4. Día autorizado: ya no se reordena.
      await trx('finance.payment_calendar_lots').where({ id: lot.id }).update({ status: 'released' });
      const errRel = await rechaza(() => s.reorderDay(fecha, [p[0].id, p[1].id, p[2].id, p[3].id], 'smoke_pgp76'));
      ok(errRel === 'BadRequestException', `⛔ un día autorizado no se reordena (${errRel})`);
      t = await turnos();
      ok(t.get(p[3].id) === 1, 'y su orden sigue el de antes');

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { fail++; console.log('  ✗ ERROR', e.message); }
  } finally {
    await knex.destroy();
  }
  console.log(`\n  ${pass} ✓ · ${fail} ✗`);
  process.exit(fail ? 1 : (pass ? 0 : 2));
})();
