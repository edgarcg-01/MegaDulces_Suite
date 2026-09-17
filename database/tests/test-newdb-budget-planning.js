/* eslint-disable no-console */
/**
 * Fase PU.4 — Presupuestos: planeación avanzada (ADR-066). Smoke DB-direct.
 *
 * Verifica contra la DB real (rollback al final):
 *   1. Schema: budget.budgets.scenario + copied_from_id (mig 20260917150000).
 *   2. Copiar ejercicio NO arrastra autorizaciones (spec §5.2): la copia nace 'borrador', con
 *      copied_from_id, vigente = ORIGINAL (no el vigente ajustado) y buckets en cero.
 *   3. Import idempotente por clave natural (spec §14 #2): reimportar la misma fila NO duplica.
 *   4. Proyección de cierre (spec §14 #19): firme = ejercido+comprometido, plena = vigente; computada.
 *
 * Valida SCHEMA + modelo. HTTP end-to-end del servicio: PENDIENTE (ADR-044).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-planning');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const ROLLBACK = Symbol('rollback');
const keyOf = (r) => [String(r.concept ?? '').trim().toLowerCase(), r.area ?? '', r.line_type ?? 'gasto', r.period_month ? String(r.period_month).slice(0, 10) : ''].join('|');

(async () => {
  try {
    // ── 1. Schema ─────────────────────────────────────────────────────────────
    ok(await knex.schema.withSchema('budget').hasColumn('budgets', 'scenario'), 'budget.budgets.scenario existe');
    ok(await knex.schema.withSchema('budget').hasColumn('budgets', 'copied_from_id'), 'budget.budgets.copied_from_id existe');

    await knex.transaction(async (trx) => {
      // Fuente: aprobado, con una partida AJUSTADA (vigente 90k ≠ original 100k) y EJERCIDA (20k)
      const [src] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PU plan ' + Date.now(), fiscal_year: 2026, status: 'aprobado', scenario: 'base', created_by: 'a', authorized_by: 'b', authorized_at: trx.fn.now() }).returning('*');
      await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: src.id, concept: 'Renta', line_type: 'gasto', area: 'CEDIS', original_amount: 100000, vigente_amount: 90000, committed_amount: 30000, exercised_amount: 20000, control_level: 'bloqueo', created_by: 'a' });

      // ── 2. Copiar (mirror del servicio) ──────────────────────────────────────
      const [{ maxv }] = await trx('budget.budgets').where({ tenant_id: T, name: src.name, fiscal_year: 2026 }).max({ maxv: 'version' });
      const [copy] = await trx('budget.budgets').insert({ tenant_id: T, name: src.name, fiscal_year: 2026, scenario: 'conservador', version: Number(maxv) + 1, status: 'borrador', copied_from_id: src.id, created_by: 'a' }).returning('*');
      const srcLines = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: src.id });
      for (const l of srcLines) {
        await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: copy.id, concept: l.concept, line_type: l.line_type, area: l.area, original_amount: l.original_amount, vigente_amount: l.original_amount, control_level: l.control_level, created_by: 'a' });
      }
      const cl = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: copy.id }).first();
      ok(copy.status === 'borrador' && copy.copied_from_id === src.id, 'Copia: nace borrador + copied_from_id apunta al origen');
      ok(Number(cl.vigente_amount) === 100000, 'Copia: vigente = ORIGINAL 100,000 (no arrastra el vigente ajustado 90,000)');
      ok(Number(cl.committed_amount) === 0 && Number(cl.exercised_amount) === 0 && Number(cl.reserved_amount) === 0, 'Copia: buckets en cero (no arrastra ejecución 20k/compromiso 30k)');
      ok(copy.scenario === 'conservador', 'Copia: escenario nuevo (conservador) distinto del origen (base)');

      // ── 3. Import idempotente por clave natural ──────────────────────────────
      const [draft] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PU imp ' + Date.now(), fiscal_year: 2026, status: 'borrador', created_by: 'a' }).returning('*');
      const rows = [
        { concept: 'Luz', line_type: 'gasto', area: 'CEDIS', original_amount: 5000 },
        { concept: 'Sueldos', line_type: 'gasto', area: 'CEDIS', original_amount: 80000 },
      ];
      const apply = async () => {
        const existing = new Map((await trx('budget.budget_lines').where({ tenant_id: T, budget_id: draft.id })).map((l) => [keyOf(l), l]));
        let created = 0, updated = 0;
        for (const r of rows) {
          const k = keyOf(r);
          if (existing.has(k)) { await trx('budget.budget_lines').where({ tenant_id: T, id: existing.get(k).id }).update({ original_amount: r.original_amount, vigente_amount: r.original_amount }); updated++; }
          else { const [nl] = await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: draft.id, concept: r.concept, line_type: r.line_type, area: r.area, original_amount: r.original_amount, vigente_amount: r.original_amount, created_by: 'a' }).returning('id'); existing.set(k, { id: nl.id }); created++; }
        }
        return { created, updated };
      };
      const r1 = await apply();
      const r2 = await apply();
      const cnt = Number((await trx('budget.budget_lines').where({ tenant_id: T, budget_id: draft.id }).count())[0].count);
      ok(r1.created === 2 && r1.updated === 0, 'Import 1a vez: crea 2 partidas');
      ok(r2.created === 0 && r2.updated === 2, 'Import 2a vez (misma data): 0 creadas, 2 actualizadas (idempotente)');
      ok(cnt === 2, 'Import idempotente: NO duplica — siguen siendo 2 partidas');

      // ── 4. Proyección de cierre (computada) ──────────────────────────────────
      const [agg] = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: src.id }).sum({ vigente: 'vigente_amount', committed: 'committed_amount', exercised: 'exercised_amount' });
      const firme = Number(agg.exercised) + Number(agg.committed);
      const plena = Number(agg.vigente);
      ok(firme === 50000, 'Proyección FIRME = ejercido(20k) + comprometido(30k) = 50,000');
      ok(plena === 90000, 'Proyección PLENA = vigente = 90,000 (no altera lo autorizado)');
      const srcLineAfter = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: src.id }).first();
      ok(Number(srcLineAfter.vigente_amount) === 90000, 'Proyección es de solo lectura: el vigente del origen no cambió');

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\nBudget planning (PU.4): ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    await knex.destroy();
    process.exit(1);
  }
})();
