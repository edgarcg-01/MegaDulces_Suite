/* eslint-disable no-console */
/**
 * `[AB.46]` Atribuirse un pendiente de la sucursal — el SERVICIO REAL contra la BASE REAL (regla 13).
 *
 * `SucursalPendientesService.atribuir` / `.soltar` se cargan con ts-node del `.ts` de producción (no se
 * copia su SQL) y corren como `app_runtime` (RLS de verdad: el dueño de la tabla la saltaría). Todo va
 * dentro de UNA transacción que se revierte; se prueba que el rollback fue real.
 *
 *   1. La tabla: RLS activo y FORZADO, política `tenant_isolation`, grants SIN DELETE.
 *   2. Atribuirse un pendiente libre lo deja a mi nombre; repetirlo no falla.
 *   3. ⭐ NEGATIVA: otra persona no puede tomar el mismo pendiente (409, con mi nombre en el mensaje).
 *   4. ⭐ NEGATIVA: otra persona no puede soltarlo (403); yo sí; y después ella sí lo puede tomar.
 *   5. ⭐ NEGATIVA: la base misma rechaza dos responsables vivos del mismo pendiente (23505) y una
 *      clave vacía (23514), cada una con su control positivo.
 *   6. Otro tenant no ve la fila; `app_runtime` no puede borrarla (42501): soltar es borrado lógico.
 *
 * ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db` del CI.
 */
const path = require('path');
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-sucursal-pendientes-atribuir');

const RAIZ = path.join(__dirname, '..', '..');
const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '00000000-0000-0000-0000-0000000000f9';
const YO = '11111111-1111-4111-8111-1111111111a1';
const ELLA = '22222222-2222-4222-8222-2222222222b2';
const TABLA = 'commercial.sucursal_pendiente_responsables';

let pass = 0;
let fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };

