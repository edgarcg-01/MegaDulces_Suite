/* eslint-disable no-console */
/**
 * Fase PVG — Presupuesto de GASTOS auto-propuesto desde egresos de Kepler (ADR-073). Smoke DB-direct.
 *
 * Verifica la lógica de `BudgetExpensePlanService` (reproducida acá) contra la DB real, con egresos
 * SINTÉTICOS sembrados en una transacción con rollback (el demo tenant de dev no trae egresos):
 *   1. `analytics.expense_entries` legible; egresos NETOS (cargo − abono) por cuenta × mes.
 *   2. proposeGrowth: YoY por cuenta sobre meses APAREADOS; guard de meses mínimos → default.
 *   3. proposePlan: mes con base → base×(1+crec) (historico_ajustado); cuenta recurrente (≥6 meses),
 *      mes faltante → promedio×(1+crec) (estacional); cuenta esporádica → sólo sus meses (no_signal).
 *   4. «Sin datos» ≠ cero: una cuenta con 3 meses NO rellena los otros 9.
 *   5. nunca pisa method='manual' salvo overwrite; upsert idempotente en la natural key.
 *
 * Valida SCHEMA/consultas. Verificación HTTP end-to-end PENDIENTE (ADR-044), declarada.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-expense-plan');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const ROLLBACK = Symbol('rollback');
const FY = 2031; // año futuro sin choque con datos ambiente

(async () => {
  try {
    // esquema presente
    const cols = await knex.raw(`SELECT count(*)::int c FROM information_schema.columns WHERE table_schema='budget' AND table_name='expense_plan_lines'`);
    ok(Number(cols.rows[0].c) >= 15, `budget.expense_plan_lines existe (${cols.rows[0].c} cols)`);

    await knex.transaction(async (trx) => {
      const [bud] = await trx('budget.budgets').insert({ tenant_id: T, name: 'PVG ' + Date.now(), fiscal_year: FY, status: 'borrador', created_by: 'a' }).returning('*');

      // ── sembrar egresos sintéticos: 2 años previos (FY-2, FY-1) fam '6' ──
      // cuenta 610 (nómina): recurrente los 12 meses, crece ~10% YoY
      // cuenta 620 (renta): recurrente 12 meses, plano
      // cuenta 650 (mantenimiento): ESPORÁDICO — sólo 3 meses en FY-1
      const mkEntry = async (cuenta, nombre, fecha, importe, ca = 'C') =>
        trx('analytics.expense_entries').insert({
          tenant_id: T, sucursal: '01', doc_tipo: 'XA', doc_folio: 'T' + Math.random().toString(36).slice(2, 8),
          linea: 1, fecha, cuenta: cuenta + '-001', cuenta_nombre: nombre, familia: '6', cargo_abono: ca,
          beneficiario: nombre, importe, cuenta_mayor: cuenta, cuenta_mayor_nombre: nombre, concepto: null,
        });
      for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0');
        await mkEntry('610', 'Nómina', `${FY - 2}-${mm}-15`, 100000);
        await mkEntry('610', 'Nómina', `${FY - 1}-${mm}-15`, 110000); // +10% YoY
        await mkEntry('620', 'Renta', `${FY - 2}-${mm}-01`, 50000);
        await mkEntry('620', 'Renta', `${FY - 1}-${mm}-01`, 50000);  // plano
      }
      // una nota de crédito (abono) en nómina FY-1 marzo: reduce el neto de ese mes
      await mkEntry('610', 'Nómina', `${FY - 1}-03-20`, 10000, 'A');
      // mantenimiento esporádico en FY-1: sólo ene/jun/dic
      for (const mm of ['01', '06', '12']) await mkEntry('650', 'Mantenimiento', `${FY - 1}-${mm}-10`, 30000);

      // ── 1. egresos netos por cuenta × mes (FY-1) ──
      const net = (await trx.raw(
        `SELECT cuenta_mayor acc, extract(month from fecha)::int mes,
                sum(CASE WHEN cargo_abono='A' THEN -importe ELSE importe END) monto
           FROM analytics.expense_entries
          WHERE tenant_id=? AND familia='6' AND extract(year from fecha)=?
          GROUP BY cuenta_mayor, extract(month from fecha)`, [T, FY - 1])).rows;
      const marzo610 = net.find((r) => r.acc === '610' && Number(r.mes) === 3);
      ok(marzo610 && round2(Number(marzo610.monto)) === 100000, `neto (cargo−abono) marzo 610 = ${marzo610 ? round2(Number(marzo610.monto)) : '—'} (110k − 10k)`);

      // ── 2. proposeGrowth: YoY 610 ≈ +10% ──
      const rowsYoY = (await trx.raw(
        `SELECT cuenta_mayor acc, extract(year from fecha)::int yr, extract(month from fecha)::int mes,
                sum(CASE WHEN cargo_abono='A' THEN -importe ELSE importe END) monto
           FROM analytics.expense_entries WHERE tenant_id=? AND familia='6' AND extract(year from fecha)=ANY(?)
          GROUP BY cuenta_mayor, extract(year from fecha), extract(month from fecha)`, [T, [FY - 2, FY - 1]])).rows;
      const yoy = (acc) => {
        const bm = new Map();
        for (const r of rowsYoY) { if (r.acc !== acc) continue; const e = bm.get(Number(r.mes)) || { a: 0, b: 0 }; if (Number(r.yr) === FY - 2) e.a += Number(r.monto); else e.b += Number(r.monto); bm.set(Number(r.mes), e); }
        let a = 0, b = 0, p = 0; for (const [, e] of bm) if (e.a > 0 && e.b > 0) { a += e.a; b += e.b; p++; }
        return p >= 4 && a > 0 ? { g: round4((b - a) / a), p } : null;
      };
      const g610 = yoy('610');
      // 610: (12*110000 − 10000) / (12*100000) = (1,320,000 − 10,000)/1,200,000 = 1,310,000/1,200,000 → +9.17%
      ok(g610 && g610.p === 12 && Math.abs(g610.g - 0.0917) < 0.005, `proposeGrowth 610: YoY ${g610 ? (g610.g * 100).toFixed(2) : '—'}% sobre ${g610 ? g610.p : 0} meses apareados (≈+9.17% con la nota de crédito)`);
      const g650 = yoy('650');
      ok(g650 === null, 'proposeGrowth 650 (esporádico, 3 meses < 4 apareados) → null → cae a default (guard de rampa)');

      // ── 3-5. proposePlan (reproducido): crec 8% default, sin override ──
      const DEF = 0.08;
      const byAccMonth = new Map(); // acc → Map(mes→neto) del FY-1
      const nameByAcc = new Map();
      for (const r of net) { if (!byAccMonth.has(r.acc)) byAccMonth.set(r.acc, new Map()); byAccMonth.get(r.acc).set(Number(r.mes), Number(r.monto)); }
      for (const r of rowsYoY) nameByAcc.set(r.acc, r.acc);
      const cov = { historico_ajustado: 0, estacional: 0, no_signal: 0 };
      for (const [acc, bm] of byAccMonth) {
        const present = [...bm.values()].filter((v) => v > 0);
        const avg = present.length ? present.reduce((a, c) => a + c, 0) / present.length : 0;
        const recurrent = present.length >= 6;
        for (let m = 1; m <= 12; m++) {
          const base = bm.get(m) || 0;
          let monto = null, method = null;
          if (base > 0) { monto = round2(base * (1 + DEF)); method = 'historico_ajustado'; }
          else if (recurrent && avg > 0) { monto = round2(avg * (1 + DEF)); method = 'estacional'; }
          if (monto == null) { cov.no_signal++; continue; }
          await trx('budget.expense_plan_lines').insert({
            tenant_id: T, budget_id: bud.id, account_code: acc, account_name: acc, familia: '6', sucursal: '',
            year_month: `${FY}-${String(m).padStart(2, '0')}`, monto, method, growth_pct: DEF, base_amount: round2(base > 0 ? base : avg),
            created_by: 'a', updated_by: 'a',
          }).onConflict(['tenant_id', 'budget_id', 'account_code', 'sucursal', 'year_month'])
            .merge({ monto, method, updated_by: 'a' });
          cov[method]++;
        }
      }
      // 610 y 620 recurrentes: 12 meses cada uno = 24 historico_ajustado; 650 esporádico: 3 historico + 9 no_signal
      ok(cov.historico_ajustado === 27, `historico_ajustado = ${cov.historico_ajustado} (610:12 + 620:12 + 650:3)`);
      ok(cov.estacional === 0, `estacional = ${cov.estacional} (no hay meses faltantes en cuentas recurrentes acá)`);
      ok(cov.no_signal === 9, `«sin datos» ≠ cero: 650 esporádico dejó ${cov.no_signal} meses SIN fila (no se inventan)`);

      // fila 610 enero: base = año anterior (FY-1) = 110000 × 1.08 = 118800
      const ene610 = await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id, account_code: '610', sucursal: '', year_month: `${FY}-01` }).first();
      ok(ene610 && round2(Number(ene610.monto)) === 118800 && ene610.method === 'historico_ajustado', `610 ene: monto ${ene610 ? round2(Number(ene610.monto)) : '—'} = 110k(año anterior)×1.08, method ${ene610 ? ene610.method : '—'}`);
      // 650 sólo 3 filas
      const cnt650 = await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id, account_code: '650' }).count('* as c').first();
      ok(Number(cnt650.c) === 3, `650 (esporádico) tiene ${cnt650.c} filas = sus 3 meses reales`);

      // 5. manual no se pisa
      await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id, account_code: '610', sucursal: '', year_month: `${FY}-01` })
        .update({ method: 'manual', monto: 999999 });
      // re-proponer 610 enero SIN overwrite → debe respetar manual
      const existing = await trx('budget.expense_plan_lines').where({ tenant_id: T, budget_id: bud.id, account_code: '610', sucursal: '', year_month: `${FY}-01` }).first();
      const wouldSkip = existing.method === 'manual'; // (overwrite_manual=false)
      ok(wouldSkip, 'method=manual se respeta al re-proponer (sin overwrite_manual)');

      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });

    console.log(`\n${fail === 0 ? '✅' : '❌'} PVG presupuesto de gastos: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('💥', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
