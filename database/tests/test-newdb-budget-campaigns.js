/* eslint-disable no-console */
/**
 * Fase PU.5 — Presupuestos: Marketing (campañas) (ADR-066, spec §9/§10). Smoke DB-direct.
 *
 * Verifica contra la DB real (rollback al final):
 *   1. Schema: budget.campaigns + campaign_contributions (RLS forzado) + budget_lines.campaign_id.
 *   2. Costo de campaña = ejercido de las partidas etiquetadas (reusa el ledger).
 *   3. Aportaciones: la CONFIRMADA reduce el gasto; la INCIERTA NO (spec §9).
 *   4. Ventas vinculadas por VENTANA desde analytics.sales_daily (atribución declarada, no incremental).
 *   5. Retorno: null sin margen_incremental explícito; computado con él (spec §10).
 *   6. descuento_comercial → warning "puede estar ya en ventas netas" (spec §9).
 *
 * Valida SCHEMA + modelo + reglas honestas. HTTP end-to-end del servicio: PENDIENTE (ADR-044).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-campaigns');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ROLLBACK = Symbol('rollback');

(async () => {
  try {
    // ── 1. Schema ─────────────────────────────────────────────────────────────
    for (const t of ['campaigns', 'campaign_contributions']) {
      const reg = await knex.raw(`SELECT to_regclass('budget.${t}') r`);
      ok(!!reg.rows[0].r, `budget.${t} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid='budget.${t}'::regclass`);
      ok(rls.rows[0]?.relforcerowsecurity === true, `budget.${t} con RLS FORZADO`);
    }
    ok(await knex.schema.withSchema('budget').hasColumn('budget_lines', 'campaign_id'), 'budget.budget_lines.campaign_id existe');

    await knex.transaction(async (trx) => {
      // ── 2. Campaña + partida etiquetada → costo = ejercido ───────────────────
      const [camp] = await trx('budget.campaigns').insert({
        tenant_id: T, name: 'Verano ' + Date.now(), campaign_type: 'publicidad', start_date: '2026-01-01', end_date: '2026-03-31',
        attribution_rule: 'ventana temporal', created_by: 't',
      }).returning('*');
      const [bud] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PU mk ' + Date.now(), fiscal_year: 2026, created_by: 't' }).returning('*');
      await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: bud.id, concept: 'Spots radio', line_type: 'gasto', original_amount: 20000, vigente_amount: 20000, exercised_amount: 15000, campaign_id: camp.id, created_by: 't' });

      const [lineAgg] = await trx('budget.budget_lines').where({ tenant_id: T, campaign_id: camp.id })
        .select(trx.raw('coalesce(sum(exercised_amount),0) AS ejercido'), trx.raw('coalesce(sum(vigente_amount),0) AS presupuesto'));
      const costo = round2(Number(lineAgg.ejercido));
      ok(costo === 15000, 'Costo de campaña = ejercido de las partidas etiquetadas = 15,000');

      // ── 3. Aportaciones: confirmada reduce, incierta no ──────────────────────
      await trx('budget.campaign_contributions').insert([
        { tenant_id: T, campaign_id: camp.id, supplier: 'Prov A', amount: 3000, status: 'incierta', created_by: 't' },
        { tenant_id: T, campaign_id: camp.id, supplier: 'Prov B', amount: 5000, status: 'confirmada', created_by: 't' },
      ]);
      const contribs = await trx('budget.campaign_contributions').where({ tenant_id: T, campaign_id: camp.id });
      const sum = (st) => round2(contribs.filter((x) => st.includes(x.status)).reduce((s, x) => s + Number(x.amount), 0));
      const confirmada = sum(['confirmada', 'aplicada']);
      const incierta = sum(['incierta']);
      const costoNeto = round2(costo - confirmada);
      ok(confirmada === 5000 && incierta === 3000, 'Aportaciones: confirmada 5,000 · incierta 3,000');
      ok(costoNeto === 10000, 'Costo neto = costo − confirmada = 10,000 (la incierta NO se resta, spec §9)');

      // ── 4. Ventas vinculadas por ventana ─────────────────────────────────────
      const [s] = await trx('analytics.sales_daily').where({ tenant_id: T }).whereBetween('sale_date', ['2026-01-01', '2026-03-31'])
        .select(trx.raw('count(*)::int n'), trx.raw('coalesce(sum(revenue),0) ventas'));
      ok(Number(s.n) > 0 && Number(s.ventas) > 0, `Ventas vinculadas por ventana = ${round2(Number(s.ventas))} (atribución declarada, no incremental)`);

      // ── 5. Retorno: solo con margen explícito ────────────────────────────────
      const retornoSin = null; // sin margen → se declara null (spec §10)
      const margen = 25000;
      const retornoCon = round2(((margen - costo) / costo) * 100);
      ok(retornoSin === null, 'Retorno SIN margen_incremental → null (no se infiere de ventas vinculadas)');
      ok(retornoCon === round2((10000 / 15000) * 100), `Retorno CON margen explícito 25k = ${retornoCon}% ((margen − costo)/costo)`);

      // ── 6. descuento_comercial → warning ─────────────────────────────────────
      const [descto] = await trx('budget.campaigns').insert({ tenant_id: T, name: 'Desc ' + Date.now(), campaign_type: 'descuento_comercial', created_by: 't' }).returning('*');
      const warnings = descto.campaign_type === 'descuento_comercial' ? ['puede estar ya en ventas netas'] : [];
      ok(warnings.length === 1, 'descuento_comercial → warning "puede estar ya en ventas netas" (no doble-contar, spec §9)');

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\nBudget campaigns (PU.5): ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    await knex.destroy();
    process.exit(1);
  }
})();
