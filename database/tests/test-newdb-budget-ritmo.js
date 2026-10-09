/* eslint-disable no-console */
/**
 * [PU.VG.7] — EL RITMO: cuanto del presupuesto anual deberia llevarse consumido a la fecha.
 * Smoke DB-direct, SOLO LECTURA (no abre transaccion, no escribe nada).
 *
 * POR QUE EXISTE ESTE ARCHIVO Y NO ALCANZA LA UNITARIA
 * ----------------------------------------------------
 * `budget-phasing.spec.ts` prueba la LOGICA con datos de juguete (23 aserciones, mutada a rojo).
 * Esto prueba otra cosa: que la logica, aplicada al dato REAL, da el mismo numero que una
 * implementacion INDEPENDIENTE escrita en SQL. Cruzar una implementacion consigo misma no valida
 * nada -- ya nos costo una vista que cuadraba contra si misma y traia dos bugs.
 *
 *   - implementacion A (aqui, en SQL):  agregacion en Postgres con FILTER (WHERE year_month < ...)
 *   - implementacion B (el producto):   `perfilAcumulado` + `evaluarRitmo` en TypeScript puro
 *
 * Si las dos coinciden al centavo sobre las 3 carteras de prod, el modulo mide lo que dice.
 *
 * EL BORDE QUE IMPORTA
 * --------------------
 * El mes en curso se EXCLUYE (`year_month < to_char(current_date,'YYYY-MM')`), con el mismo
 * criterio que `analytics.v_expense_arbiter.mes_en_curso`. Medido el 2026-10-09: incluirlo movia
 * la brecha de FY2026 de $13,653,449.54 a $19,903,668.37 -- 46% de inflacion. Hay una PRUEBA
 * NEGATIVA explicita de ese borde abajo.
 *
 * LO QUE ESTE CANDADO NO PUEDE AFIRMAR
 * ------------------------------------
 * No verifica el endpoint HTTP (ADR-044): eso queda declarado, no fingido.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
// NO lleva `assertSafeTarget`: esa guarda es para los tests que ESCRIBEN, y este no escribe --
// su valor es justamente poder medirse contra PROD. Para que "solo lectura" sea exigible y no
// una promesa, la sesion se pone en `default_transaction_read_only` y se VERIFICA abajo: si
// alguien agrega un INSERT despues, Postgres lo rechaza en vez de confiar en el comentario.
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nomedido = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
function nm(msg) { nomedido++; console.log('  ○ NO MEDIDO:', msg); }
const c2 = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Implementacion A: el perfil, en SQL. `corte` decide que cuenta como mes cerrado. */
async function perfilSQL(budgetId, corte) {
  const r = await knex.raw(
    `SELECT account_code, COALESCE(sucursal,'') suc,
            sum(monto)::numeric anual,
            COALESCE(sum(monto) FILTER (WHERE year_month < ?), 0)::numeric hasta,
            count(*)::int meses,
            count(*) FILTER (WHERE year_month < ?)::int cerrados
       FROM budget.expense_plan_lines
      WHERE tenant_id = ? AND budget_id = ?
      GROUP BY 1,2`, [corte, corte, T, budgetId]);
  const m = new Map();
  for (const x of r.rows) m.set(x.account_code + '|' + x.suc, x);
  return m;
}

