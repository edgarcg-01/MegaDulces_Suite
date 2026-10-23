/* eslint-disable no-console */
/**
 * `[CGA-A.50]` — Un retiro de CAOS que paga muchos gastos, y la custodia de quien se lo llevó,
 * ejercidos contra una base REAL.
 *
 * Migración: `20261023162138_cga_a50_retiro_de_caos_en_custodia.js`. Motor puro:
 * `libs/finance/src/lib/caja/caja-custodia.engine.ts`.
 *
 *   · escribe como `app_runtime` (el rol de prod); si el rol no existe lo declara NO MEDIDO;
 *   · cada regla con su violación, esperando el código Y el nombre exacto;
 *   · cierra con MUTACIONES: apaga cada trigger y comprueba que la violación entonces SÍ pasa.
 *
 * Todo en UNA transacción con rollback: cero efecto en la base.
 * Uso: DATABASE_URL_NEW=postgresql://...@127.0.0.1:5432/postgres_platform node database/tests/test-newdb-caja-custodia.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-custodia');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO_T = '00000000-0000-0000-0000-0000000000ff';
const CAJERA = '00000000-0000-0000-0000-0000000000c1';
const DEV = `CUST-PRUEBA-${Date.now().toString(36)}`;
const FECHA = '2099-02-01';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

let n = 0;
const mov = (typeId, total) => ({
  tenant_id: T, device: DEV, external_id: 9_000_000 + (n += 1), type_id: typeId,
  type_label: typeId === 4 ? 'Dispensar' : 'Deposito', occurred_at: `${FECHA}T12:00:00-06:00`,
  accounting_date: FECHA, user_external: 'Prueba (003)', total, _row_hash: `cust-${DEV}-${n}`,
});
const gasto = (monto) => ({
  tenant_id: T, folio: `CUST-${DEV}-${(n += 1)}`, tipo: 'gasto', fecha: FECHA, sucursal: '00',
  kepler_cuenta: '601-001', kepler_concepto: '001', glosa: 'Gasto de prueba de custodia', monto, created_by: CAJERA,
});
const enlace = (m, g, monto) => ({
  tenant_id: T, cash_ledger_id: g.id, caos_device: m.device, caos_external_id: m.external_id, monto_enlazado: monto,
});

/** Corre `fn` en un SAVEPOINT que SIEMPRE se deshace, y devuelve el error (o null). */
async function intento(trx, fn) {
  await trx.raw('SAVEPOINT sp');
  let err = null;
  try { await fn(); } catch (e) { err = { code: e.code, constraint: e.constraint, message: String(e.message) }; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp');
  return err;
}
const rechaza = (err, code, nombre) => !!err && err.code === code && (err.constraint === nombre || err.message.includes(nombre));

(async () => {
  console.log('\n🧪 [CGA-A.50] Retiro de CAOS en custodia — contra base real\n');
  const t = (await knex.raw(`SELECT to_regclass('finance.caos_retiro_custodia') AS cust,
      (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_caos_link_no_excede')::int AS trg,
      to_regclass('analytics.caos_cash_movements') AS movs`)).rows[0];
  if (!t.cust || !t.trg || !t.movs) {
    skip('la migración 20261023162138 no está aplicada en esta base');
    console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
    await knex.destroy();
    process.exit(0);
  }
  const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length > 0;
  if (!hayRol) skip('no existe el rol app_runtime: las escrituras corren como superusuario y RLS no se prueba');

  try {
    await knex.transaction(async (trx) => {
      const comoApp = async (tenant = T) => {
        if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant]);
      };
      await comoApp();
      console.log(`  (escribe como ${(await trx.raw('SELECT current_user AS u')).rows[0].u})`);

      console.log('\n── 1. Un retiro de $200,000 paga varios gastos ──');
      const [ret] = await trx('analytics.caos_cash_movements').insert(mov(4, 200000)).returning('*');
      const [dep] = await trx('analytics.caos_cash_movements').insert(mov(0, 4000)).returning('*');
      const [g1] = await trx('finance.cash_ledger').insert(gasto(120000)).returning('*');
      const [g2] = await trx('finance.cash_ledger').insert(gasto(60000)).returning('*');
      const [g3] = await trx('finance.cash_ledger').insert(gasto(30000)).returning('*');

      ok(!(await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g1, 120000)))),
        'el primer gasto ($120,000) se enlaza');
      await trx('finance.caos_cash_links').insert(enlace(ret, g1, 120000));
      await trx('finance.caos_cash_links').insert(enlace(ret, g2, 60000));
      ok(true, 'el segundo gasto ($60,000) se enlaza al MISMO retiro (antes lo impedía ux_caos_link_vivo)');

      const e1 = await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g3, 30000)));
      ok(rechaza(e1, '23514', 'CAOS_LINK_EXCEDE_MOVIMIENTO'),
        `NEGATIVA: $120k + $60k + $30k pasa del retiro de $200k → CAOS_LINK_EXCEDE_MOVIMIENTO (${e1 && e1.code})`);
      ok(!(await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g3, 20000)))),
        'con $20,000 el retiro queda exacto y sí entra');

      console.log('\n── 2. Un gasto no se enlaza por más de lo que vale ──');
      const [ret2] = await trx('analytics.caos_cash_movements').insert(mov(4, 10000)).returning('*');
      const [g4] = await trx('finance.cash_ledger').insert(gasto(5000)).returning('*');
      const e2 = await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret2, g4, 6000)));
      ok(rechaza(e2, '23514', 'CAOS_LINK_EXCEDE_CAPTURA'),
        `NEGATIVA: enlazar $6,000 a un gasto de $5,000 → CAOS_LINK_EXCEDE_CAPTURA (${e2 && e2.code})`);

      console.log('\n── 3. El mismo par dos veces, y un movimiento que no existe ──');
      const e3 = await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g1, 1)));
      ok(rechaza(e3, '23505', 'ux_caos_link_par_vivo') || rechaza(e3, '23514', 'CAOS_LINK_EXCEDE_MOVIMIENTO'),
        `NEGATIVA: el mismo gasto con el mismo retiro no se repite (${e3 && e3.code})`);
      const e4 = await intento(trx, () => trx('finance.caos_cash_links').insert({ ...enlace(ret, g4, 1), caos_external_id: 1 }));
      ok(rechaza(e4, '23503', 'CAOS_LINK_SIN_MOVIMIENTO'), `NEGATIVA: un movimiento que no existe no se enlaza (${e4 && e4.code})`);

      console.log('\n── 4. Soltar un enlace libera su monto ──');
      await trx('finance.caos_cash_links').where({ cash_ledger_id: g2.id }).update({ deleted_at: trx.fn.now() });
      ok(!(await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g4, 5000)))),
        'con el enlace de $60,000 dado de baja, el retiro tiene lugar para otro gasto');

      console.log('\n── 5. La custodia ──');
      const cust = (over = {}) => ({
        tenant_id: T, caos_device: ret.device, caos_external_id: ret.external_id, destino: 'custodia',
        responsable: '003', created_by: CAJERA, ...over,
      });
      const e5 = await intento(trx, () => trx('finance.caos_retiro_custodia').insert(cust({ responsable: null })));
      ok(rechaza(e5, '23514', 'caos_cust_responsable_chk'), 'NEGATIVA: una custodia sin responsable no existe');
      const e6 = await intento(trx, () => trx('finance.caos_retiro_custodia').insert(cust({ caos_external_id: dep.external_id })));
      ok(rechaza(e6, '23514', 'CAOS_CUSTODIA_NO_ES_RETIRO'), 'NEGATIVA: un depósito no se pone en custodia');
      const [c] = await trx('finance.caos_retiro_custodia').insert(cust()).returning('*');
      ok(!!c.id, 'el retiro queda a cargo de 003');
      const e7 = await intento(trx, () => trx('finance.caos_retiro_custodia').insert(cust({ destino: 'cajon', responsable: null })));
      ok(rechaza(e7, '23505', 'ux_caos_cust_retiro_vivo'), 'NEGATIVA: un retiro tiene UNA sola clasificación viva');

      const cierre = (over) => trx('finance.caos_retiro_custodia').where({ id: c.id }).update({
        cierre_tipo: 'regreso_caos', cierre_monto: 4000, cierre_dia: FECHA, cierre_caos_external_id: dep.external_id,
        cerrado_by: CAJERA, cerrado_at: trx.fn.now(), ...over,
      });
      const e8 = await intento(trx, () => cierre({ cierre_monto: 4500 }));
      ok(rechaza(e8, '23514', 'CAOS_CUSTODIA_REGRESO_MONTO'),
        'NEGATIVA: el regreso a CAOS vale lo que contó la máquina, no lo que se teclea');
      const e9 = await intento(trx, () => cierre({ cierre_caos_external_id: null }));
      ok(rechaza(e9, '23514', 'caos_cust_regreso_con_deposito_chk'), 'NEGATIVA: un regreso a CAOS sin su depósito no existe');
      const e10 = await intento(trx, () => cierre({ cierre_dia: null }));
      ok(rechaza(e10, '23514', 'caos_cust_cierre_completo_chk'), 'NEGATIVA: un cierre a medias no existe');
      ok(!(await intento(trx, () => cierre({}))), 'el regreso de $4,000 con su depósito cierra la custodia');

      console.log('\n── 6. RLS ──');
      await comoApp(OTRO_T);
      const ajenas = await trx('finance.caos_retiro_custodia').where({ caos_device: DEV }).count({ n: '*' }).first();
      ok(Number(ajenas.n) === 0 || !hayRol, 'otro tenant no ve la custodia');
      await comoApp(T);

      console.log('\n── 7. Mutaciones: con el trigger apagado, la violación SÍ pasa ──');
      await trx.raw('RESET ROLE');
      await trx.raw('ALTER TABLE finance.caos_cash_links DISABLE TRIGGER trg_caos_link_no_excede');
      await comoApp(T);
      const [g5] = await trx('finance.cash_ledger').insert(gasto(999999)).returning('*');
      const m1 = await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g5, 999999)));
      ok(!m1, 'sin trg_caos_link_no_excede un retiro de $200k acepta $999,999 enlazados: la regla es el trigger');
      await trx.raw('RESET ROLE');
      await trx.raw('ALTER TABLE finance.caos_cash_links ENABLE TRIGGER trg_caos_link_no_excede');
      await trx.raw('ALTER TABLE finance.caos_retiro_custodia DISABLE TRIGGER trg_caos_custodia_valida');
      await comoApp(T);
      const m2 = await intento(trx, () => trx('finance.caos_retiro_custodia').insert(cust({ caos_external_id: dep.external_id })));
      ok(!m2, 'sin trg_caos_custodia_valida un depósito sí se pone en custodia: la regla es el trigger');

      throw new Error('__rollback__');
    });
  } catch (e) {
    if (e.message !== '__rollback__') { fail++; console.log('  💥', e.message); }
  }

  console.log(`\n${pass} ✓ / ${fail} ✗ / ${nomedido} NO MEDIDO`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
