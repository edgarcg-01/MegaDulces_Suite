/**
 * `[PQ.3.6]` El reparto del Calendario de compras contra una base REAL (regla 20: un módulo no está entregado
 * hasta que su permiso está repartido). Corre el `up()` de la migración 20261120180734 y afirma:
 *
 *  1. Cada rol del anexo C §4.1 queda con sus claves; CICLO sólo la gerencia de compras.
 *  2. Correrla dos veces no cambia nada (idempotente).
 *  3. No pisa lo puesto a mano: una clave en `false` sigue en `false`, y una regla de alcance que alguien ya
 *     escribió para el almacenista en Compras gana a la de la migración.
 *  4. El almacenista queda `own` (lee y escribe su sucursal) SÓLO en Compras: con la precedencia real
 *     (`elegirRegla` de libs/contracts, cargada con ts-node) en otra área sigue su regla de siempre.
 *  5. El `down()` quita exactamente lo suyo, y el `up()` lo vuelve a poner.
 *
 * Todo en UNA transacción que se revierte. ⛔ Escribe (y revierte): no corre contra producción
 * (`assertSafeTarget`); a mano, con `DATABASE_URL_NEW` apuntando a una base local.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-pq3-6-calendario-permisos');
const { noMedido, correr } = require('./_lib/no-medido');
const RAIZ = path.resolve(__dirname, '..', '..');

let elegirRegla;
try {
  require('ts-node').register({ transpileOnly: true, skipProject: true,
    compilerOptions: { module: 'commonjs', moduleResolution: 'node', target: 'es2021', ignoreDeprecations: '6.0' } });
  const tsc = require('typescript');
  const base = tsc.readConfigFile(path.join(RAIZ, 'tsconfig.base.json'), tsc.sys.readFile).config;
  require('tsconfig-paths').register({ baseUrl: RAIZ, paths: base.compilerOptions.paths });
  ({ elegirRegla } = require(path.join(RAIZ, 'libs/contracts/src/authz/scope-areas.ts')));
} catch (e) {
  noMedido(`no se pudo cargar scope-areas.ts con ts-node: ${e.message}`);
}
const knex = require('knex')(require('../knexfile-newdb.js').development);
const mig = require('../migrations-newdb/20261120180734_pq3_6_calendario_compras_permisos.js');

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const VER = 'COMPRAS_CALENDARIO_VER';
const GES = 'COMPRAS_CALENDARIO_GESTIONAR';
const CIC = 'COMPRAS_CALENDARIO_CICLO';
const ESPERADO = {
  gerente_compras: [VER, GES, CIC],
  compras: [VER, GES],
  compras_operaciones: [VER, GES],
  auxiliar_compras: [VER, GES],
  encargado_tienda: [VER, GES],
  almacenista: [VER, GES],
  direccion: [VER],
};

let ok = 0;
let ko = 0;
let nm = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};
const NM = (m) => { nm += 1; console.log(`  ○ NO MEDIDO — ${m}`); };
const callado = async (fn) => { const log = console.log; console.log = () => undefined; try { return await fn(); } finally { console.log = log; } };

correr(async () => {
  console.log('\n[PQ.3.6] Calendario de compras — el reparto de permisos y el alcance del almacenista, contra base real\n');
  const trx = await knex.transaction();
  try {
    if ((await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on') noMedido('la conexión es de sólo lectura');
    const roles = (await trx('identity.role_permissions').where({ tenant_id: TENANT }).whereNull('deleted_at')
      .whereIn('role_name', Object.keys(ESPERADO)).select('role_name')).map((r) => r.role_name);
    if (!roles.includes('gerente_compras') || !roles.includes('almacenista')) {
      noMedido(`la base no trae los roles gerente_compras y almacenista (trae: ${roles.join(', ') || 'ninguno'})`);
    }
    const faltan = Object.keys(ESPERADO).filter((r) => !roles.includes(r));
    if (faltan.length) NM(`roles que esta base no trae (no se pueden afirmar): ${faltan.join(', ')}`);

    const permisos = async () => Object.fromEntries((await trx('identity.role_permissions').where({ tenant_id: TENANT }).whereNull('deleted_at')
      .select('role_name', 'permissions')).map((r) => [r.role_name, r.permissions || {}]));
    const reglaCompras = () => trx('identity.role_scopes').where({ tenant_id: TENANT, role_name: 'almacenista', dimension: 'warehouse', area: 'compras' }).first();
    const almAntes = await trx('identity.role_scopes').where({ tenant_id: TENANT, role_name: 'almacenista', dimension: 'warehouse' }).whereNot('area', 'compras').select('area', 'mode', 'values', 'mode_write');

    // 3 · Primero: no pisa lo puesto a mano (en un SAVEPOINT que se deshace).
    await trx.raw('SAVEPOINT manual');
    await trx('identity.role_permissions').where({ tenant_id: TENANT, role_name: 'direccion' })
      .update({ permissions: trx.raw(`permissions || jsonb_build_object(?::text, false)`, [VER]) });
    await trx('identity.role_scopes').where({ tenant_id: TENANT, role_name: 'almacenista', dimension: 'warehouse', area: 'compras' }).del();
    await trx('identity.role_scopes').insert({ tenant_id: TENANT, role_name: 'almacenista', dimension: 'warehouse', area: 'compras', mode: 'listed', values: ['01'], nota: 'puesta a mano' });
    await callado(() => mig.up(trx));
    const pm = await permisos();
    const rm = await reglaCompras();
    if (roles.includes('direccion')) check('una clave puesta en false a mano sigue en false', pm.direccion?.[VER] === false, pm.direccion?.[VER]);
    check('una regla de alcance del almacenista en Compras escrita a mano gana a la de la migración',
      rm?.mode === 'listed' && JSON.stringify(rm.values) === '["01"]' && rm.nota === 'puesta a mano', rm);
    await trx.raw('ROLLBACK TO SAVEPOINT manual');

    // 1 y 2 · El reparto, dos veces.
    await callado(() => mig.up(trx));
    const p1 = await permisos();
    const r1 = await reglaCompras();
    await callado(() => mig.up(trx));
    const p2 = await permisos();
    const r2 = await reglaCompras();
    for (const rol of Object.keys(ESPERADO).filter((r) => roles.includes(r))) {
      const tiene = [VER, GES, CIC].filter((k) => p1[rol][k] === true);
      check(`${rol}: ${ESPERADO[rol].join(' · ')}${ESPERADO[rol].includes(CIC) ? '' : ' (sin CICLO)'}`,
        JSON.stringify(tiene) === JSON.stringify(ESPERADO[rol]), tiene);
    }
    const conCiclo = Object.entries(p1).filter(([, p]) => p[CIC] === true).map(([r]) => r);
    check('CICLO lo tiene sólo la gerencia de compras (DC8)', JSON.stringify(conCiclo) === '["gerente_compras"]', conCiclo);
    const sinTocar = Object.entries(p1).filter(([r]) => !(r in ESPERADO)).filter(([, p]) => [VER, GES, CIC].some((k) => k in p)).map(([r]) => r);
    check('ningún otro rol recibió claves del calendario', !sinTocar.length, sinTocar);
    check('el almacenista queda own/own en Compras con la nota de la migración', r1?.mode === 'own' && r1.mode_write === 'own' && /PQ\.3\.6/.test(r1.nota || ''), r1);
    check('correrla dos veces no cambia nada', JSON.stringify(p1) === JSON.stringify(p2) && r1?.id === r2?.id, { r1: r1?.id, r2: r2?.id });

    // 4 · La precedencia REAL: own sólo en Compras; en otra área, la de siempre.
    const reglas = await trx('identity.role_scopes').where({ tenant_id: TENANT, role_name: 'almacenista' }).select('dimension', 'area', 'mode', 'mode_write', 'values');
    const enCompras = elegirRegla(reglas, 'warehouse', 'compras');
    const enFinanzas = elegirRegla(reglas, 'warehouse', 'finanzas');
    const comodin = almAntes.find((r) => r.area === '*');
    check('con la precedencia real, el almacenista en Compras es own', enCompras?.mode === 'own' && enCompras.area === 'compras', enCompras);
    if (comodin) {
      check(`y en otra área (finanzas) sigue su regla de siempre ('*' = ${comodin.mode})`, enFinanzas?.area === '*' && enFinanzas.mode === comodin.mode, enFinanzas);
    } else {
      NM('el almacenista no tiene regla \'*\' en esta base: no se puede afirmar que las otras áreas siguen igual');
    }
    const almDespues = await trx('identity.role_scopes').where({ tenant_id: TENANT, role_name: 'almacenista', dimension: 'warehouse' }).whereNot('area', 'compras').select('area', 'mode', 'values', 'mode_write');
    check('sus reglas de las otras áreas quedan idénticas', JSON.stringify(almAntes) === JSON.stringify(almDespues), { almAntes, almDespues });

    // 5 · down y up otra vez.
    await mig.down(trx);
    const pd = await permisos();
    const conClave = Object.entries(pd).filter(([, p]) => [VER, GES, CIC].some((k) => p[k] === true)).map(([r]) => r);
    check('el down quita las tres claves y la regla del almacenista', !conClave.length && !(await reglaCompras()), conClave);
    await callado(() => mig.up(trx));
    check('el up las vuelve a poner', (await permisos()).gerente_compras?.[CIC] === true && (await reglaCompras())?.mode === 'own');
  } finally {
    await trx.rollback();
    await knex.destroy();
  }
  console.log(`\n  ${ok} ✓ · ${ko} ✗ · ${nm} ○ NO MEDIDO`);
  if (ko) process.exit(1);
});
