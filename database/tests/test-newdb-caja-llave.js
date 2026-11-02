/* eslint-disable no-console */
/**
 * `[LE.0.9]` — Opera la caja sólo quien tiene la llave, y el superadmin no cuenta en la caja.
 *
 * Mide la migración `20261031135300_le09_caja_solo_quien_tiene_la_llave` (D21–D23, Edgar
 * 2026-10-31):
 *
 *  · registrar en el libro exige `FINANCE_CAJA_GESTIONAR` EFECTIVA (`caja_exige_llave_chk`);
 *  · el rol `superadmin` no cuenta, aunque su mapa traiga la llave (así está en prod);
 *  · la excepción personal en `false` gana sobre el rol;
 *  · abrir un corte y autorizarlo también la exigen;
 *  · una persona desconocida no la decide el disparador (límite declarado de la migración).
 *
 * Siembra como superusuario, escribe como `app_runtime` (el rol de prod), y cierra con la MUTACIÓN
 * que apaga el disparador y exige que el superadmin entonces sí registre. Todo en una transacción
 * que se deshace.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_LE_LIBRO_DE_EFECTIVO.md` (LE.0.9).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-caja-llave');

const T = '00000000-0000-0000-0000-00000000d01c';
const OPERA = '00000000-0000-0000-0000-0000000009a1';
const DIOS = '00000000-0000-0000-0000-0000000009a2';
const NEGADO = '00000000-0000-0000-0000-0000000009a3';
const NADIE = '00000000-0000-0000-0000-0000000009a4';
const FECHA = '2099-03-01';

let pass = 0, fail = 0, nomedido = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const skip = (m) => { nomedido++; console.log('  ⃝ NO MEDIDO —', m); };

let n = 0;
const sello = () => `${Date.now()}-${(n += 1)}`;
const mov = (quien) => ({
  tenant_id: T, folio: `LE09-TEST-${sello()}`, tipo: 'gasto', fecha: FECHA, sucursal: 'S1',
  kepler_cuenta: '601-001', kepler_concepto: 'PRUEBA', glosa: 'Movimiento de prueba LE.0.9',
  monto: 100, corte_id: null, created_by: quien, created_by_username: 'le09_prueba',
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
const es = (err) => !!err && err.code === '23514' && err.constraint === 'caja_exige_llave_chk';
const dijo = (err) => (err ? `${err.code} ${err.constraint ?? '(sin nombre)'}` : 'pasó sin error');

(async () => {
  try {
    console.log('\n── 0. La migración está aplicada ──');
    const trg = await knex.raw(`
      SELECT tgrelid::regclass::text AS tabla FROM pg_trigger
       WHERE NOT tgisinternal AND tgenabled = 'O'
         AND tgname IN ('trg_cash_ledger_exige_llave', 'trg_cash_cut_exige_llave')`);
    const tablas = trg.rows.map((r) => r.tabla);
    if (!tablas.includes('finance.cash_ledger')) {
      ok(false, 'la migración 20261031135300 NO está aplicada en esta base: nada de lo que sigue se puede medir');
      return;
    }
    ok(tablas.includes('finance.cash_ledger') && tablas.includes('finance.cash_ledger_cuts'),
      'la regla está ENCENDIDA en el libro y en el corte');

    const hayRol = (await knex.raw(`SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'`)).rows.length === 1;

    await knex.transaction(async (trx) => {
      console.log('\n── 1. Siembra: quien opera, un superadmin con la llave en su mapa, y una excepción en false ──');
      await trx.raw(`
        INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
        VALUES (?, 'le09_opera', '{"FINANCE_CAJA_GESTIONAR": true}'::jsonb)
        ON CONFLICT (tenant_id, role_name) DO UPDATE SET permissions = EXCLUDED.permissions`, [T]);
      await trx.raw(`
        INSERT INTO identity.role_permissions (tenant_id, role_name, permissions)
        VALUES (?, 'superadmin', '{"FINANCE_CAJA_GESTIONAR": true, "FINANCE_CAJA_AUTORIZAR": true}'::jsonb)
        ON CONFLICT (tenant_id, role_name) DO UPDATE
          SET permissions = identity.role_permissions.permissions || EXCLUDED.permissions`, [T]);
      for (const [id, rol] of [[OPERA, 'le09_opera'], [DIOS, 'superadmin'], [NEGADO, 'le09_opera']]) {
        await trx.raw(`INSERT INTO identity.users (id, tenant_id, username, role_name, activo)
          VALUES (?, ?, ?, ?, true)`, [id, T, `le09_${id.slice(-3)}`, rol]);
      }
      await trx.raw(`INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota)
        VALUES (?, ?, 'FINANCE_CAJA_GESTIONAR', false, 'prueba LE.0.9')`, [T, NEGADO]);
      ok(true, 'sembrados');

      if (hayRol) await trx.raw('SET LOCAL ROLE app_runtime');
      else skip('sin app_runtime: las escrituras corren como superusuario, no como la app.');
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);

      console.log('\n── 2. Registrar en el libro ──');
      const e1 = await intento(trx, () => trx('finance.cash_ledger').insert(mov(OPERA)));
      ok(e1 === null, `quien tiene la llave por su rol registra (${dijo(e1)})`);
      const e2 = await intento(trx, () => trx('finance.cash_ledger').insert(mov(DIOS)));
      ok(es(e2), `[negativa] el superadmin NO registra aunque su mapa traiga la llave → caja_exige_llave_chk (${dijo(e2)})`);
      const e3 = await intento(trx, () => trx('finance.cash_ledger').insert(mov(NEGADO)));
      ok(es(e3), `[negativa] la excepción personal en false gana sobre el rol → caja_exige_llave_chk (${dijo(e3)})`);
      const e4 = await intento(trx, () => trx('finance.cash_ledger').insert(mov(NADIE)));
      ok(e4 === null, `una persona desconocida no la decide el disparador: límite declarado (${dijo(e4)})`);

      console.log('\n── 3. El corte ──');
      const corte = (quien) => ({
        tenant_id: T, folio: `LE09-TEST-${sello()}`, fecha: FECHA, sucursal: 'S1',
        fondo_inicial: 500, fondo_origen: 'contado', created_by: quien, created_by_username: 'le09_prueba',
      });
      const e5 = await intento(trx, () => trx('finance.cash_ledger_cuts').insert(corte(DIOS)));
      ok(es(e5), `[negativa] el superadmin NO abre un corte → caja_exige_llave_chk (${dijo(e5)})`);
      const [c] = await trx('finance.cash_ledger_cuts').insert(corte(OPERA)).returning('*');
      ok(!!c, 'quien tiene la llave abre un corte');
      const e6 = await intento(trx, () => trx('finance.cash_ledger_cuts').where({ id: c.id })
        .update({ authorized_by: DIOS, authorized_by_username: 'le09_prueba' }));
      ok(es(e6), `[negativa] el superadmin NO autoriza → caja_exige_llave_chk (${dijo(e6)})`);

      console.log('\n── 4. ⛔ MUTACIÓN: sin la regla, el superadmin SÍ registra ──');
      if (hayRol) await trx.raw('RESET ROLE');
      const sinRegla = await intento(trx, async () => {
        await trx.raw('ALTER TABLE finance.cash_ledger DISABLE TRIGGER trg_cash_ledger_exige_llave');
        await trx('finance.cash_ledger').insert(mov(DIOS));
      });
      ok(sinRegla === null, `con la regla APAGADA el superadmin sí registra (${dijo(sinRegla)}): la sección 2 mide el disparador`);

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
