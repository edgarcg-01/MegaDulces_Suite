/* eslint-disable no-console */
/**
 * `[CGS.10][CGS.11][CGS.16]` — La supervisión de la caja vive en la BASE, no sólo en el servicio.
 *
 * Mide tres reglas de la migración `20261021110252_cgs10_bitacora_y_candado_del_libro_de_caja`:
 *
 *  · CGS.11 — un movimiento de un corte que ya no es borrador no cambia importe, tipo, corte, ni
 *    se borra (`cash_ledger_en_corte_firmado_chk`). Lo que es evidencia (la glosa) sí.
 *  · CGS.10 — cada cambio del libro y del corte deja una fila en `analytics.master_data_history`,
 *    con el rol que lo escribió.
 *  · CGS.16 — quien autoriza no abrió el corte ni capturó o canceló un movimiento de él
 *    (`cut_autoriza_lo_ajeno_chk`). Decisión D3 de Edgar (2026-10-21).
 *
 * Escribe como `app_runtime` (el rol de prod), cada regla espera su código Y su nombre, y cierra
 * con MUTACIONES que apagan cada trigger y exigen que la violación entonces pase. Todo en una
 * transacción que se deshace.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md`.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-supervision');

const T = '00000000-0000-0000-0000-00000000d01c';
const ABRE = '00000000-0000-0000-0000-0000000000a1';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
const CAPTURA = '00000000-0000-0000-0000-0000000000c3';
const CANCELA = '00000000-0000-0000-0000-0000000000c4';
const AUTORIZA = '00000000-0000-0000-0000-0000000000c2';
const FECHA = '2099-02-01';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

let n = 0;
const sello = () => `${Date.now()}-${(n += 1)}`;
const mov = (corteId, over = {}) => ({
  tenant_id: T, folio: `CGS-TEST-${sello()}`, tipo: 'gasto', fecha: FECHA, sucursal: 'S1',
  kepler_cuenta: '601-001', kepler_concepto: 'PRUEBA', glosa: 'Movimiento de prueba CGS',
  monto: 100, corte_id: corteId, created_by: CAPTURA, created_by_username: 'captura_prueba', ...over,
});

async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) {
    err = { code: e.code, constraint: e.constraint, message: String(e.message).slice(-200) };
  }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const es = (err, code, constraint) => !!err && err.code === code && err.constraint === constraint;
const dijo = (err) => (err ? `${err.code} ${err.constraint ?? '(sin nombre)'}` : 'pasó sin error');

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const trg = await knex.raw(`
      SELECT tgrelid::regclass::text AS tabla, tgname, tgenabled FROM pg_trigger
       WHERE NOT tgisinternal
         AND tgname IN ('trg_cash_ledger_congelado','trg_cash_cut_autoriza_ajeno','trg_master_data_history')
         AND tgrelid IN ('finance.cash_ledger'::regclass, 'finance.cash_ledger_cuts'::regclass)`);
    const tiene = (t, g) => trg.rows.some((r) => r.tabla === t && r.tgname === g && r.tgenabled === 'O');
    if (!tiene('finance.cash_ledger', 'trg_cash_ledger_congelado')) {
      ok(false, 'la migración 20261021110252 NO está aplicada en esta base: nada de lo que sigue se puede medir');
      return;
    }
    ok(tiene('finance.cash_ledger', 'trg_cash_ledger_congelado'), 'el candado de lo firmado está ENCENDIDO');
    ok(tiene('finance.cash_ledger_cuts', 'trg_cash_cut_autoriza_ajeno'), 'la regla de quien autoriza está ENCENDIDA');
    ok(tiene('finance.cash_ledger', 'trg_master_data_history') && tiene('finance.cash_ledger_cuts', 'trg_master_data_history'),
      'el historial cuelga del libro y del corte');

    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

    await knex.transaction(async (trx) => {
      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      else skip('sin app_runtime: las escrituras corren como superusuario, no como la app.');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      console.log('\n── 1. Un corte con movimientos de tres personas ──');
      const [c] = await trx('finance.cash_ledger_cuts').insert({
        tenant_id: T, folio: `CGS-TEST-${sello()}`, fecha: FECHA, sucursal: 'S1',
        fondo_inicial: 500, fondo_origen: 'contado', created_by: ABRE, created_by_username: 'abre_prueba',
      }).returning('*');
      const [m1] = await trx('finance.cash_ledger').insert(mov(c.id)).returning('*');
      await trx('finance.cash_ledger').insert(mov(c.id, {
        // ⚠️ Lo crea CAPTURA y no CAJERA: si CAJERA (quien cierra) también lo hubiera creado, la
        // prueba de la doble llave de abajo dispararía primero la regla de «capturó en el corte»
        // y no mediría la doble llave. Eso pasó el 2026-10-21 (21 ok / 1 rojo en caja-db).
        created_by: CAPTURA, estado: 'cancelado', cancelled_by: CANCELA, cancelled_at: trx.fn.now(),
        cancel_reason: 'Prueba de cancelacion CGS',
      }));
      const e1 = await intento(trx, () => trx('finance.cash_ledger').where({ id: m1.id }).update({ monto: 150 }));
      ok(e1 === null, `con el corte en BORRADOR el importe todavía se puede corregir (${dijo(e1)})`);

      await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        contado: 400, morralla: 0, esperado: 400, diferencia: 0, total_ingresos: 0, total_gastos: 100, total_depositos: 0,
      });
      await trx('finance.cash_ledger_cut_denominations').insert({
        tenant_id: T, cut_id: c.id, denom_key: '200', denominacion: 200, piezas: 2, momento: 'cierre',
      });
      await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        estado: 'cerrado', closed_by: CAJERA, closed_by_username: 'cajera_prueba', closed_at: trx.fn.now(),
      });
      ok(true, 'el corte se cerró');

      console.log('\n── 2. ⛔ CGS.11 — lo firmado no se edita por debajo ──');
      const e2a = await intento(trx, () => trx('finance.cash_ledger').where({ id: m1.id }).update({ monto: 101 }));
      ok(es(e2a, '23514', 'cash_ledger_en_corte_firmado_chk'),
        `[negativa] cambiar el importe de un movimiento firmado → cash_ledger_en_corte_firmado_chk (${dijo(e2a)})`);
      const e2b = await intento(trx, () => trx('finance.cash_ledger').where({ id: m1.id }).update({ tipo: 'ingreso' }));
      ok(es(e2b, '23514', 'cash_ledger_en_corte_firmado_chk'),
        `[negativa] cambiar ingreso↔gasto (el caso de CI-2026-00063) → cash_ledger_en_corte_firmado_chk (${dijo(e2b)})`);
      const e2c = await intento(trx, () => trx('finance.cash_ledger').where({ id: m1.id }).update({ corte_id: null }));
      ok(es(e2c, '23514', 'cash_ledger_en_corte_firmado_chk'),
        `[negativa] sacarlo del corte → cash_ledger_en_corte_firmado_chk (${dijo(e2c)})`);
      const e2d = await intento(trx, () => trx('finance.cash_ledger').where({ id: m1.id }).del());
      ok(es(e2d, '23514', 'cash_ledger_en_corte_firmado_chk'),
        `[negativa] borrarlo → cash_ledger_en_corte_firmado_chk (${dijo(e2d)})`);

      console.log('\n── 3. CGS.10 — la evidencia sí cambia, y deja rastro ──');
      const cuenta = async (tabla, pk) => Number((await trx.raw(
        `SELECT count(*)::int AS n FROM analytics.master_data_history WHERE tabla = ? AND pk = ?`, [tabla, pk])).rows[0].n);
      const antes = await cuenta('finance.cash_ledger', m1.id);
      const e3 = await intento(trx, async () => {
        await trx('finance.cash_ledger').where({ id: m1.id }).update({ glosa: 'Movimiento de prueba CGS, glosa corregida' });
        const despues = await cuenta('finance.cash_ledger', m1.id);
        if (despues !== antes + 1) throw new Error(`historial: ${antes} → ${despues}`);
        const r = (await trx.raw(
          `SELECT db_role, diff FROM analytics.master_data_history WHERE tabla = 'finance.cash_ledger' AND pk = ?
            ORDER BY id DESC LIMIT 1`, [m1.id])).rows[0];
        if (!r.diff.glosa) throw new Error('el diff no trae la glosa');
        if (hayRol && r.db_role !== 'app_runtime') throw new Error(`db_role = ${r.db_role}`);
      });
      ok(e3 === null, `corregir la glosa de un movimiento firmado pasa y deja UNA fila con el diff y el rol (${dijo(e3)})`);

      console.log('\n── 4. ⛔ CGS.16 — quien autoriza es ajeno al corte ──');
      const autorizar = (u) => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        estado: 'autorizado', authorized_by: u, authorized_by_username: 'quien_prueba', authorized_at: trx.fn.now(),
      });
      const e4a = await intento(trx, () => autorizar(CAPTURA));
      ok(es(e4a, '23514', 'cut_autoriza_lo_ajeno_chk'),
        `[negativa] autoriza quien capturó un movimiento del corte → cut_autoriza_lo_ajeno_chk (${dijo(e4a)})`);
      const e4b = await intento(trx, () => autorizar(ABRE));
      ok(es(e4b, '23514', 'cut_autoriza_lo_ajeno_chk'),
        `[negativa] autoriza quien abrió el corte → cut_autoriza_lo_ajeno_chk (${dijo(e4b)})`);
      const e4c = await intento(trx, () => autorizar(CANCELA));
      ok(es(e4c, '23514', 'cut_autoriza_lo_ajeno_chk'),
        `[negativa] autoriza quien canceló un movimiento del corte → cut_autoriza_lo_ajeno_chk (${dijo(e4c)})`);
      // ⭐ Las dos reglas NO compiten, se reparten el trabajo (corregido el 2026-10-21):
      //   · `cut_doble_llave_chk` (CHECK, 2026-09-18) — quien CERRÓ no autoriza.
      //   · `cut_autoriza_lo_ajeno_chk` (trigger de cgs10) — quien ABRIÓ, CAPTURÓ o CANCELÓ no autoriza.
      //   El trigger NO mira `closed_by`. El rojo del 21-oct no era un empate de mecanismos: CAJERA
      //   había creado el movimiento cancelado, así que caía en la segunda regla antes de llegar
      //   al CHECK. Con CAJERA sólo cerrando, cada caso mide su regla por su nombre.
      const e4d = await intento(trx, () => autorizar(CAJERA));
      ok(es(e4d, '23514', 'cut_doble_llave_chk'),
        `[negativa] autoriza quien cerró (y no capturó nada) → cut_doble_llave_chk (${dijo(e4d)})`);
      const antesCorte = await cuenta('finance.cash_ledger_cuts', c.id);
      const e4e = await intento(trx, async () => {
        await autorizar(AUTORIZA);
        const despues = await cuenta('finance.cash_ledger_cuts', c.id);
        if (despues !== antesCorte + 1) throw new Error(`historial del corte: ${antesCorte} → ${despues}`);
      });
      ok(e4e === null, `autoriza alguien ajeno: pasa y la autorización queda en el historial (${dijo(e4e)})`);

      console.log('\n── 4b. CGS.18 — observar no mueve cifras ──');
      const yaObservado = (await trx.raw(
        `SELECT 1 FROM pg_constraint WHERE conname = 'cut_observa_ajeno_chk'`)).rows.length === 1;
      if (!yaObservado) {
        skip('la migración 20261021111319 (estado observado) no está aplicada en esta base.');
      } else {
        const observar = (u, motivo = 'Falta la pierna del depósito del banco') => trx('finance.cash_ledger_cuts')
          .where({ id: c.id }).update({
            estado: 'observado', observed_by: u, observed_by_username: 'quien_prueba', observed_at: trx.fn.now(), observacion: motivo,
          });
        const e4f = await intento(trx, () => observar(AUTORIZA));
        ok(e4f === null, `observar con motivo, por alguien ajeno, pasa (${dijo(e4f)})`);
        const e4g = await intento(trx, () => observar(CAJERA));
        ok(es(e4g, '23514', 'cut_observa_ajeno_chk'),
          `[negativa] observa quien cerró → cut_observa_ajeno_chk (${dijo(e4g)})`);
        const e4h = await intento(trx, () => observar(AUTORIZA, 'corto'));
        ok(es(e4h, '23514', 'cut_observado_completo_chk'),
          `[negativa] observar sin motivo de 10+ → cut_observado_completo_chk (${dijo(e4h)})`);
        const e4i = await intento(trx, async () => {
          await observar(AUTORIZA);
          await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ esperado: 999, diferencia: 400 - 999 });
        });
        ok(es(e4i, '23514', 'cut_firmado_inmutable_chk'),
          `[negativa] un corte observado sigue firmado: su esperado no cambia → cut_firmado_inmutable_chk (${dijo(e4i)})`);
        const e4j = await intento(trx, async () => {
          await observar(AUTORIZA);
          await trx('finance.cash_ledger').where({ id: m1.id }).update({ monto: 5 });
        });
        ok(es(e4j, '23514', 'cash_ledger_en_corte_firmado_chk'),
          `[negativa] y sus movimientos tampoco → cash_ledger_en_corte_firmado_chk (${dijo(e4j)})`);
      }

      console.log('\n── 4c. CGS.15 — la llave de emergencia ──');
      const hayLlaves = (await trx.raw(`SELECT to_regclass('finance.cash_ledger_llaves') IS NOT NULL AS t`)).rows[0].t;
      if (!hayLlaves) {
        skip('la migración 20261021112928 (llave de emergencia) no está aplicada en esta base.');
      } else {
        const llave = (over = {}) => ({
          tenant_id: T, sucursal: '00', para_usuario: CAJERA, otorgada_por: AUTORIZA,
          motivo: 'Pago urgente de prueba CGS', created_by: AUTORIZA,
          vence_at: trx.raw(`now() + interval '1 hour'`), ...over,
        });
        const e5a = await intento(trx, () => trx('finance.cash_ledger_llaves').insert(llave()));
        ok(e5a === null, `dar una llave a OTRA persona, con motivo, pasa (${dijo(e5a)})`);
        const e5b = await intento(trx, () => trx('finance.cash_ledger_llaves').insert(llave({ para_usuario: AUTORIZA })));
        ok(es(e5b, '23514', 'llave_ajena_chk'), `[negativa] darse la llave a sí misma → llave_ajena_chk (${dijo(e5b)})`);
        const e5c = await intento(trx, () => trx('finance.cash_ledger_llaves').insert(llave({ motivo: 'ya' })));
        ok(es(e5c, '23514', 'llave_motivo_chk'), `[negativa] sin motivo de 10+ → llave_motivo_chk (${dijo(e5c)})`);
        if (hayRol) {
          const e5d = await intento(trx, async () => {
            await trx('finance.cash_ledger_llaves').insert(llave());
            await trx('finance.cash_ledger_llaves').where({ otorgada_por: AUTORIZA }).update({ motivo: 'Lo cambio despues de darla' });
          });
          ok(!!e5d && e5d.code === '42501', `[negativa] la app no puede EDITAR una llave dada: sólo se agrega (${dijo(e5d)})`);
        } else {
          skip('sin app_runtime no se puede medir que la llave sea sólo-agregar.');
        }
      }

      console.log('\n── 4d. CGS.22 — el conteo físico de la caja fuerte ──');
      const hayConteos = (await trx.raw(`SELECT to_regclass('finance.caos_conteos_fisicos') IS NOT NULL AS t`)).rows[0].t;
      if (!hayConteos) {
        skip('la migración 20261021135209 (conteo físico de CAOS) no está aplicada en esta base.');
      } else {
        const conteo = (over = {}) => ({
          tenant_id: T, piezas: JSON.stringify([{ denominacion: 500, piezas: 2 }]), total: 1000,
          referencia_total: 1200, diferencia: -200, created_by: AUTORIZA, ...over,
        });
        const e6a = await intento(trx, () => trx('finance.caos_conteos_fisicos').insert(conteo()));
        ok(e6a === null, `guardar un conteo con su referencia y su diferencia exacta pasa (${dijo(e6a)})`);
        const e6b = await intento(trx, () => trx('finance.caos_conteos_fisicos').insert(conteo({ diferencia: 0 })));
        ok(es(e6b, '23514', 'caos_conteo_dif_chk'), `[negativa] una diferencia que no es total − referencia → caos_conteo_dif_chk (${dijo(e6b)})`);
        const e6c = await intento(trx, () => trx('finance.caos_conteos_fisicos').insert(conteo({ referencia_total: null, diferencia: 0 })));
        ok(es(e6c, '23514', 'caos_conteo_dif_chk'), `[negativa] sin referencia la diferencia NO es cero: es NULL → caos_conteo_dif_chk (${dijo(e6c)})`);
        if (hayRol) {
          const e6d = await intento(trx, async () => {
            await trx('finance.caos_conteos_fisicos').insert(conteo());
            await trx('finance.caos_conteos_fisicos').where({ created_by: AUTORIZA }).update({ total: 1200 });
          });
          ok(!!e6d && e6d.code === '42501', `[negativa] un conteo guardado no se edita: sólo se agrega (${dijo(e6d)})`);
        }
      }

      console.log('\n── 5. ⛔ MUTACIONES: sin cada regla, la violación SÍ pasa ──');
      if (hayRol) await trx.raw('RESET ROLE');
      // Postgres no deja ALTER TABLE con eventos de trigger diferidos pendientes (el desglose del
      // corte): se consumen acá, y de paso se comprueba que el corte de la suite cuadra.
      await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
      await trx.raw('SET CONSTRAINTS ALL DEFERRED');
      const sinCandado = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger DISABLE TRIGGER trg_cash_ledger_congelado');
        await trx('finance.cash_ledger').where({ id: m1.id }).update({ monto: 999 });
      });
      ok(sinCandado === null, `con el candado APAGADO el importe firmado sí cambia (${dijo(sinCandado)}): la sección 2 mide el trigger`);
      const sinAjeno = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger_cuts DISABLE TRIGGER trg_cash_cut_autoriza_ajeno');
        await autorizar(CAPTURA);
      });
      ok(sinAjeno === null, `con la regla APAGADA el capturista sí autoriza (${dijo(sinAjeno)}): la sección 4 mide el trigger`);

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
