/* eslint-disable no-console */
/**
 * `[CGP-D.3]` — Las reglas del dinero del corte, ejercidas contra una base REAL.
 *
 * Migración: `20261014212702_finance_cash_cut_invariantes.js`. Plan:
 * `docs/IMPLEMENTACION/FASES/FASE_CG_PLAN_POR_CAPAS.md` §5.
 *
 * Por qué existe: del 12 al 14-oct entraron 33 arreglos de Caja General y cada uno destapó el
 * siguiente EN PRODUCCIÓN, porque ninguna prueba ejercía el corte contra una base. Esta suite:
 *
 *   · escribe como `app_runtime`, el rol que usa producción (GOTCHAS §80: un ensayo con otro rol
 *     no ensayó nada); si el rol no existe en esta base lo declara NO MEDIDO;
 *   · reproduce el ORDEN de escritura del servicio (primero el corte, después el desglose), que
 *     es lo que obliga a que la regla del desglose sea diferida;
 *   · cada regla tiene su violación esperando el código Y el nombre exacto de la regla, porque el
 *     nombre es lo que `traducirErrorDeCaja` convierte en una frase;
 *   · cierra con MUTACIONES: apaga cada trigger y comprueba que la violación entonces SÍ pasa.
 *     Si con la regla apagada todo sigue igual, la suite es decorativa.
 *
 * Todo corre dentro de UNA transacción con rollback: cero efecto en la base.
 * Uso: DATABASE_URL_NEW=postgresql://...@127.0.0.1:5432/postgres_platform node database/tests/test-newdb-caja-invariantes.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-invariantes');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_T = '00000000-0000-0000-0000-0000000000ff';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
const AUTORIZA = '00000000-0000-0000-0000-0000000000c2';
// Sucursales y fechas que no existen en ningún dato real: la suite no puede chocar con un corte
// abierto de verdad si alguien la corre contra una base con historia.
const FECHA = '2099-01-01';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

let n = 0;
const corte = (over = {}) => ({
  tenant_id: T, folio: `CGP-TEST-${Date.now()}-${(n += 1)}`, fecha: FECHA, sucursal: 'T1',
  fondo_inicial: 500, fondo_origen: 'contado',
  created_by: CAJERA, created_by_username: 'cajera_prueba', ...over,
});
const den = (cutId, key, valor, piezas, momento = 'cierre') => ({
  tenant_id: T, cut_id: cutId, denom_key: key, denominacion: valor, piezas, momento,
});

/** Corre `fn` en un SAVEPOINT que SIEMPRE se deshace, y devuelve el error (o null). */
async function intento(trx, fn, { inmediato = false } = {}) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try {
    await fn();
    if (inmediato) await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
  } catch (e) {
    err = { code: e.code, constraint: e.constraint, message: String(e.message).slice(-200) };
  }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  await trx.raw('SET CONSTRAINTS ALL DEFERRED');
  return err;
}

/** Fuerza AHORA las reglas diferidas sobre lo ya escrito. null = cuadra. */
async function chequeoDiferido(trx) {
  await trx.raw('SAVEPOINT chk');
  let err = null;
  try {
    await trx.raw('SET CONSTRAINTS ALL IMMEDIATE');
    await trx.raw('RELEASE SAVEPOINT chk');
  } catch (e) {
    err = { code: e.code, constraint: e.constraint, message: String(e.message).slice(-200) };
    await trx.raw('ROLLBACK TO SAVEPOINT chk');
  }
  await trx.raw('SET CONSTRAINTS ALL DEFERRED');
  return err;
}

