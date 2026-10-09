/* eslint-disable no-console */
/**
 * [PU.VG.9] — LA PANTALLA ABRIA SOBRE EL EJERCICIO DE PRUEBA. Smoke DB-direct, SOLO LECTURA.
 *
 * LOS TRES ESLABONES, Y NINGUNO ES CULPABLE SOLO
 * ----------------------------------------------
 *   1. `budget-lines.service.ts::listBudgets()` ordenaba por `fiscal_year DESC, created_at DESC`;
 *   2. el duplicado de FY2027 es el MAS NUEVO, asi que quedaba primero por ser reciente;
 *   3. el front hace `selectBudget(rows[0])`.
 *
 * Medido en prod el 2026-10-09, el orden que recibia el selector era:
 *     [0] FY2027 [PRUEBA]  sin folio      PRUEBA ciclo ledger -- no usar
 *     [1] FY2027   real    PRE-2027-002   Presupuesto 2027
 *     [2] FY2026   real    PRE-2026-002
 *
 * LO QUE LO VOLVIA INVISIBLE
 * --------------------------
 * El duplicado es exacto al centavo: el egreso del de prueba y el del real de FY2027 son LOS DOS
 * $74,850,066.62. Asi que la pantalla no publicaba un numero falso -- publicaba el numero correcto
 * leido de una fila que nadie mantiene. El dia que alguien edite una de las dos, la pantalla sigue
 * anclada a la de prueba y nada cambia visualmente. Por eso este candado NO compara importes: un
 * candado por importe aca daria verde siempre.
 *
 * EL ARREGLO NO ES FILTRAR
 * ------------------------
 * Esconder el ejercicio de prueba lo vuelve inalcanzable desde la UI -nadie podria ni borrarlo- y
 * es un cambio de comportamiento en silencio. Cambia el ORDEN: `is_test` ultimo. Deja de ser
 * `rows[0]` sin desaparecer, y se arregla para TODO cliente del endpoint.
 *
 * READ-ONLY exigible: la sesion se pone en `default_transaction_read_only` y el bloque 0 lo
 * comprueba con una escritura que el motor tiene que RECHAZAR.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nomedido = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function nm(msg) { nomedido++; console.log('  ○ NO MEDIDO:', msg); }

const ORDEN_VIEJO = `ORDER BY fiscal_year DESC, created_at DESC`;
const ORDEN_NUEVO = `ORDER BY is_test ASC, fiscal_year DESC, created_at DESC`;

async function lista(orden) {
  const r = await knex.raw(
    `SELECT name, fiscal_year, is_test, folio FROM budget.budgets WHERE tenant_id = ? ${orden}`, [T]);
  return r.rows;
}

(async () => {
  try {
    await knex.raw('SET default_transaction_read_only = on');

    console.log('\n0. Guarda');
    let rechazo = null;
    try { await knex.raw('CREATE TEMP TABLE _orden_no_deberia (x int)'); } catch (e) { rechazo = e.code || e.message; }
    ok(rechazo !== null, `PRUEBA NEGATIVA: una escritura es RECHAZADA por el motor (${rechazo})`);

    console.log('\n1. La columna existe y no admite NULL');
    ok(await knex.schema.withSchema('budget').hasColumn('budgets', 'is_test'), 'budget.budgets.is_test existe');
    const meta = await knex.raw(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='budget' AND table_name='budgets' AND column_name='is_test'`);
    ok(meta.rows[0]?.is_nullable === 'NO',
      'is_test es NOT NULL: no hay NULLs que ordenar, un ejercicio nuevo se asume REAL');

    console.log('\n2. El orden NUEVO no deja un ejercicio de prueba como rows[0]');
    const nuevo = await lista(ORDEN_NUEVO);
    if (!nuevo.length) { nm('no hay ejercicios en esta base: el orden no se pudo ejercer'); }
    else {
      console.log('   ' + nuevo.map((r, i) => `[${i}] FY${r.fiscal_year} ${r.is_test ? '[PRUEBA]' : ' real  '} ${r.folio ?? 'sin folio'}`).join('\n   '));
      ok(nuevo[0].is_test !== true, 'rows[0] NO es un ejercicio de prueba');
      // Invariante que no depende de cuantos haya: ninguna prueba antes de un real.
      const primerPrueba = nuevo.findIndex((r) => r.is_test === true);
      const ultimoReal = nuevo.map((r) => r.is_test === true).lastIndexOf(false);
      ok(primerPrueba === -1 || primerPrueba > ultimoReal,
        'todos los de prueba quedan DESPUES de todos los reales');
      ok(nuevo.length === (await lista(ORDEN_VIEJO)).length,
        'el orden nuevo NO esconde ninguna fila: misma cantidad que el viejo');
    }

    console.log('\n3. PRUEBA NEGATIVA: el orden VIEJO tenia que fallar');
    const viejo = await lista(ORDEN_VIEJO);
    const hayPrueba = viejo.some((r) => r.is_test === true);
    const hayReal = viejo.some((r) => r.is_test !== true);
    if (!hayPrueba || !hayReal) {
      nm('no hay a la vez un ejercicio de prueba y uno real: el arreglo no se puede distinguir de un no-op hoy');
    } else if (viejo[0].is_test !== true) {
      nm('con los datos de hoy el orden viejo TAMPOCO abria sobre una prueba (depende de created_at): el arreglo sigue siendo correcto, pero este bloque no lo demuestra');
    } else {
      ok(viejo[0].is_test === true && nuevo[0].is_test !== true,
        'el orden viejo abria sobre la PRUEBA y el nuevo no: los dos difieren, el arreglo no es un no-op');
    }

    console.log('\n4. Por que el defecto era invisible');
    const imp = await knex.raw(
      `SELECT b.is_test, sum(l.original_amount)::numeric m
         FROM budget.budgets b JOIN budget.budget_lines l ON l.budget_id = b.id
        WHERE b.tenant_id = ? AND b.fiscal_year = 2027 AND l.line_type = 'gasto'
        GROUP BY 1 ORDER BY 1`, [T]);
    if (imp.rows.length === 2) {
      const [a, b] = imp.rows.map((r) => Number(r.m));
      ok(Math.abs(a - b) < 0.01,
        `el duplicado publica la MISMA cifra al centavo (${a}): por eso no se delata solo, y por eso el candado mira el ORDEN y no el importe`);
    } else {
      nm(`FY2027 no tiene las dos caras (real + prueba): hay ${imp.rows.length}. La premisa del defecto ya no esta`);
    }

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} no medido\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FALLO:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
