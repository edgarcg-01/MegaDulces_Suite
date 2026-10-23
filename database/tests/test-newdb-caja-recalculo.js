/* eslint-disable no-console */
/**
 * `[CGS.52]` — Un corte firmado se RECALCULA sólo con constancia, y lo que no se midió se DECLARA.
 *
 * Mide la migración `20261023095246_cgs52_recalcular_cortes_con_el_conteo_fisico_y_el_libro_atado`:
 *
 *  · sin constancia, el esperado de un corte cerrado no cambia (`cut_firmado_inmutable_chk`);
 *  · con una constancia que NO guarda las cifras exactas que reemplaza, tampoco;
 *  · con motivo corto, tampoco;
 *  · ni con constancia se mueve el día, la sucursal ni quién cerró (`cut_recalculo_alcance_chk`);
 *  · un corte cerrado sin conteo no pasa salvo que diga POR QUÉ (`cut_cerrado_completo_chk`);
 *  · el recálculo en regla pasa y la aritmética sigue exigida (`cut_aritmetica_chk`).
 *
 * Escribe como `app_runtime` cuando existe, todo en una transacción que se deshace, y cierra con
 * una MUTACIÓN: con la guardia apagada el cambio sin constancia SÍ pasa (la sección 2 mide el trigger).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-recalculo');

const T = '00000000-0000-0000-0000-00000000d01c';
const ABRE = '00000000-0000-0000-0000-0000000000a1';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
const FECHA = '2099-03-01';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message).slice(-200) }; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const es = (err, code, constraint) => !!err && err.code === code && err.constraint === constraint;
const dijo = (err) => (err ? `${err.code} ${err.constraint ?? '(sin nombre)'}` : 'pasó sin error');

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const col = await knex.schema.withSchema('finance').hasColumn('cash_ledger_cuts', 'recalculo_previo');
    if (!col) { ok(false, 'la migración 20261023095246 NO está aplicada en esta base: nada de lo que sigue se puede medir'); return; }
    ok(true, 'las columnas del recálculo existen');

    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

    await knex.transaction(async (trx) => {
      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      else skip('sin app_runtime: las escrituras corren como superusuario, no como la app.');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      console.log('\n── 1. Un corte cerrado ──');
      const [c] = await trx('finance.cash_ledger_cuts').insert({
        tenant_id: T, folio: `CGS52-TEST-${Date.now()}`, fecha: FECHA, sucursal: 'S1',
        fondo_inicial: 500, fondo_origen: 'contado', created_by: ABRE, created_by_username: 'abre_prueba',
      }).returning('*');
      await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        contado: 400, morralla: 0, esperado: 300, diferencia: 100, total_ingresos: 0, total_gastos: 200, total_depositos: 0,
      });
      await trx('finance.cash_ledger_cut_denominations').insert({
        tenant_id: T, cut_id: c.id, denom_key: '200', denominacion: 200, piezas: 2, momento: 'cierre',
      });
      await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        estado: 'cerrado', closed_by: CAJERA, closed_by_username: 'cajera_prueba', closed_at: trx.fn.now(),
      });
      ok(true, 'el corte se cerró (esperado 300, contado 400, diferencia +100)');

      const previo = { fondo_inicial: 500, total_ingresos: 0, total_gastos: 200, esperado: 300, contado: 400, diferencia: 100 };
      const recalculo = (over = {}) => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        total_gastos: 100, esperado: 400, diferencia: 0,
        recalculo_previo: JSON.stringify(previo), recalculo_motivo: 'Prueba CGS.52: el libro atado cambio', recalculado_at: trx.fn.now(),
        ...over,
      });

      console.log('\n── 2. ⛔ Sin constancia no se mueve ──');
      const e2a = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ esperado: 400, diferencia: 0 }));
      ok(es(e2a, '23514', 'cut_firmado_inmutable_chk'), `[negativa] cambiar el esperado de un corte cerrado sin constancia → cut_firmado_inmutable_chk (${dijo(e2a)})`);
      const e2b = await intento(trx, () => recalculo({ recalculo_previo: JSON.stringify({ ...previo, esperado: 999 }) }));
      ok(es(e2b, '23514', 'cut_firmado_inmutable_chk'), `[negativa] una constancia que NO guarda el esperado que reemplaza → cut_firmado_inmutable_chk (${dijo(e2b)})`);
      const e2c = await intento(trx, () => recalculo({ recalculo_motivo: 'corto' }));
      ok(es(e2c, '23514', 'cut_firmado_inmutable_chk'), `[negativa] motivo de menos de 10 caracteres → cut_firmado_inmutable_chk (${dijo(e2c)})`);
      const e2d = await intento(trx, () => recalculo({ fecha: '2099-03-02' }));
      ok(es(e2d, '23514', 'cut_recalculo_alcance_chk'), `[negativa] ni con constancia se cambia el día → cut_recalculo_alcance_chk (${dijo(e2d)})`);
      const e2e = await intento(trx, () => recalculo({ closed_by: ABRE }));
      ok(es(e2e, '23514', 'cut_recalculo_alcance_chk'), `[negativa] ni con constancia se cambia quién cerró → cut_recalculo_alcance_chk (${dijo(e2e)})`);
      const e2f = await intento(trx, () => recalculo({ diferencia: 5 }));
      ok(es(e2f, '23514', 'cut_aritmetica_chk'), `[negativa] la diferencia sigue siendo contado − esperado → cut_aritmetica_chk (${dijo(e2f)})`);

      console.log('\n── 3. ⛔ Lo que no se midió se declara ──');
      const sinConteo = (motivo) => recalculo({
        contado: null, morralla: 0, diferencia: null, sin_medir_motivo: motivo,
      });
      const e3a = await intento(trx, async () => {
        await trx('finance.cash_ledger_cut_denominations').where({ cut_id: c.id }).del();
        await sinConteo(null);
      });
      ok(es(e3a, '23514', 'cut_cerrado_completo_chk'), `[negativa] un corte cerrado sin conteo y SIN decir por qué → cut_cerrado_completo_chk (${dijo(e3a)})`);
      const e3b = await intento(trx, async () => {
        await trx('finance.cash_ledger_cut_denominations').where({ cut_id: c.id }).del();
        await sinConteo('No hubo conteo fisico ese dia: prueba CGS.52');
        await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');   // el desglose se comprueba aquí, no al final
        await trx.raw('SET CONSTRAINTS ALL DEFERRED');
      });
      ok(e3b === null, `sin conteo PERO declarado pasa, y el desglose vacío cuadra (${dijo(e3b)})`);

      console.log('\n── 4. El recálculo en regla pasa y deja la constancia ──');
      // Sin SAVEPOINT a propósito: se queda aplicado para medir que después vuelve a congelarse.
      // (Un `intento` anidado reusaría el nombre `sp` y el rollback exterior caería en el interior.)
      await recalculo();
      const r = await trx('finance.cash_ledger_cuts').where({ id: c.id }).first();
      ok(Number(r.esperado) === 400 && Number(r.diferencia) === 0, `con constancia exacta pasa (esperado ${r.esperado}, diferencia ${r.diferencia})`);
      ok(Number(r.recalculo_previo?.esperado) === 300, `la constancia guarda el esperado anterior (${r.recalculo_previo?.esperado})`);
      const otra = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ esperado: 401, diferencia: -1 }));
      ok(es(otra, '23514', 'cut_firmado_inmutable_chk'), `[negativa] ya recalculado, vuelve a quedar congelado → cut_firmado_inmutable_chk (${dijo(otra)})`);

      console.log('\n── 5. ⛔ MUTACIÓN: sin la guardia, el cambio sin constancia SÍ pasa ──');
      if (hayRol) await trx.raw('RESET ROLE');
      await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
      await trx.raw('SET CONSTRAINTS ALL DEFERRED');
      const sinGuardia = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger_cuts DISABLE TRIGGER trg_cash_cut_guardia');
        await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ esperado: 400, diferencia: 0 });
      });
      ok(sinGuardia === null, `con la guardia APAGADA el esperado firmado sí cambia (${dijo(sinGuardia)}): la sección 2 mide el trigger`);

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('\n  ✓ rollback aplicado — la base queda como estaba');
  } catch (e) {
    fail++;
    console.error('\n💥', e.message, '\n', e.stack);
  } finally {
    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
    await knex.destroy();
  }
})();