const es = (err, code, constraint) => !!err && err.code === code && err.constraint === constraint;
const dijo = (err) => (err ? `${err.code} ${err.constraint ?? '(sin nombre)'}` : 'pasó sin error');

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const f = await knex.raw(`
      SELECT to_regprocedure('finance.cash_cut_guardia()') AS guardia,
             to_regprocedure('finance.cash_cut_desglose_cuadra()') AS desglose`);
    if (!f.rows[0].guardia || !f.rows[0].desglose) {
      ok(false, 'la migración 20261014212702 NO está aplicada en esta base: nada de lo que sigue se puede medir');
      return;
    }
    const trg = await knex.raw(`
      SELECT tgname, tgenabled, tgdeferrable, tginitdeferred FROM pg_trigger
       WHERE tgname IN ('trg_cash_cut_guardia','trg_cash_cut_desglose_cuadra_corte','trg_cash_cut_desglose_cuadra_desglose')`);
    const porNombre = Object.fromEntries(trg.rows.map((r) => [r.tgname, r]));
    ok(trg.rows.length === 3 && trg.rows.every((r) => r.tgenabled === 'O'),
      `los 3 triggers existen y están ENCENDIDOS (hay ${trg.rows.length})`);
    ok(porNombre.trg_cash_cut_desglose_cuadra_corte?.tginitdeferred === true
      && porNombre.trg_cash_cut_desglose_cuadra_desglose?.tginitdeferred === true,
      'la regla del desglose es DIFERIDA: el servicio escribe el corte antes que el desglose');
    const idx = await knex.raw(`SELECT to_regclass('finance.ux_cash_cut_sucursal_fecha') AS i`);
    ok(!!idx.rows[0].i, 'existe el índice de un corte por sucursal y fecha');

    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

    console.log('\n── 1. Permisos con el rol que EJECUTA ──');
    if (!hayRol) {
      skip('el rol app_runtime no existe en esta base: permisos y RLS no se pueden medir con el rol de producción.');
    } else {
      // ⚠️ Un privilegio por llamada: con una lista separada por comas, `has_table_privilege`
      // devuelve true si el rol tiene CUALQUIERA de ellos, no todos.
      const p = await knex.raw(`
        SELECT has_schema_privilege('app_runtime','finance','USAGE') AS usage,
               has_table_privilege('app_runtime','finance.cash_ledger_cuts','SELECT')
           AND has_table_privilege('app_runtime','finance.cash_ledger_cuts','INSERT')
           AND has_table_privilege('app_runtime','finance.cash_ledger_cuts','UPDATE') AS cortes,
               has_table_privilege('app_runtime','finance.cash_ledger_cut_denominations','SELECT')
           AND has_table_privilege('app_runtime','finance.cash_ledger_cut_denominations','INSERT')
           AND has_table_privilege('app_runtime','finance.cash_ledger_cut_denominations','DELETE') AS desglose`);
      const r = p.rows[0];
      ok(r.usage === true, 'app_runtime tiene USAGE sobre el schema finance (sin esto los GRANT de tabla no sirven, CG.158)');
      ok(r.cortes === true, 'app_runtime puede leer, abrir y actualizar cortes');
      ok(r.desglose === true, 'app_runtime puede leer, escribir y borrar el desglose (el reconteo lo reescribe)');
    }

    await knex.transaction(async (trx) => {
      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const quien = (await trx.raw('SELECT current_user AS u')).rows[0].u;
      console.log(`  (las escrituras de las secciones 2 a 8 corren como ${quien})`);

      console.log('\n── 2. Abrir, contar y sellar: el camino feliz ──');
      const [c] = await trx('finance.cash_ledger_cuts').insert(corte()).returning('*');
      ok(c.estado === 'borrador' && c.contado === null, 'el corte nace en borrador y sin contado');
      await trx('finance.cash_ledger_cut_denominations').insert(den(c.id, '500', 500, 1, 'apertura'));
      // Como `sellarConteo`: primero el corte, después el desglose.
      await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        contado: 1300, morralla: 0, esperado: 1300, diferencia: 0,
        total_ingresos: 800, total_gastos: 0, total_depositos: 0,
      });
      await trx('finance.cash_ledger_cut_denominations').insert([
        den(c.id, '1000', 1000, 1), den(c.id, '200', 200, 1), den(c.id, '100', 100, 1),
      ]);
      const e2 = await chequeoDiferido(trx);
      ok(e2 === null, `sellar un conteo cuyo desglose cuadra pasa, y el desglose de APERTURA no cuenta (${dijo(e2)})`);

      console.log('\n── 3. ⛔ El arqueo ciego no se salta (el hueco de cerrar() con la reja tecleada) ──');
      const e3 = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id })
        .update({ contado: 9999, diferencia: 9999 - 1300 }));
      ok(es(e3, '23514', 'cut_conteo_sellado_chk'),
        `[negativa] cambiar el contado sellado sin reconteo → 23514 cut_conteo_sellado_chk (${dijo(e3)})`);
      const e3b = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id })
        .update({ contado: 1300, updated_at: trx.fn.now() }));
      ok(e3b === null, `reescribir el MISMO contado (lo que hace cerrar() con el conteo sellado) pasa (${dijo(e3b)})`);

      console.log('\n── 4. El reconteo deja constancia exacta ──');
      const e4 = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        conteo_previo: JSON.stringify({ contado: 1250 }), reconteo_motivo: 'Constancia que no coincide',
      }));
      ok(es(e4, '23514', 'cut_reconteo_constancia_chk'),
        `[negativa] un reconteo que no conserva el contado que reemplaza → cut_reconteo_constancia_chk (${dijo(e4)})`);

      const [sinContar] = await trx('finance.cash_ledger_cuts')
        .insert(corte({ sucursal: 'T3', fondo_inicial: null, fondo_origen: null })).returning('*');
      const e4b = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: sinContar.id }).update({
        conteo_previo: JSON.stringify({ contado: 100 }), reconteo_motivo: 'Reconteo sin conteo previo',
      }));
      ok(es(e4b, '23514', 'cut_reconteo_constancia_chk'),
        `[negativa] un reconteo sin conteo previo no existe → cut_reconteo_constancia_chk (${dijo(e4b)})`);

      // Como `recontar()`: DOS updates en la misma transacción, y después el desglose nuevo.
      const e4c = await intento(trx, async () => {
        await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
          conteo_previo: JSON.stringify({ contado: 1300, morralla: 0 }),
          reconteo_motivo: 'Se contó de más un billete de 100',
        });
        await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ contado: 1200, diferencia: -100 });
        await trx('finance.cash_ledger_cut_denominations').where({ cut_id: c.id, momento: 'cierre' }).del();
        await trx('finance.cash_ledger_cut_denominations').insert([den(c.id, '1000', 1000, 1), den(c.id, '200', 200, 1)]);
      }, { inmediato: true });
      ok(e4c === null, `el reconteo como lo hace recontar() (dos UPDATE + desglose nuevo) pasa completo (${dijo(e4c)})`);

      console.log('\n── 5. El desglose cuadra con el contado (regla diferida) ──');
      const [c2] = await trx('finance.cash_ledger_cuts').insert(corte({ sucursal: 'T2' })).returning('*');
      const e5 = await intento(trx, async () => {
        await trx('finance.cash_ledger_cuts').where({ id: c2.id }).update({ contado: 500, esperado: 500, diferencia: 0 });
        await trx('finance.cash_ledger_cut_denominations').insert(den(c2.id, '200', 200, 2));
      }, { inmediato: true });
      ok(es(e5, '23514', 'cut_desglose_cuadra_chk'),
        `[negativa] un desglose de $400 con contado de $500 → cut_desglose_cuadra_chk (${dijo(e5)})`);
      const e5b = await intento(trx, () => trx('finance.cash_ledger_cut_denominations')
        .insert(den(sinContar.id, '100', 100, 1)), { inmediato: true });
      ok(es(e5b, '23514', 'cut_desglose_cuadra_chk'),
        `[negativa] desglose de cierre en un corte sin contado → cut_desglose_cuadra_chk (${dijo(e5b)})`);
      const e5c = await intento(trx, async () => {
        await trx('finance.cash_ledger_cuts').where({ id: c2.id }).update({ contado: 512.5, morralla: 12.5, esperado: 512.5, diferencia: 0 });
        await trx('finance.cash_ledger_cut_denominations').insert(den(c2.id, '500', 500, 1));
      }, { inmediato: true });
      ok(e5c === null, `la morralla cuenta: $500 en billete + $12.50 = contado $512.50 (${dijo(e5c)})`);

      console.log('\n── 6. Aritmética del cuadre ──');
      const e6 = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ diferencia: 5 }));
      ok(es(e6, '23514', 'cut_aritmetica_chk'),
        `[negativa] diferencia distinta de contado − esperado → cut_aritmetica_chk (${dijo(e6)})`);

      console.log('\n── 7. Un corte firmado es una foto ──');
      // La sección 4 corrió en un SAVEPOINT deshecho: `c` sigue con su conteo de 1300 y sin
      // reconteo, y la marca de reconteo (local a ese savepoint) también se deshizo.
      const [cerrado] = await trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        estado: 'cerrado', closed_by: CAJERA, closed_by_username: 'cajera_prueba', closed_at: trx.fn.now(),
      }).returning('*');
      ok(cerrado.estado === 'cerrado', 'cerrar con el conteo sellado pasa');
      const e7 = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ esperado: 1 }));
      ok(es(e7, '23514', 'cut_firmado_inmutable_chk'),
        `[negativa] cambiar el esperado de un corte cerrado → cut_firmado_inmutable_chk (${dijo(e7)})`);
      const e7b = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({ estado: 'borrador' }));
      ok(es(e7b, '23514', 'cut_firmado_inmutable_chk'),
        `[negativa] reabrir un corte cerrado → cut_firmado_inmutable_chk (${dijo(e7b)})`);
      const e7c = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id }).update({
        estado: 'autorizado', authorized_by: AUTORIZA, authorized_by_username: 'autoriza_prueba', authorized_at: trx.fn.now(),
      }));
      ok(e7c === null, `autorizar con OTRA persona sigue pasando: la foto no impide la segunda llave (${dijo(e7c)})`);

      console.log('\n── 8. Un corte por sucursal y fecha ──');
      const e8 = await intento(trx, () => trx('finance.cash_ledger_cuts').insert(corte()));
      ok(es(e8, '23505', 'ux_cash_cut_sucursal_fecha'),
        `[negativa] un segundo corte de la misma sucursal y fecha (ya cerrado el primero) → ux_cash_cut_sucursal_fecha (${dijo(e8)})`);
      const e8b = await intento(trx, () => trx('finance.cash_ledger_cuts').insert(corte({ fecha: '2099-01-02' })));
      ok(e8b === null, `el de la fecha siguiente sí se abre (${dijo(e8b)})`);

      console.log('\n── 9. RLS: otro tenant no ve el corte ──');
      if (!hayRol) {
        skip('sin app_runtime la sesión es superusuario y salta RLS: el aislamiento no se puede medir así.');
      } else {
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO_T]);
        const visto = await trx('finance.cash_ledger_cuts').where({ folio: c.folio }).first();
        ok(!visto, 'con otro tenant, el corte no existe para esta sesión');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
        const propio = await trx('finance.cash_ledger_cuts').where({ folio: c.folio }).first();
        ok(!!propio, 'con su tenant lo vuelve a ver (la prueba de arriba no pasó por estar vacía)');
      }

      console.log('\n── 10. ⛔ MUTACIONES: sin cada regla, la violación SÍ pasa ──');
      if (hayRol) await trx.raw('RESET ROLE');   // apagar un trigger exige ser dueño de la tabla
      const [m] = await trx('finance.cash_ledger_cuts')
        .insert(corte({ sucursal: 'T4', contado: 100, esperado: 100, diferencia: 0 })).returning('*');
      await trx('finance.cash_ledger_cut_denominations').insert(den(m.id, '100', 100, 1));
      // ⚠️ Postgres no deja hacer ALTER TABLE con eventos de trigger diferidos PENDIENTES en la
      // transacción. Se consumen acá (y de paso se comprueba que todo lo escrito hasta ahora
      // cuadra); si no, la mutación fallaría por eso y parecería que la regla la frenó.
      const pendientes = await chequeoDiferido(trx);
      ok(pendientes === null, `todo lo escrito por la suite hasta aquí cuadra (${dijo(pendientes)})`);

      const sinGuardia = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger_cuts DISABLE TRIGGER trg_cash_cut_guardia');
        await trx('finance.cash_ledger_cuts').where({ id: m.id }).update({ contado: 999, diferencia: 899, esperado: 100 });
      });
      ok(sinGuardia === null,
        `con la guardia APAGADA el contado sellado sí cambia (${dijo(sinGuardia)}): la regla de la sección 3 es el trigger, no otra cosa`);

      const sinDesglose = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger_cut_denominations DISABLE TRIGGER trg_cash_cut_desglose_cuadra_desglose');
        await trx('finance.cash_ledger_cut_denominations').insert(den(m.id, '50', 50, 1));
      }, { inmediato: true });
      ok(sinDesglose === null,
        `con la regla del desglose APAGADA, un desglose que no cuadra pasa (${dijo(sinDesglose)}): la sección 5 la mide de verdad`);

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
