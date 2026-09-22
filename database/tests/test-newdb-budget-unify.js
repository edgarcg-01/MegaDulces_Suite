/* eslint-disable no-console */
/**
 * Fase PU — Bloques B4 + B1/B2 (ADR-066). Smoke DB-direct de lo DETERMINISTA de estos cambios.
 * Todo dentro de una trx con ROLLBACK → cero efecto real.
 *
 * Verifica:
 *   1. **B4 (mig 20260921200000)** — el CHECK de `budget.sales_plan_lines.method` ACEPTA los métodos
 *      de fallback declarado `proxy_canal` y `sin_base_declarado`, y RECHAZA uno bogus (prueba negativa).
 *   2. **B1/B2** — el link obligación→partida: `budget.expense_obligations.budget_line_id` acepta una
 *      partida real (FK compuesto (tenant_id, budget_line_id) OK) y RECHAZA una inexistente (negativa).
 *
 * ⚠️ NOTA (declarado, no fingido): el unify a nivel SERVICIO —autorizar→comprometer, pagar→ejercer+
 * pagar, cancelar→liberar, vía `BUDGET_LEDGER_PORT` en la trx del Calendario de Pagos— es por HTTP
 * (ADR-044) y queda PENDIENTE de correr contra el stack. Este smoke cubre el SCHEMA, no el servicio.
 *
 * Requiere la mig `20260921200000` aplicada + DB. Correr: node database/tests/test-newdb-budget-unify.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-unify');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const ROLLBACK = Symbol('rollback');

(async () => {
  try {
    await knex.transaction(async (trx) => {
      const [bud] = await trx('budget.budgets').insert({
        tenant_id: T, name: 'PU-unify smoke ' + Date.now(), fiscal_year: 2026, created_by: 'tester',
      }).returning('*');
      const [line] = await trx('budget.budget_lines').insert({
        tenant_id: T, budget_id: bud.id, concept: 'Renta', line_type: 'gasto',
        original_amount: 120000, vigente_amount: 120000, control_level: 'bloqueo',
        source: 'plan', source_ref: 'gasto:TESTACC:', created_by: 'tester',
      }).returning('*');

      // ── 1. B4 — CHECK de method acepta los fallback (mig 20260921200000) ──────
      const fallback = ['proxy_canal', 'sin_base_declarado'];
      for (let i = 0; i < fallback.length; i++) {
        const m = fallback[i];
        await trx.raw('SAVEPOINT s');
        try {
          await trx('budget.sales_plan_lines').insert({
            tenant_id: T, budget_id: bud.id, entity_key: 'mostrador:01', period_no: i + 1,
            meta_amount: 1000, method: m, created_by: 'tester', updated_by: 'tester',
          });
          await trx.raw('RELEASE SAVEPOINT s');
          ok(true, `B4: CHECK acepta method='${m}'`);
        } catch (e) {
          await trx.raw('ROLLBACK TO SAVEPOINT s');
          ok(false, `B4: CHECK RECHAZA method='${m}' — ¿falta aplicar la mig 20260921200000? ${e.message}`);
        }
      }
      // negativa: un método bogus DEBE ser rechazado
      await trx.raw('SAVEPOINT s');
      try {
        await trx('budget.sales_plan_lines').insert({
          tenant_id: T, budget_id: bud.id, entity_key: 'mostrador:01', period_no: 3,
          meta_amount: 1000, method: 'metodo_falso', created_by: 'tester', updated_by: 'tester',
        });
        await trx.raw('RELEASE SAVEPOINT s');
        ok(false, 'B4: method bogus DEBIÓ ser rechazado por el CHECK y pasó');
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT s');
        ok(true, 'B4: method bogus rechazado por el CHECK (prueba negativa)');
      }

      // ── 2. B1/B2 — el link obligación→partida (FK compuesto) ──────────────────
      const [ob] = await trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'Renta ene', beneficiary: 'ARRENDADOR', original_amount: 10000,
        status: 'propuesta', source: 'plan', source_ref: 'plan:' + bud.id + ':TESTACC::2026-01',
        budget_line_id: line.id, created_by: 'tester',
      }).returning('*');
      ok(ob.budget_line_id === line.id, 'B1/B2: obligación linkeada a su partida (budget_line_id) — FK compuesto OK');

      // negativa: link a una partida inexistente DEBE fallar el FK
      await trx.raw('SAVEPOINT s');
      try {
        await trx('budget.expense_obligations').insert({
          tenant_id: T, concept: 'x', beneficiary: 'x', original_amount: 1, status: 'propuesta',
          budget_line_id: '00000000-0000-0000-0000-000000000999', created_by: 'tester',
        });
        await trx.raw('RELEASE SAVEPOINT s');
        ok(false, 'B1/B2: link a partida inexistente DEBIÓ fallar el FK y pasó');
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT s');
        ok(true, 'B1/B2: link a partida inexistente rechazado por el FK (prueba negativa)');
      }

      throw ROLLBACK; // cero efecto real
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\n${fail === 0 ? '✅' : '❌'} test-newdb-budget-unify: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    await knex.destroy().catch(() => undefined);
    // DB inalcanzable → NO MEDIDO (exit 2), nunca verde.
    console.error('NO MEDIDO — no se pudo ejercer contra la DB:', e.message);
    process.exit(2);
  }
})();
