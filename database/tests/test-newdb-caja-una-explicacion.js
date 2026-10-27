/* eslint-disable no-console */
/**
 * `[LE.0.0]` — **Cada peso, una explicación** (Fase LE, regla de banco B4), ejercida contra una base
 * REAL: un depósito de CAOS que el libro de Caja General explica no puede tener además un reparto
 * automático (`CG.58`).
 *
 * Migración: `20261027101810_le00_baja_atribuciones_dobles_de_caos.js`. Lo que la motivó: 86
 * depósitos ($1,703,230) con DOS explicaciones en prod el 2026-10-27.
 *
 *   · escribe como `app_runtime` (el rol de prod); si el rol no existe lo declara NO MEDIDO;
 *   · cada regla con su violación, esperando el código Y el nombre exacto;
 *   · cierra con MUTACIONES: apaga cada trigger y comprueba que la violación entonces SÍ pasa.
 *
 * Todo en UNA transacción con rollback: cero efecto en la base.
 * Uso: DATABASE_URL_NEW=… DATABASE_URL_NEW_RUNTIME=… node database/tests/test-newdb-caja-una-explicacion.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-una-explicacion');

const T = '00000000-0000-0000-0000-00000000d01c';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
const DEV = `UNA-${Date.now().toString(36)}`;
const DIA = '2099-03-02';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

let n = 0;
const deposito = (total) => ({
  tenant_id: T, device: DEV, external_id: 6_000_000 + (n += 1), type_id: 0, type_label: 'Deposito',
  occurred_at: `${DIA}T18:00:00-06:00`, accounting_date: DIA, user_external: 'Vendedor (006) - VENTAS',
  total, ref: 'ruta 27 020399', _row_hash: `una-${DEV}-${n}`,
});
const atribucion = (m, monto, cobro) => ({
  tenant_id: T, caos_device: m.device, caos_external_id: m.external_id, caos_occurred_at: m.occurred_at,
  cobro_origen_ref: cobro, cobro_fecha: '2099-03-01', monto, cobro_monto: monto,
});
const ingreso = (monto, origen = {}) => ({
  tenant_id: T, folio: `UNA-${DEV}-${(n += 1)}`, tipo: 'ingreso', fecha: DIA, sucursal: '00',
  kepler_cuenta: '101-001', kepler_concepto: '001', glosa: 'cobro de ruta de prueba', monto,
  created_by: CAJERA, ...origen,
});

async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message) }; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const rechaza = (err, code, nombre) => !!err && err.code === code && (err.constraint === nombre || err.message.includes(nombre));

(async () => {
  console.log('\n🧪 [LE.0.0] Cada peso, una explicación — contra base real\n');
  const t = (await knex.raw(`SELECT to_regprocedure('finance.caos_deposito_en_libro(uuid,text,bigint)') AS fn,
      to_regclass('finance.caos_ingreso_atribucion') AS atrib`)).rows[0];
  if (!t.fn || !t.atrib) {
    skip('la migración 20261027101810 no está aplicada en esta base');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }
  const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!hayRol) skip('no existe el rol app_runtime: las escrituras corren como superusuario y RLS no se prueba');

  try {
    await knex.transaction(async (trx) => {
      const comoApp = async () => {
        if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      };
      await comoApp();

      console.log('── 1. Un depósito sin explicación en el libro SÍ admite el reparto automático ──');
      const [d1] = await trx('analytics.caos_cash_movements').insert(deposito(18940)).returning('*');
      ok(!(await intento(trx, () => trx('finance.caos_ingreso_atribucion').insert(atribucion(d1, 18940, '00|U-A-5|0099001|0011')))),
        'el reparto puede explicar un depósito que nadie explicó');
      const [a1] = await trx('finance.caos_ingreso_atribucion').insert(atribucion(d1, 18940, '00|U-A-5|0099001|0011')).returning('*');

      console.log('\n── 2. Cuando una persona lo explica en el libro, la suposición se retira ──');
      const [g1] = await trx('finance.cash_ledger').insert(ingreso(18942, { origen_tipo: 'cobro', origen_ref: '01-005|U-A-5|0000024|0011' })).returning('*');
      await trx('finance.caos_cash_links').insert({
        tenant_id: T, cash_ledger_id: g1.id, caos_device: d1.device, caos_external_id: d1.external_id,
        monto_enlazado: 18940, confirmed_by: CAJERA,
      });
      const a1b = await trx('finance.caos_ingreso_atribucion').where({ id: a1.id }).first();
      ok(a1b && a1b.deleted_at !== null, 'ligar el depósito a su cobro en el libro da de BAJA la atribución automática');

      console.log('\n── 3. Lo que el libro explica no admite otra explicación ──');
      const e1 = await intento(trx, () => trx('finance.caos_ingreso_atribucion').insert(atribucion(d1, 9656.13, '00|U-A-5|0023614|0011')));
      ok(rechaza(e1, '23514', 'caos_atribucion_deposito_en_libro'),
        `NEGATIVA: un reparto sobre un depósito explicado por el libro se rechaza (${e1 && e1.code})`);
      const e2 = await intento(trx, () => trx('finance.caos_ingreso_atribucion').where({ id: a1.id }).update({ deleted_at: null }));
      ok(rechaza(e2, '23514', 'caos_atribucion_deposito_en_libro'), 'NEGATIVA: tampoco se revive la que se dio de baja');

      console.log('\n── 4. La captura del movimiento entero también lo explica ──');
      const [d2] = await trx('analytics.caos_cash_movements').insert(deposito(5000)).returning('*');
      const [a2] = await trx('finance.caos_ingreso_atribucion').insert(atribucion(d2, 5000, '00|U-A-5|0099002|0011')).returning('*');
      await trx('finance.cash_ledger').insert(ingreso(5000, { origen_tipo: 'caos', origen_ref: `${d2.device}|${d2.external_id}` }));
      const a2b = await trx('finance.caos_ingreso_atribucion').where({ id: a2.id }).first();
      ok(a2b && a2b.deleted_at !== null, 'capturar el depósito como movimiento del libro retira el reparto');

      console.log('\n── 5. Mutaciones: con el trigger apagado, la violación SÍ pasa ──');
      await trx.raw('RESET ROLE');
      await trx.raw('ALTER TABLE finance.caos_ingreso_atribucion DISABLE TRIGGER trg_caos_atribucion_no_dobla');
      await comoApp();
      const m1 = await intento(trx, () => trx('finance.caos_ingreso_atribucion').insert(atribucion(d1, 100, '00|U-A-5|0099003|0011')));
      ok(!m1, 'MUTACIÓN: sin trg_caos_atribucion_no_dobla el depósito explicado SÍ acepta un reparto: la regla es el trigger');
      await trx.raw('RESET ROLE');
      await trx.raw('ALTER TABLE finance.caos_ingreso_atribucion ENABLE TRIGGER trg_caos_atribucion_no_dobla');
      await trx.raw('ALTER TABLE finance.caos_cash_links DISABLE TRIGGER trg_caos_link_retira_atribucion');
      await comoApp();
      const [d3] = await trx('analytics.caos_cash_movements').insert(deposito(700)).returning('*');
      const [a3] = await trx('finance.caos_ingreso_atribucion').insert(atribucion(d3, 700, '00|U-A-5|0099004|0011')).returning('*');
      const [g3] = await trx('finance.cash_ledger').insert(ingreso(700)).returning('*');
      await trx('finance.caos_cash_links').insert({
        tenant_id: T, cash_ledger_id: g3.id, caos_device: d3.device, caos_external_id: d3.external_id,
        monto_enlazado: 700, confirmed_by: CAJERA,
      });
      const a3b = await trx('finance.caos_ingreso_atribucion').where({ id: a3.id }).first();
      ok(a3b && a3b.deleted_at === null, 'MUTACIÓN: sin trg_caos_link_retira_atribucion la suposición queda viva junto al libro: la regla es el trigger');

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.log('  💥', e.message); }
  }

  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
