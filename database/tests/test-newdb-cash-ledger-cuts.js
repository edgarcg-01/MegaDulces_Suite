/* eslint-disable no-console */
/**
 * Fase CG.15 — corte de caja con doble llave, saldo corrido y cancelación (ADR-070).
 * Smoke DB-direct, rollback al final (cero efecto real).
 *
 * Lo que esta suite existe para probar, y todo con PRUEBA NEGATIVA:
 *   · el saldo se DERIVA — un cancelado no lo mueve, pero sigue en la lista;
 *   · un corte no se puede cerrar sin contar, ni autorizar sin firma;
 *   · ⛔ QUIEN CIERRA NO PUEDE AUTORIZAR, y eso lo frena la DB, no el servicio;
 *   · no hay dos cortes abiertos en la misma sucursal;
 *   · cancelar exige motivo y autor: "cancelado" sin por qué es un agujero de auditoría.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-cash-ledger-cuts');

const T = '00000000-0000-0000-0000-00000000d01c';
const CAPTURISTA = '00000000-0000-0000-0000-0000000000aa';
const AUTORIZADOR = '00000000-0000-0000-0000-0000000000bb';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

async function violation(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let code = null;
  try { await fn(); } catch (e) { code = e.code; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return code;
}

let n = 0;
const mov = (over = {}) => ({
  tenant_id: T,
  folio: `CGX-${Date.now()}-${(n += 1)}`,
  tipo: 'gasto', fecha: '2026-09-18', sucursal: '00',
  kepler_cuenta: '601-001', kepler_concepto: '001',
  glosa: 'Movimiento de prueba del corte', monto: 100,
  created_by: CAPTURISTA, ...over,
});

const corte = (over = {}) => ({
  tenant_id: T, folio: `CC-2026-${String((n += 1)).padStart(5, '0')}`,
  fecha: '2026-09-18', sucursal: '00', fondo_inicial: 500,
  created_by: CAPTURISTA, created_by_username: 'capturista', ...over,
});

(async () => {
  try {
    console.log('\n── 1. Schema ──');
    for (const t of ['cash_ledger_cuts', 'cash_ledger_cut_denominations']) {
      const reg = await knex.raw(`SELECT to_regclass('finance.${t}') r`);
      ok(!!reg.rows[0].r, `finance.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity f FROM pg_class WHERE oid='finance.${t}'::regclass`);
      ok(rls.rows[0]?.f === true, `finance.${t} con RLS FORZADO`);
    }
    const v = await knex.raw(`SELECT reloptions FROM pg_class WHERE oid='finance.v_cash_ledger_balance'::regclass`);
    ok((v.rows[0]?.reloptions || []).some((o) => o === 'security_invoker=true'),
      'v_cash_ledger_balance con security_invoker=true (una vista NO hereda RLS)');
    // El saldo NO puede ser una columna: una columna se desvía y nadie se entera.
    const col = await knex.schema.withSchema('finance').hasColumn('cash_ledger', 'saldo');
    ok(col === false, 'el saldo NO es una columna de cash_ledger — se deriva, como manda §CG.15');

    await knex.transaction(async (trx) => {
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      console.log('\n── 2. El saldo corrido se DERIVA ──');
      const [i1] = await trx('finance.cash_ledger').insert(mov({ tipo: 'ingreso', monto: 1000 })).returning('*');
      const [g1] = await trx('finance.cash_ledger').insert(mov({ tipo: 'gasto', monto: 300 })).returning('*');
      const [d1] = await trx('finance.cash_ledger').insert(mov({ tipo: 'deposito', monto: 200 })).returning('*');

      const saldos = await trx.raw(
        `SELECT id, tipo, monto, efecto, saldo_movimientos FROM finance.v_cash_ledger_balance
          WHERE sucursal='00' ORDER BY created_at, id`);
      const fin = Number(saldos.rows[saldos.rows.length - 1].saldo_movimientos);
      ok(fin === 500, `1000 − 300 − 200 = 500 de movimientos (dio ${fin})`);
      ok(Number(saldos.rows.find((r) => r.id === i1.id).efecto) === 1000, 'un ingreso suma');
      ok(Number(saldos.rows.find((r) => r.id === g1.id).efecto) === -300, 'un gasto resta');
      ok(Number(saldos.rows.find((r) => r.id === d1.id).efecto) === -200, 'un depósito al banco resta de la caja');

      console.log('\n── 3. Cancelar: se marca, no se borra ──');
      const c1 = await violation(trx, () => trx('finance.cash_ledger').where({ id: g1.id })
        .update({ estado: 'cancelado' }));
      ok(c1 === '23514', `[negativa] cancelar sin motivo ni autor → 23514, got ${c1}`);
      const c2 = await violation(trx, () => trx('finance.cash_ledger').where({ id: g1.id })
        .update({ estado: 'cancelado', cancelled_by: CAPTURISTA, cancelled_at: new Date(), cancel_reason: 'ups' }));
      ok(c2 === '23514', `[negativa] motivo de 3 letras → 23514, got ${c2}`);

      await trx('finance.cash_ledger').where({ id: g1.id }).update({
        estado: 'cancelado', cancelled_by: CAPTURISTA, cancelled_at: new Date(),
        cancelled_by_username: 'capturista', cancel_reason: 'Capturado con el monto equivocado',
      });
      const tras = await trx.raw(
        `SELECT id, estado, efecto, saldo_movimientos FROM finance.v_cash_ledger_balance
          WHERE sucursal='00' ORDER BY created_at, id`);
      const cancelado = tras.rows.find((r) => r.id === g1.id);
      ok(!!cancelado, 'el movimiento cancelado SIGUE en la vista — lo que se audita es que se canceló');
      ok(Number(cancelado.efecto) === 0, 'y su efecto sobre el saldo es 0');
      ok(Number(tras.rows[tras.rows.length - 1].saldo_movimientos) === 800,
        `el saldo se recalcula solo: 1000 − 200 = 800 (dio ${tras.rows[tras.rows.length - 1].saldo_movimientos})`);

      console.log('\n── 4. El corte: abrir ──');
      const [abierto] = await trx('finance.cash_ledger_cuts').insert(corte()).returning('*');
      ok(abierto.estado === 'borrador', 'nace en borrador');

      const c3 = await violation(trx, () => trx('finance.cash_ledger_cuts').insert(corte()));
      ok(c3 === '23505', `[negativa] dos cortes abiertos en la misma sucursal → 23505, got ${c3}`);
      const otraSuc = await trx('finance.cash_ledger_cuts').insert(corte({ sucursal: '10' })).returning('*');
      ok(otraSuc.length === 1, 'pero sí puede haber uno abierto en OTRA sucursal');

      console.log('\n── 5. Cerrar exige haber contado ──');
      const c4 = await violation(trx, () => trx('finance.cash_ledger_cuts').where({ id: abierto.id })
        .update({ estado: 'cerrado', closed_by: CAPTURISTA, closed_at: new Date() }));
      ok(c4 === '23514', `[negativa] cerrar sin esperado/contado/diferencia → 23514, got ${c4}`);

      // La aritmética del §CG.15: esperado = fondo + ingresos − gastos − depósitos.
      const esperado = 500 + 1000 - 0 - 200;   // el gasto de 300 quedó cancelado
      const contado = 1000 + 200 + 100;        // 1×1000 + 1×200 + 1×100 contados a mano
      await trx('finance.cash_ledger_cuts').where({ id: abierto.id }).update({
        estado: 'cerrado', closed_by: CAPTURISTA, closed_by_username: 'capturista', closed_at: new Date(),
        total_ingresos: 1000, total_gastos: 0, total_depositos: 200,
        esperado, contado, diferencia: contado - esperado,
      });
      await trx('finance.cash_ledger_cut_denominations').insert([
        { tenant_id: T, cut_id: abierto.id, denominacion: 1000, piezas: 1 },
        { tenant_id: T, cut_id: abierto.id, denominacion: 200, piezas: 1 },
        { tenant_id: T, cut_id: abierto.id, denominacion: 100, piezas: 1 },
      ]);
      const cerrado = await trx('finance.cash_ledger_cuts').where({ id: abierto.id }).first();
      ok(Number(cerrado.esperado) === 1300, `esperado = 500 + 1000 − 200 = 1300 (dio ${cerrado.esperado})`);
      ok(Number(cerrado.diferencia) === 0, `contado 1300 contra esperado 1300 → diferencia 0 (dio ${cerrado.diferencia})`);

      // El conteo físico cuadra con lo declarado.
      const suma = await trx.raw(
        `SELECT coalesce(sum(denominacion*piezas),0) s FROM finance.cash_ledger_cut_denominations WHERE cut_id = ?`,
        [abierto.id]);
      ok(Number(suma.rows[0].s) === Number(cerrado.contado),
        'el desglose del conteo suma exactamente lo declarado como contado');

      console.log('\n── 6. ⛔ LA DOBLE LLAVE ──');
      const c5 = await violation(trx, () => trx('finance.cash_ledger_cuts').where({ id: abierto.id })
        .update({ estado: 'autorizado', authorized_by: CAPTURISTA, authorized_at: new Date() }));
      ok(c5 === '23514',
        `[negativa] el MISMO usuario que cerró intenta autorizar → 23514 en la DB, got ${c5}`);

      const c6 = await violation(trx, () => trx('finance.cash_ledger_cuts').where({ id: abierto.id })
        .update({ estado: 'autorizado' }));
      ok(c6 === '23514', `[negativa] autorizar sin firma → 23514, got ${c6}`);

      await trx('finance.cash_ledger_cuts').where({ id: abierto.id }).update({
        estado: 'autorizado', authorized_by: AUTORIZADOR, authorized_by_username: 'gerente',
        authorized_at: new Date(),
      });
      const auth = await trx('finance.cash_ledger_cuts').where({ id: abierto.id }).first();
      ok(auth.estado === 'autorizado' && auth.authorized_by === AUTORIZADOR,
        'con OTRO usuario sí autoriza — la doble llave deja pasar lo legítimo');
      ok(auth.closed_by !== auth.authorized_by, 'y quedan los dos nombres, distintos, en el registro');

      console.log('\n── 7. El movimiento se ata a su corte ──');
      await trx('finance.cash_ledger').whereIn('id', [i1.id, d1.id]).update({ corte_id: abierto.id, estado: 'en_corte' });
      const enCorte = await trx('finance.cash_ledger').where({ corte_id: abierto.id }).count('* as n').first();
      ok(Number(enCorte.n) === 2, `2 movimientos quedaron atados al corte (dio ${enCorte.n})`);
      const c7 = await violation(trx, () => trx('finance.cash_ledger')
        .insert(mov({ corte_id: '00000000-0000-0000-0000-00000000dead' })));
      ok(c7 === '23503', `[negativa] atar un movimiento a un corte inexistente → 23503 (FK), got ${c7}`);

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ✓ rollback aplicado — la DB queda como estaba');
    pass++;

    console.log('\n── 8. Declarado ──');
    skip('que el saldo corrido escale con volumen real (la vista usa una ventana sobre toda la sucursal): se mide cuando haya movimientos de verdad, no con 3 filas.');

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n💥', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
