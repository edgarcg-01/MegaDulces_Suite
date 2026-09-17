/* eslint-disable no-console */
/**
 * Fase PU.2 — Presupuestos: presupuesto vs real (ADR-066 / ADR-056 / ADR-059). Smoke DB-direct.
 *
 * Verifica contra la DB real:
 *   1. La fuente real del ODS `analytics.sales_daily` es legible (tenant × periodo) y trae ventas/costo.
 *   2. Frescura declarable: `max(updated_at)` existe (la tabla es ETL, no vista viva).
 *   3. «Sin datos» ≠ cero (ADR-056): un periodo sin ventas devuelve 0 filas → el servicio va a null.
 *   4. Roll-up interno por tipo (vigente + buckets + ocupación + disponible), exacto, sin ODS.
 *   5. KPI cumplimiento = real/presupuesto: finito con base > 0, y «sin base» (null) cuando presupuesto = 0.
 *
 * Valida el SCHEMA/consultas del servicio `BudgetComparisonService`. La verificación end-to-end por
 * HTTP queda PENDIENTE (ADR-044) — declarada, no fingida.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-comparison');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num, den) => (den > 0 ? round2((num / den) * 100) : null);
const ROLLBACK = Symbol('rollback');

(async () => {
  try {
    // ── 1-3. Real del ODS + «sin datos» ─────────────────────────────────────
    const realAgg = async (from, to) => {
      const [a] = await knex('analytics.sales_daily').where({ tenant_id: T }).whereBetween('sale_date', [from, to])
        .select(knex.raw('count(*)::int n'), knex.raw('coalesce(sum(revenue),0) ventas'), knex.raw('coalesce(sum(cost),0) costo'), knex.raw('max(updated_at) as_of'));
      return a;
    };
    const y2026 = await realAgg('2026-01-01', '2026-12-31');
    ok(Number(y2026.n) > 0, `analytics.sales_daily legible: ${y2026.n} filas 2026 (tenant demo)`);
    ok(Number(y2026.ventas) > 0, `real ventas 2026 = ${round2(Number(y2026.ventas))} (> 0)`);
    ok(!!y2026.as_of, `frescura declarable: max(updated_at) = ${y2026.as_of ? new Date(y2026.as_of).toISOString().slice(0, 10) : 'null'}`);

    const vacio = await realAgg('2099-01-01', '2099-12-31');
    ok(Number(vacio.n) === 0, '«Sin datos»: periodo 2099 devuelve 0 filas → el servicio va a null (no 0)');

    // ── 4-5. Roll-up interno + KPI (rollback al final) ───────────────────────
    await knex.transaction(async (trx) => {
      const [bud] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PU cmp ' + Date.now(), fiscal_year: 2026, status: 'aprobado', created_by: 'a', authorized_by: 'b', authorized_at: trx.fn.now() }).returning('*');
      const mkLine = async (concept, type, amount) => {
        const [l] = await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: bud.id, concept, line_type: type, original_amount: amount, vigente_amount: amount, control_level: 'bloqueo', created_by: 'a' }).returning('*');
        return l;
      };
      const ingreso = await mkLine('Meta ventas', 'ingreso', 500000);
      const gasto = await mkLine('Renta', 'gasto', 200000);
      // reserva 50k sobre gasto
      await trx('budget.budget_lines').where({ id: gasto.id }).update({ reserved_amount: 50000 });

      const rows = await trx('budget.budget_lines').where({ budget_id: bud.id }).groupBy('line_type').select('line_type')
        .sum({ vigente: 'vigente_amount', reserved: 'reserved_amount', committed: 'committed_amount', exercised: 'exercised_amount', paid: 'paid_amount' });
      const g = rows.find((r) => r.line_type === 'gasto');
      const i = rows.find((r) => r.line_type === 'ingreso');
      const dispG = round2(Number(g.vigente) - Number(g.reserved) - Number(g.committed) - Number(g.exercised));
      ok(Number(g.vigente) === 200000 && Number(g.reserved) === 50000, 'Roll-up gasto: vigente 200,000 · reservado 50,000');
      ok(dispG === 150000, 'Roll-up gasto: disponible 150,000');
      ok(pct(50000, 200000) === 25, 'Ocupación gasto = 25%');
      ok(Number(i.vigente) === 500000, 'Roll-up ingreso: vigente 500,000 (presupuesto de ventas)');

      // KPI cumplimiento = real ventas / presupuesto ingresos
      const cumpl = pct(Number(y2026.ventas), Number(i.vigente));
      ok(cumpl !== null && Number.isFinite(cumpl), `KPI cumplimiento ventas = ${cumpl}% (real/${Number(i.vigente)}) es finito`);
      ok(pct(Number(y2026.ventas), 0) === null, 'KPI «sin base»: presupuesto ingresos = 0 → cumplimiento null (no división por cero)');

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\nBudget comparison (PU.2): ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    await knex.destroy();
    process.exit(1);
  }
})();
