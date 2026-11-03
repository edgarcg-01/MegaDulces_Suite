#!/usr/bin/env node
'use strict';
/**
 * `[DP.2.2]` — El servicio que ESCRIBE las definiciones de negocio, contra Postgres real (Fase DP).
 *
 * ⛔ Regla 13: un endpoint que escribe no está probado hasta que una prueba lo ejerció contra base
 * real con el payload de la pantalla. Esto carga `business-definitions.service.ts` REAL (ts-node +
 * los alias de `tsconfig.base.json`), le pone un `tk` que corre como `app_runtime` con el tenant
 * fijado —RLS y grants de verdad— y le manda `{ value, valid_from, note }`, la forma del body.
 *
 *   1. Sin dueño no se contesta (403) · quien no es el dueño tampoco (403).
 *   2. Repartir: GESTIONAR asigna, queda `assigned_by` y la pregunta aparece en `mias()` del dueño.
 *   3. Contestar: valor contra el tipo (400), motivo obligatorio (400), fecha (400); la buena
 *      queda `respondida` y la vigente es su valor.
 *   4. ⭐ Una reversa RETROACTIVA gana (el caso «sigue al chofer»): la vigente es la contestada más
 *      tarde, a la fecha que se pida, leída por la MISMA función que usa la pantalla.
 *   5. Descartar: sólo una pendiente (409 sobre una contestada), con motivo; una descartada no se
 *      contesta (409).
 *   6. Las 17 de Comisiones RD: «sin definir» y la propuesta NUNCA sale como valor.
 *
 * Lo que NO mide: la capa HTTP (guardias, el 403 de la clave, el parseo del body). Se declara.
 * Todo en UNA transacción que se revierte, y se prueba que el rollback fue real.
 * ⛔ No se corre con el `.env` por defecto: apunta a producción. Corre en el job `pruebas-db`.
 */
const path = require('path');
const RAIZ = path.resolve(__dirname, '..', '..');

const T = '00000000-0000-0000-0000-00000000d01c';
const KEY = 'smoke.dp.servicio';
let pass = 0, fail = 0, nm = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, extra !== undefined ? JSON.stringify(extra) : ''); } };
const noMedido = (m) => { nm++; console.log('  ·  NO MEDIDO —', m); };

let Servicio;
// La plataforma exige un secreto de firma al CARGAR el módulo; un valor local de prueba, nunca uno real.
process.env.JWT_SECRET = process.env.JWT_SECRET || `prueba-local-dp22-${'x'.repeat(40)}`;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  require('reflect-metadata');
  ({ BusinessDefinitionsService: Servicio } = require(path.join(RAIZ, 'libs/platform-core/src/lib/definitions/business-definitions.service.ts')));
} catch (e) {
  console.log(`  ·  NO MEDIDO — no se pudo cargar el servicio con ts-node: ${e.message}`);
  process.exit(2);
}

const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-business-definitions-service');

/** El código HTTP de la excepción de Nest (o el mensaje si no es una). */
async function status(fn) {
  try { await fn(); return 200; } catch (e) { return typeof e.getStatus === 'function' ? e.getStatus() : (e.code || e.message); }
}

