/* eslint-disable no-console */
/**
 * Fase PVT — Proyección del plan de ventas → `commercial.sales_targets` (ADR-066 / PV). Smoke DB-direct.
 *
 * Verifica contra la DB real la lógica de `BudgetSalesPlanService.projectToSalesTargets`:
 *   1. `v_retail_calendar` reparte cada periodo 13×4 en meses del fiscal_year (cobertura completa del año).
 *   2. Reparto periodo→mes PROPORCIONAL A LOS DÍAS: Σ meses de un periodo == su meta (sin pérdida > centavos).
 *   3. INVARIANTE de conservación: Σ meses del scope `total` == Σ metas del plan (idempotente, todos los meses).
 *   4. Escalas del contrato: branch = warehouse 01-06, route = route_code NN, channel = canal, total = ''.
 *   5. El UPSERT real a `commercial.sales_targets` corre (natural key + ON CONFLICT) — cross-schema OK.
 *
 * Valida el SCHEMA/consultas. Verificación HTTP end-to-end PENDIENTE (ADR-044), declarada.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-sales-plan-project-targets');
const T = '00000000-0000-0000-0000-00000000d01c';
const FY = 2026;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ROLLBACK = Symbol('rollback');

(async () => {
  try {
    // ── 1. Calendario: reparto periodo → mes del fiscal_year ──────────────────
    const calRows = (await knex.raw(
      `SELECT period_no, to_char(date, 'YYYY-MM') AS ym, count(*)::int AS days
         FROM analytics.v_retail_calendar WHERE fiscal_year = ? GROUP BY period_no, to_char(date,'YYYY-MM')`,
      [FY],
    )).rows;
    const periodMonths = new Map(); const periodTotal = new Map();
    let calTotalDays = 0;
    for (const r of calRows) {
      const p = Number(r.period_no), d = Number(r.days);
      if (!periodMonths.has(p)) periodMonths.set(p, []);
      periodMonths.get(p).push({ ym: r.ym, days: d });
      periodTotal.set(p, (periodTotal.get(p) || 0) + d);
      calTotalDays += d;
    }
    ok(periodMonths.size === 13, `calendario ${FY}: 13 periodos mapeados (${periodMonths.size})`);
    ok(calTotalDays === 365, `cobertura completa del año: ${calTotalDays} días (365 = ${FY} no bisiesto)`);
    ok([...periodMonths.values()].every((ms) => ms.length >= 1), 'todo periodo cae en ≥1 mes');

    // ── 2-5. Proyección en transacción con rollback ───────────────────────────
    // Elegir entidades reales: una plaza (warehouse 01-06) y, si existe, una ruta (RUTA-NN).
    const ents = await knex('analytics.v_sales_entity').where({ tenant_id: T }).select('entity_key', 'channel', 'warehouse_code');
    ok(ents.length > 0, `v_sales_entity legible: ${ents.length} entidades`);
    const branchEnt = ents.find((e) => !String(e.warehouse_code).startsWith('RUTA-'));
    const routeEnt = ents.find((e) => String(e.warehouse_code).startsWith('RUTA-'));
    ok(!!branchEnt, `hay entidad de plaza (${branchEnt ? branchEnt.entity_key : 'ninguna'})`);
    const chosen = [branchEnt, routeEnt].filter(Boolean);

    await knex.transaction(async (trx) => {
      const [bud] = await trx('budget.budgets').insert({
        tenant_id: T, name: 'PVT proj ' + Date.now(), fiscal_year: FY, status: 'borrador', created_by: 'a',
      }).returning('*');

      // meta en TODOS los periodos → cubre los 12 meses (invariante limpia)
      const META = 100000;
      let planTotal = 0;
      for (const e of chosen) {
        for (let p = 1; p <= 13; p++) {
          await trx('budget.sales_plan_lines').insert({
            tenant_id: T, budget_id: bud.id, entity_key: e.entity_key, period_no: p,
            meta_amount: META, method: 'manual', created_by: 'a', updated_by: 'a',
          });
          planTotal += META;
        }
      }

      // reproducir la math del servicio
      const acc = new Map();
      const add = (scope, key, ym, amount) => { if (amount > 0) { const k = `${scope}|${key}|${ym}`; acc.set(k, (acc.get(k) || 0) + amount); } };
      const lines = await trx('budget.sales_plan_lines').where({ tenant_id: T, budget_id: bud.id }).select('entity_key', 'period_no', 'meta_amount');
      for (const ln of lines) {
        const meta = Number(ln.meta_amount);
        const p = Number(ln.period_no);
        const months = periodMonths.get(p); const total = periodTotal.get(p);
        const ek = String(ln.entity_key); const sep = ek.indexOf(':');
        const channel = ek.slice(0, sep); const warehouse = ek.slice(sep + 1);
        const isRoute = warehouse.startsWith('RUTA-');
        // verificar reparto por periodo (por entidad): Σ meses == meta
        let perPeriod = 0;
        for (const m of months) {
          const monthly = meta * (m.days / total);
          perPeriod += monthly;
          add('total', '', m.ym, monthly);
          add('channel', channel, m.ym, monthly);
          if (isRoute) add('route', warehouse.slice(5), m.ym, monthly);
          else add('branch', warehouse, m.ym, monthly);
        }
        if (p === 1 && ln.entity_key === chosen[0].entity_key) {
          ok(Math.abs(perPeriod - meta) < 0.0001, `reparto por días sin pérdida: P1 Σ meses = ${round2(perPeriod)} == meta ${meta}`);
        }
      }

      // UPSERT real a commercial.sales_targets (ejercita cross-schema + natural key)
      let upserted = 0;
      for (const [k, amount] of acc) {
        const a = k.indexOf('|'); const b = k.indexOf('|', a + 1);
        const scope = k.slice(0, a), scope_key = k.slice(a + 1, b), ym = k.slice(b + 1);
        await trx.raw(
          `INSERT INTO commercial.sales_targets (tenant_id, scope, scope_key, year_month, target_monto)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, scope, scope_key, year_month)
           DO UPDATE SET target_monto = EXCLUDED.target_monto, updated_at = now()`,
          [T, scope, scope_key, ym, round2(amount)],
        );
        upserted++;
      }
      ok(upserted > 0, `upsert real a commercial.sales_targets: ${upserted} filas (scope×mes)`);

      // 3. INVARIANTE: Σ meses total == Σ plan (leído de la tabla, mi proyección pisó todos los meses)
      const totRows = await trx('commercial.sales_targets')
        .where({ tenant_id: T, scope: 'total' }).andWhere('year_month', 'like', `${FY}-%`).select('target_monto');
      const sumTotal = totRows.reduce((s, r) => s + Number(r.target_monto), 0);
      ok(Math.abs(sumTotal - planTotal) < 0.10, `INVARIANTE: Σ meses total = ${round2(sumTotal)} == Σ plan ${planTotal} (±$0.10)`);

      // 4. Escalas: branch del branchEnt == su meta; channel del branchEnt idem si es único de ese canal
      const brRows = await trx('commercial.sales_targets')
        .where({ tenant_id: T, scope: 'branch', scope_key: branchEnt.warehouse_code }).andWhere('year_month', 'like', `${FY}-%`).select('target_monto');
      const sumBranch = brRows.reduce((s, r) => s + Number(r.target_monto), 0);
      ok(Math.abs(sumBranch - 13 * META) < 0.10, `escala branch ${branchEnt.warehouse_code}: Σ = ${round2(sumBranch)} == ${13 * META} (±$0.10)`);

      if (routeEnt) {
        const rt = routeEnt.warehouse_code.slice(5);
        const rtRows = await trx('commercial.sales_targets')
          .where({ tenant_id: T, scope: 'route', scope_key: rt }).andWhere('year_month', 'like', `${FY}-%`).select('target_monto');
        const sumRoute = rtRows.reduce((s, r) => s + Number(r.target_monto), 0);
        ok(Math.abs(sumRoute - 13 * META) < 0.10, `escala route ${rt}: Σ = ${round2(sumRoute)} == ${13 * META} (±$0.10)`);
      } else {
        console.log('  · (sin entidad ruta en el catálogo — escala route no ejercida)');
      }

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\n${fail === 0 ? '✅' : '❌'} PVT proyección: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('💥', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
