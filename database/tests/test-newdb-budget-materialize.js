/* eslint-disable no-console */
/**
 * Fase PR.1 — Materialización plan → ledger de 5 estados (ADR-074). Smoke DB-direct.
 *
 * Reproduce el algoritmo de `BudgetMaterializeService.materialize` contra el schema real (inserts
 * reales en budget_lines/line_movements con source/source_ref + índices únicos), en rollback:
 *   1. Fresh: agrega planes ventas+gastos → partidas source='plan' con source_ref; Σ plan == Σ partidas.
 *   2. Idempotente: re-materializar sin cambios NO duplica (índice ux_budget_lines_plan_ref) → 0 nuevas.
 *   3. Cambio de plan SIN consumo → update directo de original+vigente.
 *   4. Partida CON consumo → ajuste de vigente por movimiento (ampliacion/reduccion), consumo preservado,
 *      y clamp: no baja de lo comprometido/ejercido.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-materialize');
const T = '00000000-0000-0000-0000-00000000d01c';
const FY = 2032;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ROLLBACK = Symbol('rollback');

/** Núcleo de la materialización (espejo del servicio) sobre una trx. */
async function materialize(trx, budgetId, username = 'a') {
  const desired = new Map();
  const expRows = await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: budgetId }).select('account_code', 'account_name', 'sucursal', 'monto');
  const gmap = new Map();
  for (const r of expRows) { const k = `${r.account_code}|${r.sucursal || ''}`; if (!gmap.has(k)) gmap.set(k, { name: r.account_name, sucursal: r.sucursal || '', monto: 0, months: 0 }); const g = gmap.get(k); g.monto = round2(g.monto + Number(r.monto || 0)); if (Number(r.monto) > 0) g.months++; }
  for (const [k, g] of gmap) { const acc = k.slice(0, k.indexOf('|')); desired.set(`gasto:${acc}:${g.sucursal}`, { source_ref: `gasto:${acc}:${g.sucursal}`, concept: g.name || acc, line_type: 'gasto', account_code: acc, cost_center: g.sucursal || null, original: g.monto, control_level: 'advertencia', recurrence: g.months >= 6 ? 'recurrente' : 'no_recurrente' }); }
  const salRows = await trx('budget.sales_plan_lines').where({ tenant_id: T, budget_id: budgetId }).select('entity_key', 'meta_amount');
  const smap = new Map();
  for (const r of salRows) smap.set(r.entity_key, round2((smap.get(r.entity_key) || 0) + Number(r.meta_amount || 0)));
  for (const [ek, sum] of smap) { const s = ek.indexOf(':'); const ch = s >= 0 ? ek.slice(0, s) : ek; const wh = s >= 0 ? ek.slice(s + 1) : ''; desired.set(`ingreso:${ek}`, { source_ref: `ingreso:${ek}`, concept: `Ventas ${ch}${wh ? ' · ' + wh : ''}`, line_type: 'ingreso', account_code: null, cost_center: ek, original: sum, control_level: 'informativo', recurrence: null }); }

  const sum = { created: 0, updated: 0, adjusted: 0, closed: 0, skipped: 0 };
  const seen = new Set();
  for (const [sref, d] of desired) {
    seen.add(sref);
    const ex = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: budgetId, source_ref: sref }).first();
    if (!ex) {
      if (!(d.original > 0)) { sum.skipped++; continue; }
      const [line] = await trx('budget.budget_lines').insert({ tenant_id: T, budget_id: budgetId, concept: d.concept, line_type: d.line_type, cost_center: d.cost_center, account_code: d.account_code, original_amount: d.original, vigente_amount: d.original, control_level: d.control_level, recurrence: d.recurrence, source: 'plan', source_ref: sref, created_by: username, updated_by: username }).returning('*');
      await trx('budget.line_movements').insert({ tenant_id: T, budget_line_id: line.id, movement_type: 'apertura', amount: d.original, source_kind: 'materializacion', source_ref: sref, note: 'mat', created_by: username });
      sum.created++; continue;
    }
    const consumed = round2(Number(ex.reserved_amount) + Number(ex.committed_amount) + Number(ex.exercised_amount) + Number(ex.paid_amount)) > 0;
    if (!consumed) {
      if (round2(ex.original_amount) === d.original && round2(ex.vigente_amount) === d.original && ex.concept === d.concept && ex.control_level === d.control_level) { sum.skipped++; continue; }
      await trx('budget.budget_lines').where({ tenant_id: T, id: ex.id }).update({ concept: d.concept, original_amount: d.original, vigente_amount: d.original, control_level: d.control_level, status: 'activa', updated_by: username });
      sum.updated++; continue;
    }
    // consumo → ajustar vigente
    const cur = Number(ex.vigente_amount);
    const cons = round2(Number(ex.reserved_amount) + Number(ex.committed_amount) + Number(ex.exercised_amount));
    let tgt = d.original; if (tgt < cons) tgt = cons;
    const delta = round2(tgt - cur);
    if (Math.abs(delta) < 0.01) { sum.skipped++; continue; }
    try {
      await trx('budget.line_movements').insert({ tenant_id: T, budget_line_id: ex.id, movement_type: delta > 0 ? 'ampliacion' : 'reduccion', amount: Math.abs(delta), source_kind: 'materializacion', source_ref: `mat:${sref}:v${tgt}`, note: 'ajuste', created_by: username });
    } catch (e) { if (e.code === '23505') { sum.skipped++; continue; } throw e; }
    await trx('budget.budget_lines').where({ tenant_id: T, id: ex.id }).update({ vigente_amount: round2(cur + delta), updated_by: username });
    sum.adjusted++;
  }
  const orphans = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: budgetId, source: 'plan' }).whereNotNull('source_ref').whereNotIn('source_ref', [...seen]);
  for (const o of orphans) { const c = round2(Number(o.reserved_amount) + Number(o.committed_amount) + Number(o.exercised_amount) + Number(o.paid_amount)) > 0; if (!c && o.status !== 'cerrada') { await trx('budget.budget_lines').where({ tenant_id: T, id: o.id }).update({ status: 'cerrada', vigente_amount: 0 }); sum.closed++; } else sum.skipped++; }
  return sum;
}

