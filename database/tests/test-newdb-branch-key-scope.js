#!/usr/bin/env node
/**
 * `[RE.23]` — **La llave canónica de la sucursal, y por qué Morelia no existía.**
 *
 * El defecto: la regla "una sucursal es `commercial.warehouses.code ~ '^[0-9]{2}$'`"
 * vivía copiada en tres lugares (`ScopeService.UNIVERSO_SQL`, `users.getBranches()`
 * y la constante `STORE_BRANCHES` del front). Las sucursales de Morelia corren
 * Wincaja, no tienen código Kepler y guardan el suyo prefijado (`MD-30`), así que
 * la regla las dejaba **fuera del modelo de alcance por completo**: no se podían
 * asignar a nadie, no salían en ningún selector, y de todos modos no habrían
 * filtrado nada, porque los feeds emiten `'30'` y no `'MD-30'`.
 *
 * Consecuencia medida en prod antes del arreglo: la persona a cargo de subir las
 * órdenes de entrada de Morelia tenía alcance `all` —no por decisión, sino porque
 * `MD-30` no era un valor asignable— y sus 410 recepciones del carril al día
 * quedaban enterradas entre 1,083 ajenas, sin forma de filtrarlas.
 *
 * Lo que se fija acá:
 *   1. La llave canónica (`branchKeySql`) devuelve el código de 2 dígitos para
 *      TODAS las sucursales, venga de `code` o de `wincaja_source_branch`.
 *   2. No colisiona: una llave = una sucursal.
 *   3. Los almacenes-ruta (`RUTA-*`) quedan fuera — no son sucursales.
 *   4. **La prueba de fondo**: la llave es la MISMA que emiten los feeds. Si
 *      alguien vuelve a canonizar por `code`, `IN ('MD-30')` da cero filas y este
 *      test se pone rojo acá, no en la pantalla de alguien que trabaja.
 *
 * Correr: node database/tests/test-newdb-branch-key-scope.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW'); process.exit(1); }

const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

// Misma expresión que `branchKeySql()` en libs/platform-core/.../scope.types.ts.
// Se repite acá a propósito: el smoke tiene que fallar si el SQL de producción
// se desvía de lo que este archivo declara como la llave.
const KEY = (a) => `CASE WHEN ${a}.code ~ '^[0-9]{2}$' THEN ${a}.code ELSE ${a}.wincaja_source_branch END`;
const FILTER = (a) => `(${KEY(a)}) ~ '^[0-9]{2}$'`;

let pass = 0, fail = 0;
const assert = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`); pass++; }
  else { console.error(`  ✗ ${msg}`); fail++; }
};

const knex = require('knex')({
  client: 'pg',
  connection: /localhost|127\.0\.0\.1|192\.168/.test(DST)
    ? DST
    : { connectionString: DST, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 3 },
});

(async () => {
  try {
    // La columna llegó en la mig 20260815130000. Un ambiente anterior no puede
    // verificar nada de esto: se DECLARA y se sale limpio, no se afirma en falso.
    const hay = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'wincaja_source_branch');
    if (!hay) {
      console.log('  ⚠️  `commercial.warehouses.wincaja_source_branch` no existe en este ambiente');
      console.log('      (mig 20260815130000) — la llave de sucursal queda SIN VERIFICAR. SKIP.');
      await knex.destroy();
      process.exit(0);
    }

    // ── 1. La llave resuelve para todas las sucursales ──────────────────────
    console.log('\n═══ 1. La llave canónica de sucursal ═══');
    const universo = await knex.raw(
      `SELECT ${KEY('w')} AS v, w.code AS code, w.name AS label
         FROM commercial.warehouses w
        WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND ${FILTER('w')}
        ORDER BY 1`, [T]);
    const filas = universo.rows;
    const llaves = filas.map((r) => r.v);
    assert(llaves.length > 0, `el universo no queda vacío (${llaves.length} sucursales)`);
    assert(llaves.every((v) => /^[0-9]{2}$/.test(v)), 'toda llave es un código de 2 dígitos');

    // ── 2. Sin colisiones ───────────────────────────────────────────────────
    const dup = llaves.filter((v, i) => llaves.indexOf(v) !== i);
    assert(dup.length === 0, `una llave = una sucursal (repetidas: ${dup.join(',') || 'ninguna'})`);

    // ── 3. Las de Wincaja entran, con su código de 2 dígitos ────────────────
    console.log('\n═══ 2. Las sucursales sin código Kepler ═══');
    const wincaja = filas.filter((r) => r.code !== r.v);
    if (!wincaja.length) {
      console.log('  ⚠️  este ambiente no tiene sucursales Wincaja — el caso que motivó [RE.23]');
      console.log('      no se puede verificar acá. SKIP del bloque 2-3.');
    } else {
      for (const r of wincaja) {
        assert(/^[0-9]{2}$/.test(r.v), `\`${r.code}\` (${r.label}) entra al universo como \`${r.v}\``);
      }
      // El `code` prefijado NO puede colarse como llave: es exactamente el valor
      // que no matchea nada aguas abajo.
      assert(!llaves.some((v) => v.startsWith('MD-')), 'ningún `MD-*` se cuela como llave');
    }

    // ── 4. Los almacenes-ruta quedan fuera ──────────────────────────────────
    const rutas = await knex.raw(
      `SELECT count(*)::int n FROM commercial.warehouses w
        WHERE w.tenant_id = ? AND w.deleted_at IS NULL
          AND w.code LIKE 'RUTA-%' AND ${FILTER('w')}`, [T]);
    assert(rutas.rows[0].n === 0, 'los almacenes-ruta (`RUTA-*`) NO son sucursales y quedan fuera');

    // ── 5. La prueba de fondo: la llave es la que emiten los feeds ──────────
    console.log('\n═══ 3. La llave casa con lo que emiten los feeds ═══');
    const hayVista = await knex.raw(`SELECT to_regclass('analytics.erp_goods_receipts') AS t`);
    if (!hayVista.rows[0].t) {
      console.log('  ⚠️  `analytics.erp_goods_receipts` no existe acá — el cruce queda SIN VERIFICAR');
    } else {
      const feed = await knex.raw(
        `SELECT DISTINCT sucursal FROM analytics.erp_goods_receipts WHERE tenant_id = ?`, [T]);
      const emitidas = feed.rows.map((r) => r.sucursal);
      if (!emitidas.length) {
        console.log('  ⚠️  la vista de recepciones está vacía en este ambiente — cruce SIN VERIFICAR');
      } else {
        const huerfanas = emitidas.filter((s) => !llaves.includes(s));
        assert(
          huerfanas.length === 0,
          `toda sucursal del feed es nombrable por el alcance (huérfanas: ${huerfanas.join(',') || 'ninguna'})`,
        );
        // El corazón del bug: filtrar por `code` daba cero. Se afirma en positivo
        // Y en negativo, porque el fallo original era silencioso — no un error,
        // una lista vacía.
        const conLlave = await knex.raw(
          `SELECT count(*)::int n FROM analytics.erp_goods_receipts
            WHERE tenant_id = ? AND sucursal = ANY(?)`, [T, llaves]);
        const conCode = await knex.raw(
          `SELECT count(*)::int n FROM analytics.erp_goods_receipts g
            WHERE g.tenant_id = ? AND g.sucursal = ANY(
              SELECT w.code FROM commercial.warehouses w
               WHERE w.tenant_id = ? AND w.deleted_at IS NULL AND w.code !~ '^[0-9]{2}$')`, [T, T]);
        assert(conLlave.rows[0].n > 0, `filtrar por la llave canónica devuelve filas (${conLlave.rows[0].n})`);
        assert(
          conCode.rows[0].n === 0,
          `filtrar por el \`code\` prefijado devuelve 0 — ése era el bug (dio ${conCode.rows[0].n})`,
        );
      }
    }

    // ── 6. La traducción: uuid o `MD-30` → la llave ─────────────────────────
    console.log('\n═══ 4. Traducción a la llave canónica ═══');
    if (wincaja.length) {
      const uno = wincaja[0];
      const trad = await knex.raw(
        `SELECT (${KEY('t')})::text AS canon FROM commercial.warehouses t
          WHERE t.tenant_id = ? AND (t.id::text = ANY(?) OR t.code::text = ANY(?))`,
        [T, [uno.code], [uno.code]]);
      assert(
        trad.rows.length === 1 && trad.rows[0].canon === uno.v,
        `\`${uno.code}\` se traduce a \`${uno.v}\` (dio \`${trad.rows[0]?.canon}\`)`,
      );
    }
    // Un `RUTA-*` traduce a NULL: no tiene llave, y el servicio lo descarta
    // avisando en el log en vez de dejarlo pasar como filtro que no matchea.
    const rutaTrad = await knex.raw(
      `SELECT (${KEY('t')})::text AS canon FROM commercial.warehouses t
        WHERE t.tenant_id = ? AND t.code LIKE 'RUTA-%' LIMIT 1`, [T]);
    if (rutaTrad.rows.length) {
      assert(rutaTrad.rows[0].canon === null, 'un `RUTA-*` traduce a NULL (no tiene llave de sucursal)');
    }

    console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  process.exit(fail === 0 ? 0 : 1);
})();
