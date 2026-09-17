/* eslint-disable no-console */
/**
 * Fase PU.1 — Presupuestos: motor de egresos (ADR-066). Smoke DB-direct.
 *
 * Verifica contra la DB real (todo dentro de una trx con ROLLBACK — cero efecto real):
 *   1. Schema: budget.budgets / budget_lines / line_movements con RLS FORZADO; el link
 *      budget.expense_obligations.budget_line_id; el índice único de idempotencia.
 *   2. Reproduce EXACTO el ejemplo de aceptación de la spec §8.2 sobre una partida:
 *      disponible = vigente − reserva − compromiso − ejercido (el PAGADO va aparte, no resta).
 *   3. El índice único de idempotencia rechaza (origen,documento,tipo) repetido (savepoint).
 *   4. Los CHECK de la partida rechazan un bucket negativo (savepoint).
 *
 * NOTA: esto valida el SCHEMA y el MODELO de §8.2. La verificación end-to-end del servicio
 * `BudgetLinesService` (lock FOR UPDATE, gate de sobregiro por control_level, no-autoaprobación)
 * es por HTTP y queda PENDIENTE (ADR-044) — declarada, no fingida.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-ledger');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const ROLLBACK = Symbol('rollback');
const disp = (r) => Number(r.vigente_amount) - Number(r.reserved_amount) - Number(r.committed_amount) - Number(r.exercised_amount);

(async () => {
  try {
    // ── 1. Schema ─────────────────────────────────────────────────────────────
    for (const [schema, table] of [['budget', 'budgets'], ['budget', 'budget_lines'], ['budget', 'line_movements']]) {
      const reg = await knex.raw(`SELECT to_regclass('${schema}.${table}') r`);
      ok(!!reg.rows[0].r, `${schema}.${table} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = '${schema}.${table}'::regclass`);
      ok(rls.rows[0]?.relforcerowsecurity === true, `${schema}.${table} con RLS FORZADO`);
    }
    ok(await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'budget_line_id'),
      'budget.expense_obligations.budget_line_id existe (link a partida)');
    const idem = await knex.raw(`SELECT 1 FROM pg_indexes WHERE schemaname='budget' AND indexname='ux_budget_mov_idem'`);
    ok(idem.rows.length === 1, 'índice único de idempotencia ux_budget_mov_idem existe');

    // ── 2. §8.2 sobre una partida (rollback al final) ─────────────────────────
    await knex.transaction(async (trx) => {
      const [bud] = await trx('budget.budgets').insert({
        tenant_id: T, name: 'PU smoke ' + Date.now(), fiscal_year: 2026, created_by: 'tester',
      }).returning('*');
      const [line] = await trx('budget.budget_lines').insert({
        tenant_id: T, budget_id: bud.id, concept: 'Renta', line_type: 'gasto',
        original_amount: 100000, vigente_amount: 100000, control_level: 'bloqueo', created_by: 'tester',
      }).returning('*');
      const reload = () => trx('budget.budget_lines').where({ id: line.id }).first();
      const mov = (type, amount, extra = {}) => trx('budget.line_movements').insert({ tenant_id: T, budget_line_id: line.id, movement_type: type, amount, created_by: 'tester', ...extra });

      await mov('apertura', 100000);
      ok(disp(await reload()) === 100000, '§8.2 Autorización: disponible 100,000');

      // Solicitud reservada 20k
      await trx('budget.budget_lines').where({ id: line.id }).update({ reserved_amount: 20000 });
      await mov('reserva', 20000);
      ok(disp(await reload()) === 80000, '§8.2 Reserva 20k: disponible 80,000');

      // Orden autorizada: reserva → compromiso
      await trx('budget.budget_lines').where({ id: line.id }).update({ reserved_amount: 0, committed_amount: 20000 });
      await mov('compromiso', 20000);
      { const r = await reload(); ok(disp(r) === 80000 && Number(r.reserved_amount) === 0 && Number(r.committed_amount) === 20000, '§8.2 Orden: disponible 80,000 · reserva 0 · compromiso 20,000'); }

      // Reconocimiento parcial: compromiso → ejercido 8k
      await trx('budget.budget_lines').where({ id: line.id }).update({ committed_amount: 12000, exercised_amount: 8000 });
      await mov('ejercido', 8000);
      { const r = await reload(); ok(disp(r) === 80000 && Number(r.committed_amount) === 12000 && Number(r.exercised_amount) === 8000, '§8.2 Reconocimiento parcial: disponible 80,000 · compromiso 12,000 · ejercido 8,000'); }

      // Pago de lo reconocido: paga 8k, NO resta del disponible
      await trx('budget.budget_lines').where({ id: line.id }).update({ paid_amount: 8000 });
      await mov('pago', 8000);
      { const r = await reload(); ok(disp(r) === 80000 && Number(r.paid_amount) === 8000, '§8.2 Pago 8k: disponible 80,000 (pagado NO resta) · pagado 8,000'); }

      // Cancelación del remanente comprometido 12k → libera disponible
      await trx('budget.budget_lines').where({ id: line.id }).update({ committed_amount: 0 });
      await mov('cancelacion', 12000);
      { const r = await reload(); ok(disp(r) === 92000 && Number(r.paid_amount) === 8000, '§8.2 Cancelación remanente: disponible 92,000 · pagado 8,000'); }

      // ── 3. Idempotencia (savepoint: el fallo NO aborta la trx externa) ──────
      await mov('reserva', 1000, { source_kind: 'expense_obligation', source_ref: 'REF-1' });
      let dup = false;
      try {
        await trx.transaction(async (sp) => {
          await sp('budget.line_movements').insert({ tenant_id: T, budget_line_id: line.id, movement_type: 'reserva', amount: 1000, source_kind: 'expense_obligation', source_ref: 'REF-1', created_by: 'tester' });
        });
      } catch (e) { dup = e.code === '23505' || /duplicat|unique/i.test(e.message); }
      ok(dup, 'Idempotencia: (origen,documento,tipo) repetido lo rechaza el índice único');

      // Distinto tipo con el mismo documento SÍ se permite (es otro evento del ledger)
      let otherTypeOk = false;
      try {
        await trx.transaction(async (sp) => {
          await sp('budget.line_movements').insert({ tenant_id: T, budget_line_id: line.id, movement_type: 'compromiso', amount: 1000, source_kind: 'expense_obligation', source_ref: 'REF-1', created_by: 'tester' });
        });
        otherTypeOk = true;
      } catch { otherTypeOk = false; }
      ok(otherTypeOk, 'Idempotencia: mismo documento, distinto tipo (reserva→compromiso) SÍ se permite');

      // ── 4. CHECK de bucket negativo (savepoint) ────────────────────────────
      let negBlocked = false;
      try {
        await trx.transaction(async (sp) => {
          await sp('budget.budget_lines').where({ id: line.id }).update({ reserved_amount: -1 });
        });
      } catch (e) { negBlocked = e.code === '23514' || /check/i.test(e.message); }
      ok(negBlocked, 'CHECK: un bucket negativo (reserved_amount < 0) lo rechaza la DB');

      throw ROLLBACK; // cero efecto real
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\nBudget ledger (PU.1): ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    await knex.destroy();
    process.exit(1);
  }
})();