(async () => {
  try {
    await knex.transaction(async (trx) => {
      const [bud] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PR mat ' + Date.now(), fiscal_year: FY, status: 'borrador', created_by: 'a' }).returning('*');
      // planes: gastos 610 (12×100k) + 620 (12×50k) · ventas mostrador:01 (13×40k) + credito:02 (13×30k)
      for (let m = 1; m <= 12; m++) { const mm = String(m).padStart(2, '0'); await trx('budget.expense_plan_lines').insert({ tenant_id: T, budget_id: bud.id, account_code: '610', account_name: 'Nómina', sucursal: '', year_month: `${FY}-${mm}`, monto: 100000, method: 'historico_ajustado', created_by: 'a', updated_by: 'a' }); await trx('budget.expense_plan_lines').insert({ tenant_id: T, budget_id: bud.id, account_code: '620', account_name: 'Renta', sucursal: '', year_month: `${FY}-${mm}`, monto: 50000, method: 'historico_ajustado', created_by: 'a', updated_by: 'a' }); }
      for (let p = 1; p <= 13; p++) { await trx('budget.sales_plan_lines').insert({ tenant_id: T, budget_id: bud.id, entity_key: 'mostrador:01', period_no: p, meta_amount: 40000, method: 'manual', created_by: 'a', updated_by: 'a' }); await trx('budget.sales_plan_lines').insert({ tenant_id: T, budget_id: bud.id, entity_key: 'credito:02', period_no: p, meta_amount: 30000, method: 'manual', created_by: 'a', updated_by: 'a' }); }

      // 1. Fresh
      const s1 = await materialize(trx, bud.id);
      ok(s1.created === 4, `fresh: 4 partidas creadas (${s1.created})`);
      const lines = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: bud.id });
      const gasto = lines.filter((l) => l.line_type === 'gasto'); const ing = lines.filter((l) => l.line_type === 'ingreso');
      ok(round2(gasto.reduce((a, l) => a + Number(l.original_amount), 0)) === 1800000, `Σ gasto partidas = ${round2(gasto.reduce((a, l) => a + Number(l.original_amount), 0))} == 1,800,000 (610:1.2M + 620:600k)`);
      ok(round2(ing.reduce((a, l) => a + Number(l.original_amount), 0)) === 910000, `Σ ingreso partidas = ${round2(ing.reduce((a, l) => a + Number(l.original_amount), 0))} == 910,000 (mostrador:520k + credito:390k)`);
      ok(lines.every((l) => l.source === 'plan' && l.source_ref), 'todas las partidas source=plan con source_ref');
      const n610 = gasto.find((l) => l.account_code === '610');
      ok(n610 && n610.recurrence === 'recurrente', `610 (12 meses) → recurrence recurrente (${n610 && n610.recurrence})`);
      const apert = await trx('budget.line_movements').where({ tenant_id: T, source_kind: 'materializacion', movement_type: 'apertura' }).count('* as c').first();
      ok(Number(apert.c) === 4, `4 movimientos de apertura de materialización (${apert.c})`);

      // 2. Idempotente
      const s2 = await materialize(trx, bud.id);
      ok(s2.created === 0 && s2.updated === 0 && s2.skipped === 4, `idempotente: 0 creadas / 0 update / 4 skipped (${JSON.stringify(s2)})`);
      const cnt = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: bud.id }).count('* as c').first();
      ok(Number(cnt.c) === 4, `sin duplicados: sigue en 4 partidas (${cnt.c})`);

      // 3. Cambio de plan SIN consumo → update
      await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id, account_code: '620', year_month: `${FY}-01` }).update({ monto: 80000 });
      const s3 = await materialize(trx, bud.id);
      ok(s3.updated === 1 && s3.created === 0, `cambio sin consumo: 1 update (${JSON.stringify(s3)})`);
      const l620 = await trx('budget.budget_lines').where({ tenant_id: T, budget_id: bud.id, source_ref: 'gasto:620:' }).first();
      ok(round2(l620.original_amount) === 630000 && round2(l620.vigente_amount) === 630000, `620 actualizado a ${round2(l620.original_amount)} (600k − 50k + 80k = 630k)`);

      // 4. Partida CON consumo → ajuste por movimiento + clamp
      // aprobar + simular consumo: comprometer 900k sobre 610 (vigente 1.2M)
      await trx('budget.budget_lines').where({ tenant_id: T, id: n610.id }).update({ committed_amount: 900000 });
      // bajar el plan de 610 a 700k (< comprometido 900k) → debe CLAMPear a 900k, no menos
      await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id, account_code: '610' }).update({ monto: 700000 / 12 });
      const s4 = await materialize(trx, bud.id);
      ok(s4.adjusted === 1, `con consumo: 1 ajuste por movimiento (${JSON.stringify(s4)})`);
      const l610b = await trx('budget.budget_lines').where({ tenant_id: T, id: n610.id }).first();
      ok(round2(l610b.vigente_amount) === 900000, `clamp: vigente bajó a 900,000 (= comprometido), NO a 700,000 (${round2(l610b.vigente_amount)})`);
      ok(round2(l610b.committed_amount) === 900000, `consumo preservado: comprometido sigue 900,000 (${round2(l610b.committed_amount)})`);
      const redu = await trx('budget.line_movements').where({ tenant_id: T, budget_line_id: n610.id, movement_type: 'reduccion' }).count('* as c').first();
      ok(Number(redu.c) === 1, `el ajuste dejó un movimiento reduccion rastreado (${redu.c})`);

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\n${fail === 0 ? '✅' : '❌'} PR.1 materialización: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy(); process.exit(fail === 0 ? 0 : 1);
  } catch (e) { console.error('💥', e.message); await knex.destroy(); process.exit(1); }
})();
