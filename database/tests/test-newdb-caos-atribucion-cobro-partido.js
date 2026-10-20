/* eslint-disable no-console */
/**
 * `[CGA-A.37]` — El candado de la atribución de CAOS, contra la base real.
 *
 * El índice viejo (`ux_caos_atrib_cobro_vivo`) exigía UNA fila por cobro y el motor parte un
 * cobro entre dos depósitos a propósito: `finance.caos_ingreso_atribucion` llevaba **0 filas en
 * toda su vida** y el carril fallaba en cada corrida. La única prueba "real" que había declaraba
 * «Sólo SELECT, no llama a conciliar()» — la escritura nunca se ejerció.
 *
 * Esto ejerce la ESCRITURA con la forma exacta que manda `conciliar()`:
 *   ✓ CONTROL POSITIVO — un cobro partido en dos depósitos ENTRA (sin esto, un candado que
 *     rechace todo se ve igual de verde).
 *   ✗ un tercer tramo que pasa el monto del cobro → `caos_atrib_cobro_excedido`
 *   ✗ dos tramos del mismo cobro con distinto `cobro_monto` → rechazado (si no, el tope se esquiva)
 *   ✗ un tramo mayor que su cobro → `caos_atrib_tramo_cabe_chk`
 *   ✗ la misma pareja depósito+cobro dos veces → `ux_caos_atrib_par_vivo` (se conserva)
 *   ✓ el índice viejo ya no existe
 *
 * DB-direct, en UNA transacción con ROLLBACK (no persiste). Refs sintéticos `TEST|CGA-A37|…`.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const tramo = (ext, ref, monto, cobroMonto) => ({
  tenant_id: T, caos_device: 'TEST-CGA-A37', caos_external_id: ext,
  caos_occurred_at: '2026-10-20T12:00:00-06:00', cobro_origen_ref: ref, cobro_fecha: '2026-10-19',
  monto, cobro_monto: cobroMonto, metodo: 'fifo_anterior',
});

/** Corre `fn` en un SAVEPOINT y devuelve el mensaje de error, o null si pasó. */
async function intento(trx, fn) {
  try { await trx.transaction(async (sp) => { await fn(sp); }); return null; } catch (e) { return String(e.message || e); }
}

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      const col = await trx.raw(`SELECT 1 FROM information_schema.columns
        WHERE table_schema='finance' AND table_name='caos_ingreso_atribucion' AND column_name='cobro_monto'`);
      ok(col.rows.length === 1, 'existe cobro_monto (la migración 20261020110022 está aplicada)');
      if (!col.rows.length) throw new Error('__ROLLBACK__');

      const viejo = await trx.raw(`SELECT 1 FROM pg_indexes WHERE schemaname='finance' AND indexname='ux_caos_atrib_cobro_vivo'`);
      ok(viejo.rows.length === 0, 'el índice ux_caos_atrib_cobro_vivo (una fila por cobro) ya no existe');

      // ✓ CONTROL POSITIVO: el caso real, un cobro de $31,923.64 partido en dos depósitos
      //   (en prod: 00|U-A-5|0014589|0011 → $29,590.37 al #451 y $2,333.27 al #452).
      const REF = 'TEST|CGA-A37|partido';
      const e0 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert([
        tramo(9000451, REF, 29590.37, 31923.64),
        tramo(9000452, REF, 2333.27, 31923.64),
      ]));
      ok(e0 === null, `un cobro partido en DOS depósitos entra en un solo INSERT ${e0 ? '— ' + e0 : ''}`);
      await trx('finance.caos_ingreso_atribucion').insert([
        tramo(9000451, REF, 29590.37, 31923.64), tramo(9000452, REF, 2333.27, 31923.64),
      ]);

      // ✗ Un tercer tramo que pasa el monto del cobro.
      const e1 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert(tramo(9000453, REF, 0.10, 31923.64)));
      ok(e1 && e1.includes('caos_atrib_cobro_excedido'), `pasar el monto del cobro se RECHAZA (${(e1 || 'pasó').slice(0, 90)})`);

      // ✓ …pero un tramo que lo completa justo, entra (el tope no es «una fila más»).
      const REF2 = 'TEST|CGA-A37|justo';
      const e1b = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert([
        tramo(9000454, REF2, 60, 100), tramo(9000455, REF2, 40, 100),
      ]));
      ok(e1b === null, 'llenar el cobro exacto ($60 + $40 de $100) entra');

      // ✗ Dos tramos del mismo cobro declarando montos distintos (esquivaría el tope).
      const REF3 = 'TEST|CGA-A37|montos';
      const e2 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert([
        tramo(9000456, REF3, 90, 100), tramo(9000457, REF3, 90, 1000),
      ]));
      ok(e2 && e2.includes('caos_atrib_cobro_excedido'), 'el mismo cobro con dos cobro_monto distintos se RECHAZA');

      // ✗ Un tramo más grande que su cobro.
      const e3 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert(tramo(9000458, 'TEST|CGA-A37|grande', 150, 100)));
      ok(e3 && e3.includes('caos_atrib_tramo_cabe_chk'), 'un tramo mayor que su cobro se RECHAZA (CHECK)');

      // ✗ La misma pareja depósito+cobro dos veces (el índice que se conserva).
      const e4 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert(tramo(9000451, REF, 0.01, 31923.64)));
      ok(e4 && /ux_caos_atrib_par_vivo|caos_atrib_cobro_excedido/.test(e4), 'repetir la pareja depósito+cobro se RECHAZA');

      // ✗ Un UPDATE que infla un tramo también pasa por el candado.
      const e5 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion')
        .where({ tenant_id: T, cobro_origen_ref: REF, caos_external_id: 9000452 }).update({ monto: 5000 }));
      ok(e5 && e5.includes('caos_atrib_cobro_excedido'), 'inflar un tramo por UPDATE se RECHAZA');

      // ✓ Un tramo borrado (lógico) libera su monto: recalcular un período es borrar y reescribir.
      await trx('finance.caos_ingreso_atribucion').where({ tenant_id: T, cobro_origen_ref: REF, caos_external_id: 9000452 })
        .update({ deleted_at: trx.fn.now() });
      const e6 = await intento(trx, (sp) => sp('finance.caos_ingreso_atribucion').insert(tramo(9000459, REF, 2333.27, 31923.64)));
      ok(e6 === null, `tras borrar un tramo, su monto se puede volver a atribuir ${e6 ? '— ' + e6 : ''}`);

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error(e); fail++; }
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ · ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
