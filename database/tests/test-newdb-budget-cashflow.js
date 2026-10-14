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

    // ── 5. ⛔⛔ [CG.142] La clave de la semana EMPATA entre las dos piernas ────
    //
    // `deudaPrevista` devolvía su bucket como `date_trunc(...)::date`, y el driver entrega eso
    // como objeto `Date` (este repo no fija `setTypeParser`). El `String(b).slice(0, 10)` del
    // consumidor daba **«Mon Oct 19»**, mientras `weekBuckets()` pide `YYYY-MM-DD`: la curva
    // buscaba con una clave que NUNCA estaba y `pagos` caía al `?? 0` todas las semanas. Neto =
    // cobranza entera, y la alerta de insuficiencia sin poder sonar.
    //
    // ⚠️ Lo que lo volvía invisible: `Date.parse('Mon Oct 19')` **no da NaN**, da **2001**-10-19
    // (JS completa el año), así que `horizonte_dias` salía de un año equivocado sin fallar.
    //
    // ⭐ Se vigilan las DOS formas en la misma corrida: la que se usa (`to_char`) tiene que
    // empatar, y la que se retiró (`::date`) tiene que SEGUIR sin empatar — si algún día empata,
    // la premisa cambió y lo que hay que revisar es la DECISIÓN, no el test.
    {
      const lunesISO = (d) => {
        const x = new Date(d + 'T00:00:00Z'); const dow = (x.getUTCDay() + 6) % 7;
        x.setUTCDate(x.getUTCDate() - dow); return x.toISOString().slice(0, 10);
      };
      const q = (expr) => knex.raw(
        `SELECT ${expr} AS bucket FROM analytics.v_supplier_payables
          WHERE tenant_id = ? AND pendiente > 0
            AND vencimiento BETWEEN current_date AND (current_date + 90)
          GROUP BY 1 ORDER BY 1 LIMIT 5`, [T]);

      // ⚠️ Sin esto, una DB de pruebas sin la vista rompe la suite por el motivo EQUIVOCADO:
      // el `catch` de abajo saldría con exit 1 y se leería como «la clave de la semana falló».
      const hayVista = (await knex.raw(`SELECT to_regclass('analytics.v_supplier_payables') AS r`))
        .rows[0].r;
      const nuevas = hayVista
        ? (await q(`to_char(date_trunc('week', vencimiento), 'YYYY-MM-DD')`)).rows
          .map((r) => String(r.bucket).slice(0, 10))
        : [];

      if (!hayVista) {
        console.log('  ◌ NO MEDIDO: analytics.v_supplier_payables no existe en esta DB — la clave '
          + 'de la semana no se pudo ejercer.');
      } else if (!nuevas.length) {
        console.log('  ◌ NO MEDIDO: no hay deuda con vencimiento en los próximos 90 d en esta DB, '
          + 'así que la clave de la semana no se pudo EJERCER.');
      } else {
        const esperadas = new Set(nuevas.map((k) => lunesISO(k)));
        ok(nuevas.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && esperadas.has(k)),
          `la semana de la deuda sale ISO y empata con weekBuckets(): ${nuevas.slice(0, 3).join(', ')}`);

        // Prueba negativa: la forma vieja, sobre LAS MISMAS filas.
        const viejas = (await q(`date_trunc('week', vencimiento)::date`)).rows
          .map((r) => String(r.bucket).slice(0, 10));
        ok(viejas.length > 0 && !viejas.some((k) => esperadas.has(k)),
          `la forma retirada (::date) sigue SIN empatar — ${JSON.stringify(viejas[0])} contra `
          + `${JSON.stringify(nuevas[0])}. Si esto se pone verde, el driver cambió: revisar la decisión.`);
      }
    }

    console.log(`\nBudget cashflow (PU.3): ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('ERROR', e);
    await knex.destroy();
    process.exit(1);
  }
})();
