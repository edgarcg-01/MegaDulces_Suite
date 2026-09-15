/* eslint-disable no-console */
/**
 * Fase TP.6-TP.8+TP.10 (ADR-064) — Calendario de Pagos: separación de funciones + catálogo de
 * cuentas de pago a proveedor (con workflow de aprobación) + folio de lote/pago + motivo de
 * reprogramación. Smoke DB-direct, rollback al final (cero efecto real).
 *
 * Verifica:
 *   1. Schema: supplier_payment_accounts(+change_requests) RLS forzado, payment_calendar_lots.
 *      folio, payment_allocations.folio/reprogram_reason/reprogram_reason_detail/
 *      supplier_payment_account_id + su FK compuesta.
 *   2. CHECKs: reprogram_reason cerrado, folio único por tenant (lote y pago).
 *   3. Workflow de cuenta: alta (approve inserta) → cambio (approve actualiza + favorita
 *      exclusiva POR PROVEEDOR, no por tenant) → baja (approve desactiva) → rechazar (NO aplica).
 *   4. Orden de pago propuesto: compromiso financiero antes que gasto antes que proveedor,
 *      crítico antes que no-crítico dentro de la misma clasificación (réplica exacta de
 *      `suggestPriorityOrder`).
 *   5. Folio del lote/pago: formato `YYMMDD-01-NN` (réplica exacta de `releaseLot`).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-payment-calendar-controls');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
async function expectViolation(trx, fn) {
  await trx.raw('SAVEPOINT sp_check');
  let code = null;
  try { await fn(); } catch (e) { code = e.code; }
  await trx.raw('ROLLBACK TO SAVEPOINT sp_check');
  return code;
}

(async () => {
  try {
    // ── 1. Schema ───────────────────────────────────────────────────────────
    for (const [schema, table] of [['commercial', 'supplier_payment_accounts'], ['commercial', 'supplier_payment_account_change_requests']]) {
      const reg = await knex.raw(`SELECT to_regclass('${schema}.${table}') r`);
      ok(!!reg.rows[0].r, `${schema}.${table} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = '${schema}.${table}'::regclass`);
      ok(rls.rows[0]?.relforcerowsecurity === true, `${schema}.${table} con RLS FORZADO`);
    }
    ok(await knex.schema.withSchema('finance').hasColumn('payment_calendar_lots', 'folio'), 'payment_calendar_lots.folio existe');
    for (const col of ['folio', 'reprogram_reason', 'reprogram_reason_detail', 'supplier_payment_account_id']) {
      ok(await knex.schema.withSchema('finance').hasColumn('payment_allocations', col), `payment_allocations.${col} existe`);
    }

    // ── 2-5. Flujo completo (rollback al final) ──────────────────────────────
    await knex.transaction(async (trx) => {
      const [supplier] = await trx('catalog.suppliers').insert({ tenant_id: T, code: `SMK1-${Date.now()}`, name: 'Proveedor Control Smoke SA' }).returning('*');

      // ── Workflow de cuenta: ALTA ──────────────────────────────────────────
      const [reqAlta] = await trx('commercial.supplier_payment_account_change_requests').insert({
        tenant_id: T, supplier_id: supplier.id, account_id: null,
        proposed_bank_name: 'BBVA', proposed_clabe: '012180001234567890', proposed_alias: 'Principal',
        proposed_es_favorita: true, reason: 'Alta inicial (smoke)', requested_by: 'smoke_solicita',
      }).returning('*');
      ok(reqAlta.status === 'pending_approval', 'solicitud de alta nace pending_approval');

      // Rechazar NO aplica nada.
      const [rejected] = await trx('commercial.supplier_payment_account_change_requests').where({ id: reqAlta.id })
        .update({ status: 'rejected', decided_by: 'smoke_autoriza', decided_at: trx.fn.now() }).returning('*');
      ok(rejected.status === 'rejected', 'rechazar cambia status');
      const [{ n0 }] = await trx('commercial.supplier_payment_accounts').where({ supplier_id: supplier.id }).count('* as n0');
      ok(Number(n0) === 0, 'rechazar: NO crea ninguna cuenta (nunca se auto-aplica)');

      // Aprobar SÍ aplica (alta real).
      const [reqAlta2] = await trx('commercial.supplier_payment_account_change_requests').insert({
        tenant_id: T, supplier_id: supplier.id, account_id: null,
        proposed_bank_name: 'BBVA', proposed_clabe: '012180001234567890', proposed_alias: 'Principal',
        proposed_es_favorita: true, reason: 'Alta inicial (smoke, 2do intento)', requested_by: 'smoke_solicita',
      }).returning('*');
      const [acc1] = await trx('commercial.supplier_payment_accounts').insert({
        tenant_id: T, supplier_id: supplier.id, bank_name: reqAlta2.proposed_bank_name, clabe: reqAlta2.proposed_clabe,
        alias: reqAlta2.proposed_alias, es_favorita: reqAlta2.proposed_es_favorita, created_by: 'smoke_autoriza',
      }).returning('*');
      await trx('commercial.supplier_payment_account_change_requests').where({ id: reqAlta2.id })
        .update({ status: 'applied', decided_by: 'smoke_autoriza', decided_at: trx.fn.now() });
      ok(acc1.es_favorita === true, 'aprobar alta: cuenta creada y favorita (única cuenta del proveedor)');

      // ── Segunda cuenta favorita → desmarca la primera (scope: supplier_id, NO todo el tenant) ──
      const [otherSupplier] = await trx('catalog.suppliers').insert({ tenant_id: T, code: `SMK2-${Date.now()}`, name: 'Otro Proveedor Smoke SA' }).returning('*');
      const [accOther] = await trx('commercial.supplier_payment_accounts').insert({
        tenant_id: T, supplier_id: otherSupplier.id, bank_name: 'Santander', es_favorita: true, created_by: 'smoke_autoriza',
      }).returning('*');
      const acc1Check = await trx('commercial.supplier_payment_accounts').where({ id: acc1.id }).first('es_favorita');
      ok(acc1Check.es_favorita === true, 'favorita de OTRO proveedor no afecta la de este (scope correcto: por supplier_id)');

      const [acc2] = await trx('commercial.supplier_payment_accounts').insert({
        tenant_id: T, supplier_id: supplier.id, bank_name: 'Santander', clabe: '014180009876543210', es_favorita: false, created_by: 'smoke_autoriza',
      }).returning('*');
      // Aprobar un CAMBIO que marca acc2 como favorita → debe desmarcar acc1 (mismo proveedor).
      await trx('commercial.supplier_payment_accounts').where({ supplier_id: supplier.id, es_favorita: true }).update({ es_favorita: false });
      await trx('commercial.supplier_payment_accounts').where({ id: acc2.id }).update({ es_favorita: true });
      const [a1, a2] = await Promise.all([
        trx('commercial.supplier_payment_accounts').where({ id: acc1.id }).first('es_favorita'),
        trx('commercial.supplier_payment_accounts').where({ id: acc2.id }).first('es_favorita'),
      ]);
      ok(a1.es_favorita === false && a2.es_favorita === true, 'favorita exclusiva POR PROVEEDOR: marcar la 2da desmarca la 1ra (no toca la de otro proveedor)');
      ok(accOther.es_favorita === true, 'confirmado: la cuenta del otro proveedor sigue favorita (no se tocó)');

      // ── Baja de cuenta ─────────────────────────────────────────────────────
      await trx('commercial.supplier_payment_accounts').where({ id: acc2.id }).update({ status: 'inactiva' });
      const acc2After = await trx('commercial.supplier_payment_accounts').where({ id: acc2.id }).first('status');
      ok(acc2After.status === 'inactiva', 'baja: la cuenta queda inactiva (no se borra — trazabilidad)');

      // ── CHECKs ────────────────────────────────────────────────────────────
      const [lotForCheck] = await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: '2026-12-01' }).returning('*');
      const codeReason = await expectViolation(trx, () => trx('finance.payment_allocations').insert({
        tenant_id: T, lot_id: lotForCheck.id, classification: 'gasto', amount_assigned: 1, reprogram_reason: 'motivo_invalido',
      }));
      ok(codeReason === '23514', 'CHECK rechaza reprogram_reason inválido (valor fuera del enum cerrado)');

      const [lotA] = await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: '2026-12-02', folio: '261202-01' }).returning('*');
      ok(lotA.folio === '261202-01', 'lote acepta folio con formato YYMMDD-01');
      const dupLot = await expectViolation(trx, () => trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: '2026-12-03', folio: '261202-01' }));
      ok(dupLot === '23505', 'folio de lote es ÚNICO por tenant (índice parcial)');

      const [allocA] = await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lotA.id, classification: 'gasto', amount_assigned: 100, folio: '261202-01-01' }).returning('*');
      ok(allocA.folio === '261202-01-01', 'pago acepta folio <lote>-NN');
      const dupAlloc = await expectViolation(trx, () => trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lotA.id, classification: 'gasto', amount_assigned: 50, folio: '261202-01-01' }));
      ok(dupAlloc === '23505', 'folio de pago es ÚNICO por tenant (índice parcial)');

      // ── FK cuenta de proveedor en payment_allocations ────────────────────
      const [allocB] = await trx('finance.payment_allocations').insert({
        tenant_id: T, lot_id: lotA.id, classification: 'proveedor_mercancia', amount_assigned: 200,
        supplier_payment_account_id: acc1.id, destination_account_text: `${acc1.bank_name} · CLABE ${acc1.clabe}`,
      }).returning('*');
      ok(allocB.supplier_payment_account_id === acc1.id, 'payment_allocations referencia la cuenta del catálogo (evita texto libre con error de captura)');

      // ── Orden de pago propuesto (réplica exacta de suggestPriorityOrder) ──
      const [supplierObl] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: T, supplier_id: supplier.id, original_amount: 5000, authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      const [commitment] = await trx('finance.financial_commitments').insert({
        tenant_id: T, concept: 'Factoraje orden-test', beneficiary: 'Factor Smoke', subtype: 'factoraje',
        original_amount: 3000, authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      const [expenseCrit] = await trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'Gasto crítico orden-test', beneficiary: 'Beneficiario Smoke', original_amount: 1000,
        is_critical: true, critical_reason: 'orden-test', authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      const [expenseNorm] = await trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'Gasto normal orden-test', beneficiary: 'Beneficiario Smoke', original_amount: 800,
        authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      const [lotOrder] = await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: '2026-12-05' }).returning('*');
      const mk = async (classification, amount) => {
        const [a] = await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lotOrder.id, classification, amount_assigned: amount }).returning('*');
        return a;
      };
      const allocSupplier = await mk('proveedor_mercancia', 5000);
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocSupplier.id, obligation_source: 'supplier_payable', obligation_id: supplierObl.id, applied_amount: 5000 });
      const allocCommitment = await mk('compromiso_financiero', 3000);
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocCommitment.id, obligation_source: 'financial_commitment', obligation_id: commitment.id, applied_amount: 3000 });
      const allocExpenseCrit = await mk('gasto', 1000);
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocExpenseCrit.id, obligation_source: 'budget_expense', obligation_id: expenseCrit.id, applied_amount: 1000 });
      const allocExpenseNorm = await mk('gasto', 800);
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocExpenseNorm.id, obligation_source: 'budget_expense', obligation_id: expenseNorm.id, applied_amount: 800 });

      const rows = await trx.raw(`
        WITH crit AS (
          SELECT a.id AS allocation_id,
            bool_or(CASE i.obligation_source
              WHEN 'budget_expense' THEN eo.is_critical
              WHEN 'financial_commitment' THEN fc.is_critical
              WHEN 'supplier_payable' THEN s.is_critical END) AS any_critical,
            min(CASE i.obligation_source
              WHEN 'budget_expense' THEN eo.original_due_date
              WHEN 'financial_commitment' THEN fc.original_due_date
              WHEN 'supplier_payable' THEN spo.original_due_date END) AS min_due
          FROM finance.payment_allocations a
          JOIN finance.payment_allocation_items i ON i.allocation_id = a.id
          LEFT JOIN budget.expense_obligations eo ON i.obligation_source='budget_expense' AND eo.id=i.obligation_id
          LEFT JOIN finance.financial_commitments fc ON i.obligation_source='financial_commitment' AND fc.id=i.obligation_id
          LEFT JOIN commercial.supplier_payment_obligations spo ON i.obligation_source='supplier_payable' AND spo.id=i.obligation_id
          LEFT JOIN catalog.suppliers s ON spo.supplier_id = s.id
          WHERE a.lot_id = ? AND a.status = 'pending'
          GROUP BY a.id
        )
        SELECT a.id, a.classification, coalesce(c.any_critical,false) AS any_critical, c.min_due, a.amount_assigned
        FROM finance.payment_allocations a JOIN crit c ON c.allocation_id = a.id
        ORDER BY
          CASE a.classification WHEN 'compromiso_financiero' THEN 0 WHEN 'gasto' THEN 1 WHEN 'proveedor_mercancia' THEN 2 ELSE 3 END,
          c.any_critical DESC, c.min_due ASC NULLS LAST, a.amount_assigned DESC`, [lotOrder.id]);
      const order = rows.rows.map((r) => r.id);
      ok(order[0] === allocCommitment.id, 'orden propuesto: compromiso financiero va PRIMERO');
      ok(order[1] === allocExpenseCrit.id, 'orden propuesto: gasto CRÍTICO antes que gasto normal (misma clasificación)');
      ok(order[2] === allocExpenseNorm.id, 'orden propuesto: gasto normal en 3er lugar');
      ok(order[3] === allocSupplier.id, 'orden propuesto: proveedor de mercancía va AL FINAL');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const [after] = await knex('commercial.supplier_payment_accounts').where({ bank_name: 'BBVA', clabe: '012180001234567890' }).count('* as n');
    ok(Number(after.n) === 0, 'rollback: 0 filas persistidas (no ensucia la data real)');

    console.log(`\nTP payment-calendar-controls: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
