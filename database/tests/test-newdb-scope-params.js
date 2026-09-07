#!/usr/bin/env node
/**
 * `[ID.5]` — Contrato canónico de params de alcance (Fase ID / ADR-050).
 *
 * Se carga el `.ts` REAL vía ts-node (no una reimplementación): si el contrato
 * cambia, este test lo sigue. Mismo patrón que `test-newdb-entity-ref`.
 *
 * Qué cubre:
 *   1. El nombre canónico gana sobre los alias.
 *   2. Los 16 alias medidos se leen (warehouse/zone/route).
 *   3. Las tres formas de mandar una lista son equivalentes: `?x=01,03`,
 *      `?x=01&x=03` y `?x=01`.
 *   4. Trim, descarte de vacíos y dedupe — sin `[...new Set()]`, que webpack
 *      baja a `[Set]` y termina bindeando `'{}'` (22P02).
 *   5. **"no pidió nada" (`null`) ≠ "pidió lista vacía" (`[]`)**: es la
 *      distinción de la que depende que `all` no se convierta en `none`.
 *   6. La premisa de la traducción de llaves: en la DB, una sucursal se
 *      identifica por `id` (uuid) Y por `code`, que es lo que permite aceptar
 *      `?warehouse_id=<uuid>` y `?warehouses=03` en el mismo endpoint
 *      (verificado en `commercial-analytics`: ambos conviven hoy).
 *
 * Correr: node database/tests/test-newdb-scope-params.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} → ${JSON.stringify(a)}`);

// `skipProject`: sin esto ts-node toma el tsconfig del monorepo (paths, rootDir
// de Nx) y falla con TS5011 antes de compilar.
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const {
  parseScopeParam, parseAllScopeParams, CANONICAL_PARAM, PARAM_ALIASES, resetAvisosDeprecacion,
} = require(path.resolve(__dirname, '../../libs/platform-core/src/lib/scope/scope-params.ts'));

const vals = (q, dim) => parseScopeParam(q, dim, 'test').values;

(async () => {
  try {
    console.log('\n═══ 1. Canónico vs alias ═══');
    eq(CANONICAL_PARAM.warehouse, 'warehouse_codes', 'canónico de warehouse');
    const r1 = parseScopeParam({ warehouse_codes: '01', sucursal: '99' }, 'warehouse', 'test');
    eq(r1.values, ['01'], 'el canónico gana sobre el alias');
    ok(r1.esCanonico === true, 'lo marca como canónico');
    const r2 = parseScopeParam({ sucursal: '99' }, 'warehouse', 'test');
    eq(r2.values, ['99'], 'cae al alias cuando no hay canónico');
    ok(r2.esCanonico === false && r2.nombreUsado === 'sucursal', 'reporta qué alias se usó (deprecación)');

    console.log('\n═══ 2. Los alias medidos se leen ═══');
    for (const alias of PARAM_ALIASES.warehouse) {
      eq(vals({ [alias]: '03' }, 'warehouse'), ['03'], `warehouse ← ${alias}`);
    }
    eq(vals({ zona: 'OFICINAS' }, 'zone'), ['OFICINAS'], 'zone ← zona (etiqueta, no uuid)');
    eq(vals({ zone_id: 'abc' }, 'zone'), ['abc'], 'zone ← zone_id');
    eq(vals({ routes: 'r1,r2' }, 'route'), ['r1', 'r2'], 'route ← routes');

    console.log('\n═══ 3. Las tres formas son equivalentes ═══');
    const esperado = ['01', '03'];
    eq(vals({ warehouse_codes: '01,03' }, 'warehouse'), esperado, 'CSV');
    eq(vals({ warehouse_codes: ['01', '03'] }, 'warehouse'), esperado, 'array (?x=01&x=03)');
    eq(vals({ warehouse_codes: ['01,03'] }, 'warehouse'), esperado, 'array con CSV adentro');
    eq(vals({ warehouse_codes: '01' }, 'warehouse'), ['01'], 'valor único');

    console.log('\n═══ 4. Higiene del valor ═══');
    eq(vals({ warehouse_codes: ' 01 , ,03 ' }, 'warehouse'), esperado, 'trim + descarta vacíos');
    eq(vals({ warehouse_codes: '01,01,03,01' }, 'warehouse'), esperado, 'dedupe');
    eq(vals({ warehouse_codes: ',,,' }, 'warehouse'), null, 'todo vacío = no pidió nada');

    console.log('\n═══ 5. null ≠ [] ═══');
    ok(vals({}, 'warehouse') === null, 'query vacía → null (no pidió nada)');
    ok(vals(undefined, 'warehouse') === null, 'sin query → null');
    ok(vals({ otra_cosa: 'x' }, 'warehouse') === null, 'param ajeno no cuenta');
    ok(Array.isArray(vals({ sucursal: '01' }, 'warehouse')), 'pidió algo → array');

    console.log('\n═══ 6. Varias dimensiones de una query ═══');
    const todo = parseAllScopeParams({ sucursal: '01', zona: 'OFICINAS', sku: 'X' }, 'test');
    eq(todo.warehouse, ['01'], 'lee warehouse');
    eq(todo.zone, ['OFICINAS'], 'lee zone');
    ok(todo.route === undefined, 'no inventa dimensiones que no vinieron');

    console.log('\n═══ 7. Aviso de deprecación: una vez por alias ═══');
    resetAvisosDeprecacion();
    const warns = [];
    const orig = console.warn;
    // El Logger de Nest escribe por stdout/stderr; interceptamos ambos por si acaso.
    const origErr = process.stderr.write.bind(process.stderr);
    const origOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = (c, ...a) => { warns.push(String(c)); return origErr(c, ...a); };
    process.stdout.write = (c, ...a) => { if (/deprecado/.test(String(c))) warns.push(String(c)); return origOut(c, ...a); };
    for (let i = 0; i < 5; i++) parseScopeParam({ sucursal: '01' }, 'warehouse', 'test');
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    console.warn = orig;
    const deprec = warns.filter((w) => /deprecado/.test(w) && /sucursal/.test(w));
    ok(deprec.length === 1, `avisó 1 sola vez en 5 llamadas (avisos=${deprec.length})`);

    console.log('\n═══ 8. Premisa de la traducción de llaves (DB) ═══');
    const DST = process.env.DATABASE_URL_NEW;
    if (!DST) {
      console.log('  — sin DATABASE_URL_NEW: se omite el bloque de DB');
    } else {
      const knex = require('knex')({
        client: 'pg',
        connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
        pool: { min: 0, max: 2 },
      });
      try {
        const wh = await knex.raw(
          `SELECT id::text, code FROM commercial.warehouses
            WHERE deleted_at IS NULL AND code ~ '^[0-9]{2}$' ORDER BY code LIMIT 3`);
        if (!wh.rows.length) {
          console.log('  — esta DB no tiene sucursales de 2 dígitos: se omite');
        } else {
          ok(wh.rows.every((r) => r.id !== r.code), 'una sucursal tiene id (uuid) Y code: son llaves distintas');
          const uno = wh.rows[0];
          const porId = await knex.raw(`SELECT code FROM commercial.warehouses WHERE id::text = ?`, [uno.id]);
          ok(porId.rows[0]?.code === uno.code, `uuid → code resuelve al mismo (${uno.code})`);
          const porCode = await knex.raw(
            `SELECT id::text FROM commercial.warehouses WHERE code = ? AND deleted_at IS NULL`, [uno.code]);
          ok(porCode.rows.length === 1, 'code identifica una sola sucursal viva (traducción no ambigua)');
        }
        const z = await knex.raw(`SELECT id::text, name FROM trade.zones WHERE deleted_at IS NULL LIMIT 1`);
        if (z.rows.length) {
          const dup = await knex.raw(`SELECT count(*) n FROM trade.zones WHERE name = ? AND deleted_at IS NULL`, [z.rows[0].name]);
          ok(Number(dup.rows[0].n) === 1, `el nombre de zona identifica una sola ("${z.rows[0].name}")`);
        }
      } finally {
        await knex.destroy();
      }
    }

    console.log(`\n═══════════ Resultado: ${pass} pass / ${fail} fail ═══════════`);
    if (fail) process.exitCode = 1;
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exitCode = 1;
  }
})();
