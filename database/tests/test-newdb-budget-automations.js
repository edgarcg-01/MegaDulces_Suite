/* eslint-disable no-console */
/**
 * Fase PR.2/PR.3/PR.4 — automatizaciones de Presupuestos (ADR-074). Smoke DB-direct.
 *
 * PR.2 Capacidad auto-propuesta desde el flujo (cobranza CXC repartida en días hábiles).
 * PR.3 Obligaciones recurrentes auto-generadas (propuesta) del plan de gastos + autorización HITL.
 * PR.4 Resultado presupuestado = plan ventas (ingresos) − plan gastos (egresos), mes y anual.
 * Reproduce el núcleo de cada servicio contra el schema real, en rollback.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-budget-automations');
const T = '00000000-0000-0000-0000-00000000d01c';
const FY = 2033;
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const ROLLBACK = Symbol('rollback');
const iso = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const monday = (d) => { const x = new Date(d + 'T00:00:00Z'); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x.toISOString().slice(0, 10); };
const inferSubtype = (n) => { n = (n || '').toLowerCase(); if (/renta|arrend/.test(n)) return 'renta'; if (/luz|energ|cfe/.test(n)) return 'luz'; if (/sueld|n[oó]min|salari/.test(n)) return 'sueldos'; if (/comis/.test(n)) return 'comisiones'; return 'operativo'; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

(async () => {
  try {
    await knex.transaction(async (trx) => {
      // ═══ PR.2 — Capacidad propuesta desde CXC ═══
      const from = '2026-06-01', to = '2026-06-26'; // ventana; conservación por semanas presentes
      const cobros = await trx.raw(`SELECT date_trunc('week', vencimiento)::date bucket, coalesce(sum(saldo_documento),0) monto FROM analytics.customer_receivables WHERE tenant_id=? AND saldo_documento>0 AND vencimiento BETWEEN ? AND ? GROUP BY 1`, [T, from, to]);
      const cobMap = new Map(cobros.rows.map((r) => [iso(r.bucket), Number(r.monto)]));
      const bizByWeek = new Map();
      let cur = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
      while (cur <= end) { const dow = cur.getUTCDay(); if (dow >= 1 && dow <= 5) { const d = cur.toISOString().slice(0, 10); const wk = monday(d); if (!bizByWeek.has(wk)) bizByWeek.set(wk, []); bizByWeek.get(wk).push(d); } cur = new Date(cur); cur.setUTCDate(cur.getUTCDate() + 1); }
      const items = [];
      for (const [wk, days] of bizByWeek) { const cw = round2(cobMap.get(wk) ?? 0); const per = days.length ? round2(cw / days.length) : 0; for (const d of days) items.push({ date: d, amount: per, week: wk, cobros_week: cw }); }
      ok(items.length > 0, `PR.2 propuesta: ${items.length} días hábiles en la ventana`);
      // equal-per-week
      const byWk = new Map(); for (const it of items) { if (!byWk.has(it.week)) byWk.set(it.week, new Set()); byWk.get(it.week).add(it.amount); }
      ok([...byWk.values()].every((s) => s.size === 1), 'PR.2 monto igual para todos los días hábiles de una misma semana');
      // conservación: Σ items == Σ cobros_week de las semanas presentes
      const sumItems = round2(items.reduce((s, i) => s + i.amount, 0));
      const sumWeeks = round2([...bizByWeek.keys()].reduce((s, wk) => s + (cobMap.get(wk) ?? 0), 0));
      ok(Math.abs(sumItems - sumWeeks) < items.length * 0.01, `PR.2 conservación: Σ items ${sumItems} ≈ Σ cobros semanas ${sumWeeks}`);
      // confirmProposed → escribe daily_capacity + history
      const pick = items.slice(0, 3);
      for (const it of pick) {
        const prev = await trx('budget.daily_capacity').where({ tenant_id: T, capacity_date: it.date }).first();
        await trx('budget.daily_capacity').insert({ tenant_id: T, capacity_date: it.date, authorized_amount: it.amount, note: 'cap flujo', created_by: 'a', updated_by: 'a' }).onConflict(['tenant_id', 'capacity_date']).merge({ authorized_amount: it.amount, updated_by: 'a' });
        await trx('budget.daily_capacity_history').insert({ tenant_id: T, capacity_date: it.date, previous_amount: prev?.authorized_amount ?? null, new_amount: it.amount, reason: 'cap flujo', changed_by: 'a' });
      }
      const capRows = await trx('budget.daily_capacity').where({ tenant_id: T }).whereIn('capacity_date', pick.map((p) => p.date)).count('* as c').first();
      ok(Number(capRows.c) === 3, `PR.2 confirmProposed: 3 capacidades diarias escritas (${capRows.c})`);

      // ═══ PR.3 — Obligaciones recurrentes del plan ═══
      const [bud] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PR autom ' + Date.now(), fiscal_year: FY, status: 'aprobado', created_by: 'a', authorized_by: 'b', authorized_at: trx.fn.now() }).returning('*');
      for (let m = 1; m <= 12; m++) { const mm = String(m).padStart(2, '0'); await trx('budget.expense_plan_lines').insert({ tenant_id: T, budget_id: bud.id, account_code: '610', account_name: 'Nómina', sucursal: '', year_month: `${FY}-${mm}`, monto: 100000, method: 'historico_ajustado', created_by: 'a', updated_by: 'a' }); }
      for (const mm of ['01', '06', '12']) await trx('budget.expense_plan_lines').insert({ tenant_id: T, budget_id: bud.id, account_code: '650', account_name: 'Mantenimiento', sucursal: '', year_month: `${FY}-${mm}`, monto: 30000, method: 'historico_ajustado', created_by: 'a', updated_by: 'a' });

      // reproducir generateFromPlan
      async function generate() {
        const rows = await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id }).select('account_code', 'account_name', 'sucursal', 'year_month', 'monto');
        const groups = new Map();
        for (const r of rows) { if (!(Number(r.monto) > 0)) continue; const k = `${r.account_code}|${r.sucursal || ''}`; if (!groups.has(k)) groups.set(k, { name: r.account_name, sucursal: r.sucursal || '', months: [] }); groups.get(k).months.push({ ym: r.year_month, monto: Number(r.monto) }); }
        const s = { generated: 0, updated: 0, skipped: 0, recurrent: 0, sporadic: 0 };
        for (const [k, g] of groups) {
          if (g.months.length < 6) { s.sporadic++; continue; }
          s.recurrent++; const acc = k.slice(0, k.indexOf('|')); const subtype = inferSubtype(g.name);
          for (const mo of g.months) {
            const sref = `plan:${bud.id}:${acc}:${g.sucursal}:${mo.ym}`;
            const ex = await trx('budget.expense_obligations').where({ tenant_id: T, source_ref: sref }).first();
            if (ex) { if (ex.status === 'propuesta' && Math.abs(Number(ex.original_amount) - mo.monto) >= 0.01) { await trx('budget.expense_obligations').where({ tenant_id: T, id: ex.id }).update({ original_amount: mo.monto }); s.updated++; } else s.skipped++; continue; }
            await trx('budget.expense_obligations').insert({ tenant_id: T, concept: `${g.name} ${mo.ym}`, beneficiary: g.name, area: g.sucursal || null, subtype, original_amount: mo.monto, original_due_date: lastDay(mo.ym), status: 'propuesta', authorized_by: null, source: 'plan', source_ref: sref, created_by: 'a' });
            s.generated++;
          }
        }
        return s;
      }
      const g1 = await generate();
      ok(g1.generated === 12 && g1.recurrent === 1 && g1.sporadic === 1, `PR.3 genera 12 obligaciones del recurrente (610), 0 del esporádico (650) (${JSON.stringify(g1)})`);
      const props = await trx('budget.expense_obligations').where({ tenant_id: T, source: 'plan' }).andWhere('source_ref', 'like', `plan:${bud.id}:%`).orderBy('source_ref');
      ok(props.length === 12 && props.every((o) => o.status === 'propuesta' && o.authorized_by === null), `PR.3 12 en estado propuesta, authorized_by null (${props.length})`);
      const sub610 = props[0].subtype;
      ok(sub610 === 'sueldos', `PR.3 subtype inferido de "Nómina" = sueldos (${sub610})`);
      const g2 = await generate();
      ok(g2.generated === 0 && g2.skipped === 12, `PR.3 idempotente: re-generar 0 nuevas, 12 skipped (${JSON.stringify(g2)})`);
      // autorizar 3 → pending
      const ids3 = props.slice(0, 3).map((o) => o.id);
      let authd = 0; for (const id of ids3) { const r = await trx('budget.expense_obligations').where({ tenant_id: T, id }).first(); if (r.status === 'propuesta') { await trx('budget.expense_obligations').where({ tenant_id: T, id }).update({ status: 'pending', authorized_by: 'jefe', authorized_at: trx.fn.now() }); authd++; } }
      ok(authd === 3, `PR.3 autorizar en lote: 3 propuesta → pending (${authd})`);
      // exclusión: el Calendario/flujo NO ven propuesta
      const visible = await trx('budget.expense_obligations').where({ tenant_id: T }).andWhere('source_ref', 'like', `plan:${bud.id}:%`).whereNotIn('status', ['cancelled', 'propuesta']).count('* as c').first();
      ok(Number(visible.c) === 3, `PR.3 exclusión: sólo las 3 autorizadas (pending) son visibles al Calendario/flujo (${visible.c}), las 9 propuesta quedan fuera`);

      // ═══ PR.4 — Resultado ═══
      for (let p = 1; p <= 13; p++) await trx('budget.sales_plan_lines').insert({ tenant_id: T, budget_id: bud.id, entity_key: 'mostrador:01', period_no: p, meta_amount: 200000, method: 'manual', created_by: 'a', updated_by: 'a' });
      // egresos plan del ejercicio = 610 (12×100k=1.2M) + 650 (3×30k=90k) = 1,290,000
      const egRows = await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id }).sum({ s: 'monto' }).first();
      const totEg = round2(Number(egRows.s));
      const inRows = await trx('budget.sales_plan_lines').where({ tenant_id: T, budget_id: bud.id }).sum({ s: 'meta_amount' }).first();
      const totIng = round2(Number(inRows.s));
      ok(totIng === 2600000, `PR.4 ingresos plan = ${totIng} (13×200k)`);
      ok(totEg === 1290000, `PR.4 egresos plan = ${totEg} (610:1.2M + 650:90k)`);
      ok(round2(totIng - totEg) === 1310000, `PR.4 resultado anual = ${round2(totIng - totEg)} (ingresos − egresos)`);
      // monthly ingresos via day-split debe sumar a totIng
      const calRes = await trx.raw(`SELECT period_no, to_char(date,'YYYY-MM') ym, count(*)::int days FROM analytics.v_retail_calendar WHERE fiscal_year=? GROUP BY 1,2`, [FY]);
      const pm = new Map(), pt = new Map();
      for (const r of calRes.rows) { const p = Number(r.period_no); if (!pm.has(p)) pm.set(p, []); pm.get(p).push({ ym: r.ym, days: Number(r.days) }); pt.set(p, (pt.get(p) || 0) + Number(r.days)); }
      const inByPeriod = await trx('budget.sales_plan_lines').where({ tenant_id: T, budget_id: bud.id }).groupBy('period_no').select('period_no').sum({ meta: 'meta_amount' });
      const inMap = new Map();
      for (const r of inByPeriod) { const p = Number(r.period_no); const meta = Number(r.meta); const months = pm.get(p); const total = pt.get(p); if (!months || !(total > 0)) continue; for (const m of months) inMap.set(m.ym, round2((inMap.get(m.ym) || 0) + meta * (m.days / total))); }
      const sumMonthly = round2([...inMap.values()].reduce((s, v) => s + v, 0));
      ok(Math.abs(sumMonthly - totIng) < 0.10, `PR.4 ingresos mensuales (day-split) suman al anual: ${sumMonthly} ≈ ${totIng}`);

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\n${fail === 0 ? '✅' : '❌'} PR.2/3/4 automatizaciones: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy(); process.exit(fail === 0 ? 0 : 1);
  } catch (e) { console.error('💥', e.message); await knex.destroy(); process.exit(1); }
})();
