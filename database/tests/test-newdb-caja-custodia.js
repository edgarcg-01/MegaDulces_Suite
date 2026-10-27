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
      // `[CGP-D.1.2]` El par se repite con LUGAR en el gasto y en el retiro: con `g1` (ya enlazado
      // completo) el trigger de monto saltaba antes que el índice y la prueba medía otra regla
      // (23514 CAOS_LINK_EXCEDE_CAPTURA). Así sólo `ux_caos_link_par_vivo` puede rechazarlo.
      const e3 = await intento(trx, async () => {
        await trx('finance.caos_cash_links').insert(enlace(ret, g3, 10000));
        await trx('finance.caos_cash_links').insert(enlace(ret, g3, 1));
      });
      ok(rechaza(e3, '23505', 'ux_caos_link_par_vivo'),
        `NEGATIVA: el mismo gasto con el mismo retiro no se repite (${e3 ? `${e3.code} ${e3.constraint}` : 'pasó'})`);
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
      // `[CGP-D.1.2]` Un regreso sin depósito lo frena PRIMERO el trigger (BEFORE UPDATE corre antes
      // que los CHECK), así que el CHECK `caos_cust_regreso_con_deposito_chk` sólo se alcanza por su
      // otro lado: un cierre que NO es regreso pero trae depósito. Se miden las dos defensas.
      const e9 = await intento(trx, () => cierre({ cierre_caos_external_id: null }));
      ok(rechaza(e9, '23514', 'CAOS_CUSTODIA_REGRESO_NO_ES_DEPOSITO'),
        `NEGATIVA: un regreso a CAOS sin su depósito no existe (${e9 ? `${e9.code} ${e9.constraint}` : 'pasó'})`);
      const e9b = await intento(trx, () => cierre({ cierre_tipo: 'cajon' }));
      ok(rechaza(e9b, '23514', 'caos_cust_regreso_con_deposito_chk'),
        `NEGATIVA: un cierre que no es regreso no se ata a un depósito de CAOS (${e9b ? `${e9b.code} ${e9b.constraint}` : 'pasó'})`);
      const e10 = await intento(trx, () => cierre({ cierre_dia: null }));
      ok(rechaza(e10, '23514', 'caos_cust_cierre_completo_chk'), 'NEGATIVA: un cierre a medias no existe');
      ok(!(await intento(trx, () => cierre({}))), 'el regreso de $4,000 con su depósito cierra la custodia');
      await cierre({});
      const [g6] = await trx('finance.cash_ledger').insert(gasto(1000)).returning('*');
      const e11 = await intento(trx, () => trx('finance.caos_cash_links').insert(enlace(ret, g6, 1000)));
      ok(rechaza(e11, '23514', 'caos_link_custodia_cerrada'),
        'NEGATIVA: a una custodia cerrada no se le enlaza un gasto más (se pagó con otro dinero, o el cierre estuvo mal)');

      console.log('\n── 6. RLS ──');
      await comoApp(OTRO_T);
      const ajenas = await trx('finance.caos_retiro_custodia').where({ caos_device: DEV }).count({ n: '*' }).first();
      ok(Number(ajenas.n) === 0 || !hayRol, 'otro tenant no ve la custodia');
      await comoApp(T);

      console.log('\n── 6a. [CGA-A.55.1] Cada llave de denominación vale lo que dice ──');
      // `finance.caos_denom_valor` decide si una llave de billete existe. La `a55` la dejó rota en
      // prod: knex cambió los `?` de su regex por `$1`/`$2`, devolvía NULL para TODA llave y el
      // trigger rechazaba cualquier enlace con billetes (CAOS_LINK_BILLETES_FORMA). Se mide la
      // función sola, antes que 6b, para que el rojo nombre la causa y no sólo el síntoma.
      const hayValor = (await trx.raw(`SELECT to_regprocedure('finance.caos_denom_valor(text)') AS f`)).rows[0].f;
      if (!hayValor) {
        skip('no existe finance.caos_denom_valor (migración 20261026110741)');
      } else {
        const valor = async (k) => (await trx.raw('SELECT finance.caos_denom_valor(?::text) AS v', [k])).rows[0].v;
        const fallasAntes = fail;
        for (const [k, esperado] of [['500', 500], ['1000', 1000], ['20', 20], ['0.5m', 0.5], ['10m', 10], ['2.5m', 2.5]]) {
          const v = await valor(k);
          ok(v !== null && Number(v) === esperado, `'${k}' vale ${esperado} (devolvió ${v})`);
        }
        for (const k of ['', 'abc', 'm', '5.', '-5', '500x']) {
          const v = await valor(k);
          ok(v === null, `NEGATIVA: '${k}' no es una llave → NULL (devolvió ${v})`);
        }
        if (fail > fallasAntes) {
          const { r } = (await trx.raw(`SELECT substring(prosrc from '~ ''[^'']*''') AS r FROM pg_proc
            WHERE oid = to_regprocedure('finance.caos_denom_valor(text)')`)).rows[0];
          console.log(`     regex guardada en la base: ${r} — si trae $1/$2, knex se comió un signo de interrogación`);
        }
      }

      console.log('\n── 6b. [CGA-A.55] Los billetes de cada pedazo del retiro ──');
      const hayBilletes = (await trx.raw(`SELECT count(*)::int n FROM information_schema.columns
        WHERE table_schema='finance' AND table_name='caos_cash_links' AND column_name='billetes'`)).rows[0].n > 0;
      if (!hayBilletes) {
        skip('la migración 20261026110741 (billetes por enlace) no está aplicada en esta base');
      } else {
        // El ejemplo de Edgar: $100,000 = 200 × $500, contados por la máquina.
        const [r3] = await trx('analytics.caos_cash_movements').insert(mov(4, 100000)).returning('*');
        await trx('analytics.caos_cash_denominations').insert({ tenant_id: T, movement_id: r3.id, denom: 500, pieza_tipo: 'B', quantity: 200 });
        const [ga] = await trx('finance.cash_ledger').insert(gasto(25000)).returning('*');
        const [gb] = await trx('finance.cash_ledger').insert(gasto(500)).returning('*');
        const [gc] = await trx('finance.cash_ledger').insert(gasto(500)).returning('*');
        const [gd] = await trx('finance.cash_ledger').insert(gasto(5000)).returning('*');
        const conB = (g, monto, billetes, cambio) => ({ ...enlace(r3, g, monto), billetes, cambio: cambio || null });

        ok(!(await intento(trx, () => trx('finance.caos_cash_links').insert(conB(ga, 25000, { 500: 50 })))),
          '50 × $500 = $25,000 de un retiro de 200 × $500: entra');
        await trx('finance.caos_cash_links').insert(conB(ga, 25000, { 500: 50 }));
        const b1 = await intento(trx, () => trx('finance.caos_cash_links').insert(conB(gd, 5000, { 500: 9 })));
        ok(rechaza(b1, '23514', 'caos_link_billetes_no_suman'), 'NEGATIVA: 9 × $500 no son $5,000');
        const b2 = await intento(trx, () => trx('finance.caos_cash_links').insert(conB(gd, 1000, { 200: 5 })));
        ok(rechaza(b2, '23514', 'caos_link_billetes_insuficientes'), 'NEGATIVA: el retiro no traía billetes de $200');
        const b3 = await intento(trx, () => trx('finance.caos_cash_links').insert(conB(gd, 500, { 500: -1 })));
        ok(rechaza(b3, '23514', 'caos_link_billetes_forma'), 'NEGATIVA: piezas negativas no existen');
        // El cambio regresa a la custodia y se puede volver a entregar.
        await trx('finance.caos_cash_links').insert(conB(gb, 500, { 500: 2 }, { 100: 5 }));
        ok(!(await intento(trx, () => trx('finance.caos_cash_links').insert(conB(gc, 500, { 100: 5 })))),
          'los 5 × $100 del cambio se pueden entregar en otro pago');
        await trx('finance.caos_cash_links').insert(conB(gc, 500, { 100: 5 }));
        const b4 = await intento(trx, () => trx('finance.caos_cash_links').insert(conB(gd, 100, { 100: 1 })));
        ok(rechaza(b4, '23514', 'caos_link_billetes_insuficientes'), 'NEGATIVA: ya no queda ningún $100 del cambio');

        await trx.raw('RESET ROLE');
        await trx.raw('ALTER TABLE finance.caos_cash_links DISABLE TRIGGER trg_caos_link_billetes');
        await comoApp(T);
        const m3 = await intento(trx, () => trx('finance.caos_cash_links').insert(conB(gd, 1000, { 200: 5 })));
        ok(!m3, 'MUTACIÓN: sin trg_caos_link_billetes un billete que el retiro no traía SÍ entra: la regla es el trigger');
        await trx.raw('RESET ROLE');
        await trx.raw('ALTER TABLE finance.caos_cash_links ENABLE TRIGGER trg_caos_link_billetes');
        await comoApp(T);
      }

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
