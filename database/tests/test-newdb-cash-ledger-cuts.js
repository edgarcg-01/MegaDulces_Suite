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

      console.log('\n── 7b. ⛔ CERRAR NO DES-CANCELA (CG.19) ──');
      // El defecto: `cerrar()` ataba los movimientos con un solo UPDATE que pisaba
      // `estado = 'en_corte'` SIN excluir los cancelados. Un movimiento cancelado y todavía sin
      // corte quedaba RESUCITADO: `v_cash_ledger_balance` descuenta por `estado='cancelado'`, así
      // que al perder ese estado volvía a mover el saldo — y además dejaba de poder cancelarse.
      //
      // Lo que se prueba acá es el INVARIANTE, no la implementación: un movimiento cancelado puede
      // pertenecer a un corte (se audita que se canceló) y aun así no mover un peso.
      const [gx] = await trx('finance.cash_ledger')
        .insert(mov({ tipo: 'gasto', monto: 777, folio: `CGZ-${Date.now()}` })).returning('*');
      await trx('finance.cash_ledger').where({ id: gx.id }).update({
        estado: 'cancelado', cancelled_by: CAPTURISTA, cancelled_by_username: 'capturista',
        cancel_reason: 'Se canceló ANTES de que cerraran la caja', cancelled_at: new Date(),
      });

      const efectoDe = async (id) => {
        const r = await trx.raw(
          `SELECT estado, efecto FROM finance.v_cash_ledger_balance WHERE id = ?`, [id]);
        return r.rows[0];
      };
      const antes = await efectoDe(gx.id);
      ok(Number(antes.efecto) === 0, `cancelado y suelto: no mueve el saldo (efecto ${antes.efecto})`);

      // Así lo ata `cerrar()` ahora: corte_id sí, estado NO.
      await trx('finance.cash_ledger').where({ id: gx.id }).update({ corte_id: abierto.id });
      const atado = await efectoDe(gx.id);
      ok(atado.estado === 'cancelado',
        'atado a un corte, el movimiento cancelado CONSERVA su estado');
      ok(Number(atado.efecto) === 0,
        `y sigue sin mover el saldo (efecto ${atado.efecto}) — pertenece al corte, pero no cuenta`);

      // ⛔ LA PRUEBA NEGATIVA: esto es exactamente lo que hacía el código viejo. Si algún día
      // vuelve, esta aserción lo grita — el movimiento cancelado empieza a mover $777.
      await trx('finance.cash_ledger').where({ id: gx.id }).update({ estado: 'en_corte' });
      const resucitado = await efectoDe(gx.id);
      ok(Number(resucitado.efecto) === -777,
        `[negativa] si se le pisa el estado a 'en_corte', el cancelado RESUCITA y mueve `
        + `${resucitado.efecto} — es el daño que el fix impide`);
      await trx('finance.cash_ledger').where({ id: gx.id }).update({ estado: 'cancelado' });

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ✓ rollback aplicado — la DB queda como estaba');
    pass++;

    // -- 9. CG.19 Capa 1: el valor se TOMA de Kepler ----------------------------------------
    //
    // La pregunta no es si la suma da: es si el monto pudo haber venido de un teclado, y si el
    // mismo cobro del ERP puede entrar dos veces. Las dos con prueba negativa.
    console.log('\n-- 9. CG.19 Capa 1 - el ingreso anclado a un cobro de Kepler --');
    await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);

      const ref = `00|ZZTEST-${Date.now()}`;
      const ancl = (over = {}) => mov({
        tipo: 'ingreso', monto: 1000, glosa: 'Entrega de ruta anclada',
        origen_tipo: 'cobro', origen_ref: ref, estado: 'registrado', ...over,
      });

      const [a] = await trx('finance.cash_ledger').insert(ancl()).returning('*');
      ok(!!a.id, 'un ingreso anclado a un cobro de Kepler se guarda');

      // El invariante: el MISMO cobro no puede aplicarse dos veces. Sin el indice unico
      // (ux_cash_ledger_origen_vivo) se sumaba dos veces al esperado sin un solo error.
      const dup = await violation(trx, () => trx('finance.cash_ledger').insert(ancl()));
      ok(dup === '23505', `[negativa] el mismo cobro NO entra dos veces (23505, fue ${dup})`);

      // Pero cancelar tiene que LIBERARLO: si no, un error de dedo inutiliza el documento para
      // siempre y ese cobro no se puede registrar nunca.
      await trx('finance.cash_ledger').where({ id: a.id }).update({
        estado: 'cancelado', cancelled_by: CAPTURISTA, cancelled_at: trx.fn.now(),
        cancel_reason: 'Se capturo con el cobro equivocado',
      });
      const [b] = await trx('finance.cash_ledger').insert(ancl()).returning('*');
      ok(!!b.id && b.id !== a.id, 'cancelar LIBERA el cobro: se puede volver a aplicar');

      // Un movimiento sin origen no toca el indice. Si lo tocara, solo cabria UNA captura manual
      // en toda la tabla: es el error que evita el unico PARCIAL en vez de NULLS NOT DISTINCT.
      await trx('finance.cash_ledger').insert(mov({ tipo: 'ingreso', monto: 55 }));
      const [c2] = await trx('finance.cash_ledger').insert(mov({ tipo: 'ingreso', monto: 66 })).returning('*');
      ok(!!c2.id, 'dos capturas manuales (origen NULL) conviven: el unico es PARCIAL');

      // La vista de pendientes tiene que ESCONDER lo ya aplicado. Se prueba con un cobro REAL del
      // ERP, no con uno inventado; si no hay ninguno se declara NO MEDIDO (regla M5).
      const real = await trx('finance.v_caja_ingresos_pendientes').first('origen_ref', 'monto');
      if (!real) {
        skip('la vista de ingresos pendientes no trae cobros en esta base: no se pudo probar que esconda lo aplicado (M5 - un lado vacio no prueba nada).');
      } else {
        await trx('finance.cash_ledger').insert(mov({
          tipo: 'ingreso', monto: Number(real.monto), glosa: 'Aplica el cobro real',
          origen_tipo: 'cobro', origen_ref: real.origen_ref,
        }));
        const sigue = await trx('finance.v_caja_ingresos_pendientes')
          .where('origen_ref', real.origen_ref).first();
        ok(!sigue, `un cobro ya aplicado DESAPARECE de los pendientes (${real.origen_ref})`);
      }

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ok rollback aplicado - la DB queda como estaba');
    pass++;

    // -- 10. CG.19 Capa 1b: el reconteo deja rastro o no existe ------------------------------
    console.log('\n-- 10. CG.19 Capa 1b - reconteo con rastro --');
    await knex.transaction(async (trx) => {
      const [c] = await trx('finance.cash_ledger_cuts').insert(corte()).returning('*');

      // El primer conteo guardado SIN razon no se distingue de un ajuste: la DB lo frena.
      const sinMotivo = await violation(trx, () => trx('finance.cash_ledger_cuts')
        .where({ id: c.id }).update({ conteo_previo: JSON.stringify({ contado: 100 }) }));
      ok(sinMotivo === '23514', `[negativa] conteo_previo sin motivo -> 23514, fue ${sinMotivo}`);

      // Y una razon de adorno tampoco: mismo piso que el motivo de cancelacion.
      const motivoCorto = await violation(trx, () => trx('finance.cash_ledger_cuts')
        .where({ id: c.id }).update({ conteo_previo: JSON.stringify({ contado: 100 }), reconteo_motivo: 'eh' }));
      ok(motivoCorto === '23514', `[negativa] motivo de menos de 5 caracteres -> 23514, fue ${motivoCorto}`);

      // Una razon sin el conteo viejo no se puede auditar: tambien se frena.
      const soloMotivo = await violation(trx, () => trx('finance.cash_ledger_cuts')
        .where({ id: c.id }).update({ reconteo_motivo: 'Se conto mal la caja chica' }));
      ok(soloMotivo === '23514', `[negativa] motivo sin conteo previo -> 23514, fue ${soloMotivo}`);

      await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        conteo_previo: JSON.stringify({ contado: 100, denominaciones: [{ denominacion: 100, piezas: 1 }] }),
        reconteo_motivo: 'Se conto mal la caja chica',
      });
      const r = await trx('finance.cash_ledger_cuts').where({ id: c.id }).first('conteo_previo', 'reconteo_motivo');
      ok(r.conteo_previo && Number(r.conteo_previo.contado) === 100 && r.reconteo_motivo.length >= 5,
        'el PRIMER conteo se conserva entero, con su motivo: los dos quedan a la vista');

      throw new Error('__ROLLBACK__');
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });
    console.log('  ok rollback aplicado - la DB queda como estaba');
    pass++;

    console.log('\n── 8. Declarado ──');
    skip('que el saldo corrido escale con volumen real (la vista usa una ventana sobre toda la sucursal): se mide cuando haya movimientos de verdad, no con 3 filas.');
    skip('CG.19 Capa 1 por HTTP (ADR-044): que create() IGNORE el monto del formulario y tome el de Kepler se prueba contra el SERVICIO, no contra la tabla. Esta sesion no tiene credenciales: queda declarado, no verde.');
    skip('CG.19 Capa 1b por HTTP: que /saldo NO devuelva esperado a quien no autoriza es una proyeccion del CONTROLADOR (revela() lee el permiso del JWT). Se prueba con dos tokens reales, no contra la tabla. Sin credenciales en esta sesion: declarado.');

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO\n`);
    process.exitCode = fail === 0 ? 0 : 1;
  } catch (e) {
    console.error('\n💥', e.message, '\n', e.stack);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