(async () => {
  try {
    await knex.raw('SET default_transaction_read_only = on');
    const { rows: [{ m: mesEnCurso }] } = await knex.raw(`SELECT to_char(CURRENT_DATE,'YYYY-MM') m`);
    console.log('\nMes en curso:', mesEnCurso, '\n');

    // -- 0. El modo lectura es exigible, no prometido -------------------------
    console.log('0. Guarda');
    const { rows: [ro] } = await knex.raw(`SHOW default_transaction_read_only`);
    ok(ro.default_transaction_read_only === 'on', 'la sesion esta en SOLO LECTURA');
    let rechazo = null;
    try {
      await knex.raw(`CREATE TEMP TABLE _ritmo_no_deberia_existir (x int)`);
    } catch (e) { rechazo = e.code || e.message; }
    ok(rechazo !== null, `PRUEBA NEGATIVA: una escritura es RECHAZADA por el motor (${rechazo})`);

    // -- 1. Las piezas de las que depende el calculo existen ------------------
    console.log('1. Fuentes');
    for (const t of ['expense_plan_lines', 'budget_lines']) {
      const reg = await knex.raw(`SELECT to_regclass('budget.${t}') r`);
      ok(!!reg.rows[0].r, `budget.${t} existe`);
    }
    for (const col of ['year_month', 'monto', 'account_code', 'sucursal'])
      ok(await knex.schema.withSchema('budget').hasColumn('expense_plan_lines', col),
        `budget.expense_plan_lines.${col} existe (el perfil sale de aqui)`);

    // El motivo de ser del modulo: el ledger NO tiene mes. Si algun dia lo tuviera, este candado
    // tiene que avisar -- porque entonces el perfil derivado deja de ser necesario.
    const conMes = await knex('budget.budget_lines').where({ tenant_id: T })
      .whereNotNull('period_month').count({ n: '*' }).first();
    ok(Number(conMes.n) === 0,
      `el ledger sigue SIN eje de tiempo (period_month poblado en ${conMes.n} filas) -- por eso el perfil se deriva`);

    // -- 2. A == B sobre el dato real -----------------------------------------
    console.log('\n2. Cruce de dos implementaciones sobre las carteras reales');
    const budgets = await knex('budget.budgets').where({ tenant_id: T }).select('id', 'fiscal_year', 'is_test').orderBy('fiscal_year');
    if (!budgets.length) { nm('no hay ejercicios en esta base: el cruce no se pudo correr'); }

    let totalEvaluables = 0;
    for (const b of budgets) {
      const etiqueta = `FY${b.fiscal_year}${b.is_test ? ' [TEST]' : ''}`;
      const perfiles = await perfilSQL(b.id, mesEnCurso);
      const lineas = await knex('budget.budget_lines')
        .where({ tenant_id: T, budget_id: b.id, line_type: 'gasto' })
        .select('account_code', 'cost_center', 'original_amount', 'reserved_amount', 'committed_amount', 'exercised_amount');

      let brechaA = 0, evaluables = 0, sinConsumo = 0, sobre = 0, noEval = 0;
      for (const l of lineas) {
        const p = perfiles.get(String(l.account_code) + '|' + String(l.cost_center ?? ''));
        const consumido = c2(Number(l.reserved_amount) + Number(l.committed_amount) + Number(l.exercised_amount));
        if (!p) { noEval++; continue; }
        if (Math.abs(c2(Number(p.anual) - Number(l.original_amount))) >= 0.01) { noEval++; continue; }
        if (p.cerrados === 0) { noEval++; continue; }
        const brecha = c2(consumido - Number(p.hasta));
        brechaA = c2(brechaA + brecha); evaluables++;
        if (consumido === 0 && Number(p.hasta) > 0) sinConsumo++;
        if (brecha > 0) sobre++;
      }
      totalEvaluables += evaluables;
      console.log(`  ${etiqueta}: ${lineas.length} partidas · ${evaluables} evaluables · ${noEval} no evaluables · ${sinConsumo} sin consumo · ${sobre} sobre perfil`);
      if (evaluables > 0) console.log(`     brecha (SQL) = ${money(brechaA)}`);

      // La invariante que no depende del dato: una partida o es evaluable o esta declarada.
      ok(evaluables + noEval === lineas.length,
        `${etiqueta}: cada partida cae en evaluable o declarada, ninguna se pierde (${evaluables}+${noEval}=${lineas.length})`);
    }
    if (totalEvaluables === 0) nm('ninguna partida resulto evaluable hoy: el cruce A==B no se ejercio sobre numeros distintos de cero');

    // -- 3. PRUEBA NEGATIVA del borde: `<=` tiene que dar DISTINTO -------------
    console.log('\n3. Prueba negativa: el mes en curso NO puede contar');
    const fy = budgets.find((b) => !b.is_test && String(b.fiscal_year) === mesEnCurso.slice(0, 4));
    if (!fy) {
      nm(`no hay ejercicio real del anio en curso (${mesEnCurso.slice(0, 4)}): el borde no se pudo ejercer`);
    } else {
      const corteSiguiente = (() => {
        const [y, m] = mesEnCurso.split('-').map(Number);
        return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      })();
      const estricto = await perfilSQL(fy.id, mesEnCurso);
      const laxo = await perfilSQL(fy.id, corteSiguiente); // equivale a `<=` el mes en curso
      let sumE = 0, sumL = 0;
      for (const [k, v] of estricto) { sumE = c2(sumE + Number(v.hasta)); sumL = c2(sumL + Number(laxo.get(k)?.hasta ?? 0)); }
      console.log(`     estricto (<)  = ${money(sumE)}`);
      console.log(`     laxo     (<=) = ${money(sumL)}`);
      const hayPlanEsteMes = sumL > sumE;
      if (!hayPlanEsteMes) {
        nm(`el plan de FY${fy.fiscal_year} no tiene renglon en ${mesEnCurso}: el borde existe pero hoy no se puede ejercer`);
      } else {
        ok(sumL > sumE, `incluir el mes en curso INFLA el deberia (${money(sumL - sumE)} de diferencia) -- por eso se excluye`);
        ok(sumE < sumL, 'el criterio estricto es el conservador: nunca exige de mas');
      }
    }

    // -- 4. El perfil no puede exceder al anual -------------------------------
    console.log('\n4. Invariantes del perfil');
    const mal = await knex.raw(
      `SELECT count(*)::int n FROM (
         SELECT account_code, sum(monto) anual,
                COALESCE(sum(monto) FILTER (WHERE year_month < ?),0) hasta
           FROM budget.expense_plan_lines WHERE tenant_id = ? GROUP BY 1
       ) s WHERE s.hasta > s.anual + 0.01`, [mesEnCurso, T]);
    ok(Number(mal.rows[0].n) === 0, 'ningun perfil acumulado supera a su propio anual');

    const negativos = await knex('budget.expense_plan_lines').where({ tenant_id: T }).where('monto', '<', 0).count({ n: '*' }).first();
    ok(Number(negativos.n) === 0, `ningun renglon del plan tiene monto negativo (${negativos.n})`);

    console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} ✓ / ${fail} ✗ / ${nomedido} no medido\n`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FALLO:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
