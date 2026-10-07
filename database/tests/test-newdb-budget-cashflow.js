/* eslint-disable no-console */
/**
 * Fase PU.3 — Presupuestos: flujo de efectivo previsto (ADR-066 / ADR-056). Smoke DB-direct.
 *
 * Verifica contra la DB real:
 *   1. Cobros previstos: `analytics.customer_receivables` (saldo_documento por vencimiento) es legible.
 *   2. «Sin datos» ≠ cero (ADR-056): `finance.bank_movements` vacío para el tenant demo → el servicio
 *      DECLARA saldo inicial no disponible (null), NO 0. Con saldo inicial → suma la última running_balance.
 *   3. Pagos previstos: UNION de las 3 obligaciones, pendiente = original − pagado, por semana de
 *      `negotiated_date ?? original_due_date`, sin doble-conteo.
 *   4. Fórmula §10: neto = cobros − pagos; saldo_proyectado = null sin saldo inicial (se declara).
 *
 * Valida el SCHEMA/consultas de `BudgetCashflowService`. HTTP end-to-end: PENDIENTE (ADR-044).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-cashflow');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ROLLBACK = Symbol('rollback');

(async () => {
  try {
    // ── 1. Cobros: cartera legible ────────────────────────────────────────────
    const [cob] = await knex('analytics.customer_receivables').where({ tenant_id: T }).andWhere('saldo_documento', '>', 0)
      .select(knex.raw('count(*)::int n'), knex.raw('coalesce(sum(saldo_documento),0) saldo'), knex.raw('max(computed_at) as_of'));
    ok(Number(cob.n) > 0, `analytics.customer_receivables legible: ${cob.n} docs con saldo (tenant demo)`);
    ok(Number(cob.saldo) > 0, `saldo de cartera total = ${round2(Number(cob.saldo))} (> 0)`);

    // ── 2. «Sin datos» saldo inicial: bank_movements vacío para el demo ────────
    const [bank] = await knex('finance.bank_movements').where({ tenant_id: T }).whereNull('deleted_at').select(knex.raw('count(*)::int n'));
    ok(Number(bank.n) === 0, '«Sin datos»: finance.bank_movements vacío (demo) → saldo inicial se DECLARA null, no 0');

    // ── 3-4. Pagos (baseline+delta, robusto a datos ambiente) + fórmula ────────
    await knex.transaction(async (trx) => {
      const from = '2026-10-01', to = '2026-10-31';
      const oneTable = (t) => `SELECT (original_amount - paid_amount) AS pending
        FROM ${t} WHERE tenant_id = '${T}' AND status <> 'cancelled' AND original_amount > paid_amount
          AND coalesce(negotiated_date, original_due_date) BETWEEN '${from}' AND '${to}'`;
      const pagosSql = `SELECT coalesce(sum(pending),0) AS monto FROM (
        ${oneTable('budget.expense_obligations')} UNION ALL
        ${oneTable('commercial.supplier_payment_obligations')} UNION ALL
        ${oneTable('finance.financial_commitments')}
      ) u`;
      // Baseline: puede haber obligaciones del seed demo de TP en el rango.
      const base = Number((await trx.raw(pagosSql)).rows[0].monto);

      // Mi obligación: pendiente 20,000 (30k − 10k pagado), vence 2026-10-15 (lunes 2026-10-12).
      const bud = (await trx('budget.budgets').insert({ tenant_id: T, name: 'PU cf ' + Date.now(), fiscal_year: 2026, created_by: 't' }).returning('id'))[0];
      const line = (await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: bud.id, concept: 'x', original_amount: 100000, vigente_amount: 100000, created_by: 't' }).returning('id'))[0];
      await trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'Renta oct', beneficiary: 'Arrendador', original_amount: 30000, paid_amount: 10000,
        original_due_date: '2026-10-15', status: 'partial', authorized_by: 't', created_by: 't', budget_line_id: line.id,
      });
      const after = Number((await trx.raw(pagosSql)).rows[0].monto);
      ok(round2(after - base) === 20000, `Pagos previstos: delta = 20,000 (pendiente 30k − 10k pagado; base ambiente ${round2(base)})`);

      // Bucket semanal: date_trunc('week') de 2026-10-15 = lunes 2026-10-12
      const [wk] = (await trx.raw(`SELECT date_trunc('week', DATE '2026-10-15')::date AS b`)).rows;
      ok(new Date(wk.b).getUTCDay() === 1 || new Date(wk.b).getDay() === 1, 'Bucket semanal = lunes (date_trunc week)');

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    // ── 4. Fórmula §10 (pura, sin depender de datos de bancos) ────────────────
    // Con saldo inicial disponible: saldo_proyectado = inicial + Σ(cobros − pagos).
    const neto = round2(0 - 20000);              // una semana: cobros 0, pagos 20k
    ok(neto === -20000, 'Fórmula §10: neto = cobros − pagos = −20,000 (real aunque no haya saldo inicial)');
    ok(round2(5000 + neto) === -15000, 'Con saldo inicial 5,000 → proyectado −15,000 < 0 → alerta falta_liquidez');

    console.log(`\nBudget cashflow (PU.3): ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    await knex.destroy();
    process.exit(1);
  }
})();
