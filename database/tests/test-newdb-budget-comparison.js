/* eslint-disable no-console */
/**
 * Fase PU.2 — Presupuestos: presupuesto vs real (ADR-066 / ADR-056 / ADR-059). Smoke DB-direct.
 *
 * Verifica contra la DB real:
 *   1. La fuente real del ODS `analytics.mv_sales_blended` es legible (tenant × periodo) y trae ventas/costo.
 *   2. Frescura declarable por el LATIDO del refresco (`analytics_refresh_blended`), no por la fila:
 *      `mv_sales_blended.updated_at` es la fecha de venta truncada a medianoche, no el sello de
 *      materialización — usarla de reloj es el defecto que VP.0 midió en 21 de 24 píldoras.
 *      ⛔ La fuente era `analytics.sales_daily`, que cubre 6 de 8 sucursales (`[AUD-DAT.1]`); el
 *      invariante de cobertura lo guarda `test-newdb-sales-source-coverage.js`, que corre contra prod.
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
/** Misma constante que declara el servicio (`budget-comparison.service.ts`). */
const SALES_FACT = 'analytics.mv_sales_blended';
const SALES_FACT_LANE = 'analytics_refresh_blended';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (num, den) => (den > 0 ? round2((num / den) * 100) : null);
const ROLLBACK = Symbol('rollback');

(async () => {
  try {
    // ── 1-3. Real del ODS + «sin datos» ─────────────────────────────────────
    const realAgg = async (from, to) => {
      const [a] = await knex(SALES_FACT).where({ tenant_id: T }).whereBetween('sale_date', [from, to])
        .select(knex.raw('count(*)::int n'), knex.raw('coalesce(sum(revenue),0) ventas'), knex.raw('coalesce(sum(cost),0) costo'));
      return a;
    };
    const y2026 = await realAgg('2026-01-01', '2026-12-31');
    ok(Number(y2026.n) > 0, `${SALES_FACT} legible: ${y2026.n} filas 2026 (tenant demo)`);
    ok(Number(y2026.ventas) > 0, `real ventas 2026 = ${round2(Number(y2026.ventas))} (> 0)`);
    // La frescura sale del latido de ENTREGA, no de la fila (ADR-053). `laneAt` devuelve null si el
    // carril no reporta, y eso vale «unknown», no «al día» — por eso se acepta null DECLARÁNDOLO.
    const [lane] = await knex('analytics.cron_runs').where({ job_key: SALES_FACT_LANE }).select('last_finish', 'status');
    ok(!!lane, `frescura declarable por latido: '${SALES_FACT_LANE}' existe en analytics.cron_runs (${lane ? lane.status + ', ' + new Date(lane.last_finish).toISOString().slice(0, 16) : 'AUSENTE → el servicio declara unknown'})`);

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