let Servicio;
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-ab46-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ SucursalPendientesService: Servicio } = require(path.join(RAIZ, 'libs/commercial/src/lib/commercial-replenishment/sucursal-pendientes.service.ts')));
} catch (e) {
  console.log(`  ✗ no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(1);
}

/** Código del error (SQLSTATE o status HTTP de Nest), o null si no falló. */
async function codigo(trx, fn) {
  await trx.raw('SAVEPOINT sp_ab46');
  let code = null;
  try { await fn(); } catch (e) { code = e.code || (typeof e.getStatus === 'function' ? e.getStatus() : e.message); }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_ab46');
  return code;
}

(async () => {
  try {
    console.log('\n── 1. La tabla: RLS forzado, política y grants');
    const r = await knex.raw(
      `SELECT c.relrowsecurity rls, c.relforcerowsecurity frz,
              EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname='commercial' AND p.tablename='sucursal_pendiente_responsables' AND p.policyname='tenant_isolation') pol
         FROM pg_class c WHERE c.oid = to_regclass(?)`, [TABLA]);
    const t = r.rows[0];
    ok(!!t && t.rls === true && t.frz === true && t.pol === true, `${TABLA}: existe, RLS activo y FORZADO, tenant_isolation`);
    if (!t) throw new Error('falta la migración 20261103160516_ab46_pendientes_sucursal_responsables');
    const tiene = [];
    for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      if ((await knex.raw(`SELECT has_table_privilege('app_runtime', ?, ?) v`, [TABLA, p])).rows[0].v) tiene.push(p);
    }
    ok(JSON.stringify(tiene) === JSON.stringify(['SELECT', 'INSERT', 'UPDATE']), 'app_runtime: SELECT, INSERT, UPDATE — sin DELETE', tiene);

    const wh = (await knex.raw(`SELECT id::text AS id, code, name FROM commercial.warehouses WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY code LIMIT 1`, [T])).rows[0];
    if (!wh) throw new Error('la base de pruebas no tiene ningún almacén del tenant');

    await knex.transaction(async (outer) => {
      // tk.run del servicio: una sub-transacción (SAVEPOINT) como app_runtime con el tenant puesto.
      // ⚠️ Sin `finally`: si `fn` truena, la transacción queda abortada y un `RESET ROLE` ahí taparía el
      // código real con 25P02. El `ROLLBACK TO SAVEPOINT` de quien llama ya deshace el `SET LOCAL ROLE`.
      const comoRuntime = async (tenant, fn) => {
        await outer.raw('SET LOCAL ROLE app_runtime');
        await outer.raw("SELECT set_config('app.tenant_id', ?, true)", [tenant]);
        const r = await fn(outer);
        await outer.raw('RESET ROLE');
        return r;
      };
      const tk = { run: (fn) => outer.transaction((sp) => comoRuntime(T, () => fn(sp))) };
      const ctx = { requireTenantId: () => T };
      const motor = { almacenes: async () => [wh] };
      const pedidos = { conLlaveDeSucursal: async (ws) => ws.map((w) => ({ id: w.id, name: w.name, sucursal: w.code })) };
      const svc = new Servicio(motor, pedidos, tk, ctx);
      const cuerpo = { warehouse_id: wh.id, cola: 'olas', clave: 'prueba-ab46-k1' };

      console.log('\n── 2. Atribuirse un pendiente libre');
      const mio = await svc.atribuir(cuerpo, { sub: YO });
      ok(mio.user_id === YO && mio.soy_yo === true, 'queda a mi nombre', mio);
      const otraVez = await svc.atribuir(cuerpo, { sub: YO });
      ok(otraVez.user_id === YO, 'atribuírmelo otra vez no falla (ya era mío)');
      const vivos = await comoRuntime(T, (q) => q(TABLA).where({ warehouse_id: wh.id, clave: cuerpo.clave }).whereNull('deleted_at'));
      ok(vivos.length === 1, 'una sola fila viva', vivos.length);

      console.log('\n── 3. ⭐ NEGATIVA: otra persona no puede tomarlo');
      ok((await codigo(outer, () => svc.atribuir(cuerpo, { sub: ELLA }))) === 409, 'ella recibe 409 (conflicto)');

      console.log('\n── 4. Soltar: sólo quien lo tiene');
      ok((await codigo(outer, () => svc.soltar(cuerpo, { sub: ELLA }))) === 403, '⭐ NEGATIVA: ella no puede soltarlo (403)');
      ok((await svc.soltar(cuerpo, { sub: YO })).ok === true, 'yo sí lo suelto');
      const suelto = await comoRuntime(T, (q) => q(TABLA).where({ warehouse_id: wh.id, clave: cuerpo.clave }).first('deleted_at', 'deleted_by'));
      ok(!!suelto.deleted_at && suelto.deleted_by === YO, 'soltar es borrado lógico, con quién lo soltó');
      const deElla = await svc.atribuir(cuerpo, { sub: ELLA });
      ok(deElla.user_id === ELLA, 'después de soltarlo, ella sí lo puede tomar');

      console.log('\n── 5. ⭐ La base rechaza lo inválido (con control positivo)');
      const fila = (extra) => ({ tenant_id: T, warehouse_id: wh.id, cola: 'olas', clave: 'prueba-ab46-k2', user_id: YO, created_by: YO, ...extra });
      ok((await codigo(outer, () => comoRuntime(T, (q) => q(TABLA).insert(fila())))) === null, 'CONTROL: una fila válida entra');
      await comoRuntime(T, (q) => q(TABLA).insert(fila()));
      const c23505 = await codigo(outer, () => comoRuntime(T, (q) => q(TABLA).insert(fila({ user_id: ELLA, created_by: ELLA }))));
      ok(c23505 === '23505',
        'NEGATIVA: dos responsables vivos del mismo pendiente (23505)', c23505);
      const c23514 = await codigo(outer, () => comoRuntime(T, (q) => q(TABLA).insert(fila({ clave: '   ' }))));
      ok(c23514 === '23514',
        'NEGATIVA: clave vacía (23514)', c23514);

      console.log('\n── 6. Aislamiento y permisos REALES');
      const ajeno = await comoRuntime(OTRO, (q) => q(TABLA).where({ clave: 'prueba-ab46-k1' }));
      ok(ajeno.length === 0, 'otro tenant no ve la fila (RLS)');
      const c42501 = await codigo(outer, () => comoRuntime(T, (q) => q(TABLA).where({ clave: 'prueba-ab46-k1' }).del()));
      ok(c42501 === '42501',
        '⭐ NEGATIVA: app_runtime no puede borrar (42501): soltar es lógico', c42501);

      throw new Error('__ROLLBACK__'); // ← cero efecto real
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    const sobra = await knex.transaction(async (trx) => {
      await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [T]);
      return trx(TABLA).where('clave', 'like', 'prueba-ab46-%').count('* as n').first();
    });
    ok(Number(sobra.n) === 0, 'rollback real: no quedó ninguna fila de prueba');
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n${pass} ✓ / ${fail} ✗`);
    process.exit(fail ? 1 : 0);
  }
})();