(async () => {
  try {
    console.log('\n[DP.2.2] Definiciones de negocio — el servicio REAL que escribe, como app_runtime\n');
    const users = await knex('identity.users').where({ tenant_id: T }).whereNull('deleted_at')
      .whereNot('activo', false).orderBy('created_at').limit(2).pluck('id');
    if (users.length < 2) { noMedido('hacen falta dos personas activas en el tenant para probar dueño contra no-dueño'); return; }
    const [DUENO, OTRO] = users;

    await knex.transaction(async (trx) => {
      await trx.raw('SET LOCAL ROLE app_runtime');
      await trx.raw('SELECT set_config(\'app.tenant_id\', ?, true)', [T]);
      let quien = OTRO;
      const s = Object.create(Servicio.prototype);
      Object.assign(s, {
        logger: { log() {}, warn() {}, error() {}, debug() {} },
        tenantCtx: { requireTenantId: () => T, get: () => ({ tenantId: T, userId: quien }) },
        // Cada llamada en su SAVEPOINT: un error de la base no aborta la transacción de la prueba.
        tk: { run: async (fn) => {
          await trx.raw('SAVEPOINT sp_dp_svc');
          try { const r = await fn(trx); await trx.raw('RELEASE SAVEPOINT sp_dp_svc'); return r; }
          catch (e) { await trx.raw('ROLLBACK TO SAVEPOINT sp_dp_svc'); throw e; }
        } },
      });
      const como = (u) => { quien = u; return s; };

      const [def] = await trx('platform.business_definitions').insert({
        tenant_id: T, key: `${KEY}.sigue_a`, area: 'direccion', consumer: 'smoke.dp', question: '¿Chofer o ruta?',
        value_type: 'choice', choices: JSON.stringify([{ value: 'chofer', label: 'Chofer' }, { value: 'tipo_ruta', label: 'Ruta' }]),
      }).returning('*');
      const [otra] = await trx('platform.business_definitions').insert({
        tenant_id: T, key: `${KEY}.descartable`, area: 'rh', consumer: 'smoke.dp', question: '¿Ya no aplica?', value_type: 'number',
      }).returning('*');

      console.log('── 1. Quién contesta');
      const body = (o = {}) => ({ value: 'tipo_ruta', valid_from: '2026-10-20', note: 'decisión de prueba', ...o });
      ok((await status(() => como(DUENO).contestar(def.id, body()))) === 403, 'sin dueño no se contesta (403): primero hay que asignarla');

      console.log('\n── 2. Repartir');
      const asignada = await como(OTRO).actualizar(def.id, { assigned_to: DUENO, due_at: '2026-11-21T23:59:00-06:00' });
      ok(asignada.assigned_to === DUENO && asignada.due_at !== null, 'GESTIONAR asigna dueño y plazo');
      const fila = await trx('platform.business_definitions').where({ id: def.id }).first('assigned_by', 'assigned_at');
      ok(fila.assigned_by === OTRO && fila.assigned_at !== null, 'queda quién la repartió y cuándo');
      ok((await como(DUENO).mias()).some((d) => d.id === def.id), 'aparece en la bandeja de su dueño');
      ok(!(await como(OTRO).mias()).some((d) => d.id === def.id), 'NO aparece en la bandeja de otra persona');
      ok((await status(() => como(OTRO).contestar(def.id, body()))) === 403, 'quien no es el dueño no la contesta (403), aunque la haya repartido');
      ok((await status(() => como(OTRO).actualizar(def.id, { assigned_to: '00000000-0000-0000-0000-000000000bad' }))) === 400,
        'asignar a alguien fuera del padrón: 400 con su motivo, no un 500 de la base');

      console.log('\n── 3. Contestar');
      ok((await status(() => como(DUENO).contestar(def.id, body({ value: 'otra' })))) === 400, 'un valor fuera de las opciones: 400');
      ok((await status(() => como(DUENO).contestar(def.id, body({ note: '   ' })))) === 400, 'sin motivo: 400');
      ok((await status(() => como(DUENO).contestar(def.id, body({ valid_from: '20/10/2026' })))) === 400, 'fecha mal escrita: 400');
      const r1 = await como(DUENO).contestar(def.id, body());
      ok(r1.status === 'respondida' && r1.respuestas === 1, 'la buena queda respondida, con 1 respuesta');
      ok(r1.vigente.estado === 'definida' && r1.vigente.valor === 'tipo_ruta', `rige su valor (${JSON.stringify(r1.vigente)})`);
      const resp = await trx('platform.business_definition_answers').where({ definition_id: def.id }).first();
      ok(resp && resp.answered_by === DUENO && resp.note === 'decisión de prueba', 'la respuesta guarda autor y motivo');

      console.log('\n── 4. ⭐ La reversa retroactiva (el caso «sigue al chofer»)');
      await como(DUENO).contestar(def.id, body({ value: 'chofer', valid_from: '2026-09-08', note: 'revierte, retroactivo al renombre' }));
      const hoy = await s.resolver(`${KEY}.sigue_a`, '2026-10-25');
      ok(hoy && hoy.estado === 'definida' && hoy.valor === 'chofer', `a 2026-10-25 manda la contestada más tarde: ${JSON.stringify(hoy && hoy.valor)}`);
      const antes = await s.resolver(`${KEY}.sigue_a`, '2026-09-01');
      ok(antes && antes.estado === 'sin_definir' && antes.motivo === 'no_rige_aun', 'antes de toda vigencia: sin definir / no rige aún');
      ok((await s.resolver(`${KEY}.no.existe`, '2026-10-25')) === null, 'una key que no existe es null, no «sin definir»');

      console.log('\n── 5. Descartar');
      ok((await status(() => como(OTRO).actualizar(def.id, { discard_reason: 'ya no' }))) === 409, 'una contestada no se descarta (409)');
      ok((await status(() => como(OTRO).actualizar(otra.id, { discard_reason: '  ' }))) === 400, 'descartar sin motivo: 400');
      const desc = await como(OTRO).actualizar(otra.id, { discard_reason: 'la regla dejó de existir' });
      ok(desc.status === 'descartada' && desc.vigente.estado === 'sin_definir' && desc.vigente.motivo === 'descartada', 'una pendiente se descarta con motivo');
      await como(OTRO).actualizar(otra.id, { assigned_to: DUENO });
      ok((await status(() => como(DUENO).contestar(otra.id, { value: 3, valid_from: '2026-11-01', note: 'x' }))) === 409, 'una descartada no se contesta (409)');

      console.log('\n── 6. Las 17 de Comisiones RD');
      const rd = await s.listar('commercial.commissions');
      ok(rd.length === 17, `17 preguntas del consumidor (hay ${rd.length})`);
      const sigue = rd.find((d) => d.key === 'rd.universo.sigue_a');
      ok(sigue && sigue.vigente.estado === 'sin_definir' && sigue.suggested_value === 'chofer',
        '⭐ «sigue al chofer» viaja como PROPUESTA y la vigente es «sin definir»: la propuesta nunca sale como valor');

      throw new Error('__ROLLBACK__'); // ← cero efecto real
    }).catch((e) => { if (e.message !== '__ROLLBACK__') throw e; });

    const sobra = await knex('platform.business_definitions').where({ tenant_id: T }).where('key', 'like', `${KEY}%`).count('* as n').first();
    ok(Number(sobra.n) === 0, 'rollback real: no quedó ninguna pregunta de prueba');
    noMedido('la capa HTTP (RolesGuard, el 403 por clave, el parseo del body): esto ejerce el servicio, no la ruta');
  } catch (e) {
    fail++;
    console.log('\n  ✗ EXCEPCIÓN:', e.message);
  } finally {
    await knex.destroy();
    console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    process.exit(fail ? 1 : (pass ? 0 : 2));
  }
})();
