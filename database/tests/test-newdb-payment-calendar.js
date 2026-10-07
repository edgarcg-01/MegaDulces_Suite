/* eslint-disable no-console */
/**
 * Fase TP — Calendario de Pagos (ADR-064). Smoke DB-direct.
 *
 * Verifica contra la DB real:
 *   1. Schema: budget.daily_capacity(+history)/expense_obligations, finance.financial_commitments,
 *      commercial.supplier_payment_obligations, finance.payment_calendar_lots/payment_allocations/
 *      payment_allocation_items/payment_negotiation_agreements — todas con RLS FORZADO.
 *   2. catalog.suppliers.is_critical/critical_reason existen.
 *   3. Flujo completo dentro de una trx con ROLLBACK (cero efecto real): capacidad+historial →
 *      3 obligaciones (una por origen) → 1 pago agrupando 2 obligaciones (misma clasificación) →
 *      recalculo de reserved/paid → reprogramar (cancela+recrea) → fallo libera reserva →
 *      ejecutar mueve reserved→paid sin tocar capacidad → CHECKs (clasificación mixta, status
 *      inválido) → UNION de obligaciones disponibles.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
// `[IDG.1]` Este test escribe filas (dentro de una trx con rollback). El knexfile ya cargó el .env.
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-payment-calendar');
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// Réplica de PaymentCalendarService.recalcObligation: reserved=Σitems de allocations 'pending',
// paid=Σitems de allocations 'executed'. Nunca +=/-= manual.
async function recalc(trx, table, source, id) {
  const [agg] = await trx('finance.payment_allocation_items as i')
    .join('finance.payment_allocations as a', 'a.id', 'i.allocation_id')
    .where({ 'i.obligation_source': source, 'i.obligation_id': id })
    .select(
      trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'pending'), 0) AS reserved`),
      trx.raw(`coalesce(sum(i.applied_amount) FILTER (WHERE a.status = 'executed'), 0) AS paid`),
    );
  const reserved = Number(agg?.reserved ?? 0), paid = Number(agg?.paid ?? 0);
  const row = await trx(table).select('original_amount', 'status').where({ id }).first();
  const status = row.status === 'cancelled' ? 'cancelled' : paid >= Number(row.original_amount) ? 'paid' : (paid > 0 || reserved > 0) ? 'partial' : 'pending';
  await trx(table).where({ id }).update({ reserved_amount: reserved, paid_amount: paid, status });
  return { reserved, paid, status };
}

(async () => {
  try {
    // ── 1. Schema ───────────────────────────────────────────────────────────
    const tables = [
      ['budget', 'daily_capacity'], ['budget', 'daily_capacity_history'], ['budget', 'expense_obligations'],
      ['finance', 'financial_commitments'], ['commercial', 'supplier_payment_obligations'],
      ['finance', 'payment_calendar_lots'], ['finance', 'payment_allocations'],
      ['finance', 'payment_allocation_items'], ['finance', 'payment_negotiation_agreements'],
    ];
    for (const [schema, table] of tables) {
      const reg = await knex.raw(`SELECT to_regclass('${schema}.${table}') r`);
      ok(!!reg.rows[0].r, `${schema}.${table} existe`);
      const rls = await knex.raw(`SELECT relforcerowsecurity FROM pg_class WHERE oid = '${schema}.${table}'::regclass`);
      ok(rls.rows[0]?.relforcerowsecurity === true, `${schema}.${table} con RLS FORZADO`);
    }
    const hasCritical = await knex.schema.withSchema('catalog').hasColumn('suppliers', 'is_critical');
    const hasCriticalReason = await knex.schema.withSchema('catalog').hasColumn('suppliers', 'critical_reason');
    ok(hasCritical, 'catalog.suppliers.is_critical existe');
    ok(hasCriticalReason, 'catalog.suppliers.critical_reason existe');

    // ── 2. Flujo completo (rollback al final) ────────────────────────────────
    await knex.transaction(async (trx) => {
      const testDate = '2026-09-15';
      const testDate2 = '2026-09-16';

      // Aísla el test de datos ambiente (ej. el seed de demo de 90 días, TP §"Seed de ejemplo")
      // que puede tener filas en estas mismas fechas — se borran DENTRO de esta transacción
      // (el rollback final las restaura, cero efecto real).
      for (const d of [testDate, testDate2]) {
        await trx('finance.payment_calendar_lots').where({ tenant_id: T, lot_date: d }).del();
        await trx('budget.daily_capacity_history').where({ tenant_id: T, capacity_date: d }).del();
        await trx('budget.daily_capacity').where({ tenant_id: T, capacity_date: d }).del();
      }

      // Capacidad + historial (Presupuestos)
      const [cap] = await trx('budget.daily_capacity').insert({ tenant_id: T, capacity_date: testDate, authorized_amount: 100000, created_by: 'smoke' }).returning('*');
      await trx('budget.daily_capacity_history').insert({ tenant_id: T, capacity_date: testDate, previous_amount: null, new_amount: 100000, reason: 'alta smoke', changed_by: 'smoke' });
      ok(Number(cap.authorized_amount) === 100000, 'capacidad del día creada ($100,000)');
      const hist = await trx('budget.daily_capacity_history').where({ tenant_id: T, capacity_date: testDate });
      ok(hist.length === 1, 'historial de capacidad tiene 1 entrada');

      // Sin capacidad definida en otro día → NULL, no cero (criterio: distinguir no-definida de cero).
      const noCap = await trx('budget.daily_capacity').where({ tenant_id: T, capacity_date: '2099-01-01' }).first();
      ok(noCap === undefined, 'día sin fila = capacidad NO definida (no es 0)');

      // Obligación 1: gasto autorizado (Presupuestos)
      const [expense] = await trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'Renta CEDIS septiembre', beneficiary: 'Arrendadora Smoke SA', subtype: 'renta',
        original_amount: 20000, original_due_date: testDate, authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      ok(expense.status === 'pending' && Number(expense.original_amount) === 20000, 'gasto autorizado creado (pending, $20,000)');

      // Obligación 2: compromiso financiero (Finanzas)
      const [commitment] = await trx('finance.financial_commitments').insert({
        tenant_id: T, concept: 'Factoraje semanal', beneficiary: 'Factor Smoke SA', subtype: 'factoraje',
        original_amount: 50000, original_due_date: testDate, authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      ok(commitment.status === 'pending', 'compromiso financiero creado (pending)');

      // Obligación 3: proveedor de mercancía (Compras) — supplier temporal
      const [supplier] = await trx('catalog.suppliers').insert({ tenant_id: T, code: `SMK-${Date.now()}`, name: 'Proveedor Smoke SA' }).returning('*');
      const [supplierObl] = await trx('commercial.supplier_payment_obligations').insert({
        tenant_id: T, supplier_id: supplier.id, invoice_folio: 'F-SMOKE-1', concept: 'Mercancía dulcería',
        original_amount: 30000, original_due_date: testDate, authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      ok(Number(supplierObl.original_amount) === 30000, 'obligación a proveedor creada ($30,000)');

      // Marcar proveedor crítico — SIEMPRE con motivo (nunca por importe).
      await trx('catalog.suppliers').where({ id: supplier.id }).update({ is_critical: true, critical_reason: 'único proveedor de esta marca' });
      const supCheck = await trx('catalog.suppliers').where({ id: supplier.id }).first('is_critical', 'critical_reason');
      ok(supCheck.is_critical === true && !!supCheck.critical_reason, 'proveedor marcado crítico con motivo');

      // ── Pago que agrupa 2 gastos del mismo origen (budget_expense) — "un pago cubre varias facturas"
      const [expense2] = await trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'Luz CEDIS', beneficiary: 'CFE Smoke', subtype: 'luz',
        original_amount: 8000, original_due_date: testDate, authorized_by: 'smoke', created_by: 'smoke',
      }).returning('*');
      const [lot] = await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: testDate }).returning('*');
      const [allocation] = await trx('finance.payment_allocations').insert({
        tenant_id: T, lot_id: lot.id, classification: 'gasto', amount_assigned: 28000, created_by: 'smoke',
      }).returning('*');
      await trx('finance.payment_allocation_items').insert([
        { tenant_id: T, allocation_id: allocation.id, obligation_source: 'budget_expense', obligation_id: expense.id, applied_amount: 20000 },
        { tenant_id: T, allocation_id: allocation.id, obligation_source: 'budget_expense', obligation_id: expense2.id, applied_amount: 8000 },
      ]);
      const r1 = await recalc(trx, 'budget.expense_obligations', 'budget_expense', expense.id);
      const r2 = await recalc(trx, 'budget.expense_obligations', 'budget_expense', expense2.id);
      ok(r1.reserved === 20000 && r1.status === 'partial', 'gasto 1: reserved=$20,000, status=partial (pago pendiente)');
      ok(r2.reserved === 8000 && r2.status === 'partial', 'gasto 2: reserved=$8,000, status=partial');

      const items = await trx('finance.payment_allocation_items').where({ allocation_id: allocation.id });
      ok(items.length === 2, 'un pago agrupa 2 obligaciones (allocation_items)');

      // ── Parcialidad: la obligación de proveedor se paga en DOS fechas distintas ──
      const [lot2] = await trx('finance.payment_calendar_lots').insert({ tenant_id: T, lot_date: testDate2 }).returning('*');
      const [allocA] = await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: 18000, created_by: 'smoke' }).returning('*');
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocA.id, obligation_source: 'supplier_payable', obligation_id: supplierObl.id, applied_amount: 18000 });
      const [allocB] = await trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot2.id, classification: 'proveedor_mercancia', amount_assigned: 12000, created_by: 'smoke' }).returning('*');
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocB.id, obligation_source: 'supplier_payable', obligation_id: supplierObl.id, applied_amount: 12000 });
      const r3 = await recalc(trx, 'commercial.supplier_payment_obligations', 'supplier_payable', supplierObl.id);
      ok(r3.reserved === 30000 && r3.status === 'partial', 'proveedor: 2 parcialidades ($18k+$12k) suman $30,000 reservado, nunca se reserva 2 veces el mismo saldo');
      const available = Number(supplierObl.original_amount) - r3.reserved - r3.paid;
      ok(available === 0, 'disponible del proveedor = $0 tras reservar el total en 2 fechas');

      // ── Consumo de capacidad del día 1: gasto ($28,000) + proveedor parcial ($18,000) = $46,000 ──
      const [{ consumo }] = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed']).select(trx.raw('coalesce(sum(amount_assigned),0) AS consumo'));
      ok(Number(consumo) === 46000, `consumo del día 1 = $46,000 (28k gasto + 18k proveedor), dentro de la capacidad de $100,000`);
      ok(Number(consumo) <= Number(cap.authorized_amount), 'consumo <= capacidad autorizada → el lote SÍ podría liberarse');

      // ── Reprogramar allocB (día2→día1): cancela + recrea, actualiza capacidad de AMBAS fechas ──
      await trx('finance.payment_allocations').where({ id: allocB.id }).update({ status: 'cancelled', notes: 'reprogramado' });
      const [allocB2] = await trx('finance.payment_allocations').insert({
        tenant_id: T, lot_id: lot.id, classification: 'proveedor_mercancia', amount_assigned: 12000,
        reprogrammed_from_id: allocB.id, created_by: 'smoke',
      }).returning('*');
      await trx('finance.payment_allocation_items').insert({ tenant_id: T, allocation_id: allocB2.id, obligation_source: 'supplier_payable', obligation_id: supplierObl.id, applied_amount: 12000 });
      const [{ consumoDia2 }] = await trx('finance.payment_allocations').where({ lot_id: lot2.id }).whereIn('status', ['pending', 'executed']).select(trx.raw('coalesce(sum(amount_assigned),0) AS "consumoDia2"'));
      ok(Number(consumoDia2) === 0, 'reprogramar: el día 2 queda en $0 (cancelado, no cuenta)');
      const [{ consumoDia1 }] = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed']).select(trx.raw('coalesce(sum(amount_assigned),0) AS "consumoDia1"'));
      ok(Number(consumoDia1) === 58000, 'reprogramar: el día 1 ahora consume $58,000 (46k + 12k reprogramado)');
      ok(allocB2.reprogrammed_from_id === allocB.id, 'el pago nuevo conserva la lineage (reprogrammed_from_id)');

      // ── Falla: NO liquida, regresa el saldo (criterio #11) ──────────────────
      await trx('finance.payment_allocations').where({ id: allocA.id }).update({ status: 'failed', failure_reason: 'cuenta destino inválida' });
      const r4 = await recalc(trx, 'commercial.supplier_payment_obligations', 'supplier_payable', supplierObl.id);
      ok(r4.reserved === 12000 && r4.paid === 0, 'falla: el reservado del proveedor baja a $12,000 (los $18k fallidos regresan a revisión)');
      ok(r4.status === 'partial', 'falla: la obligación sigue partial (NO se marca paid)');

      // ── Ejecutar: mueve reserved→paid, la capacidad consumida NO cambia (criterio #10) ──
      const [{ consumoAntes }] = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed']).select(trx.raw('coalesce(sum(amount_assigned),0) AS "consumoAntes"'));
      await trx('finance.payment_allocations').where({ id: allocation.id }).update({ status: 'executed', payment_method: 'transferencia', executed_at: trx.fn.now() });
      const r5 = await recalc(trx, 'budget.expense_obligations', 'budget_expense', expense.id);
      ok(r5.paid === 20000 && r5.reserved === 0 && r5.status === 'paid', 'ejecutar: el gasto pasa reserved→paid y status=paid (cubre el 100%)');
      const [{ consumoDespues }] = await trx('finance.payment_allocations').where({ lot_id: lot.id }).whereIn('status', ['pending', 'executed']).select(trx.raw('coalesce(sum(amount_assigned),0) AS "consumoDespues"'));
      ok(Number(consumoAntes) === Number(consumoDespues), 'ejecutar NO vuelve a liberar capacidad (el consumo del día no cambia)');

      // ── CHECK constraints ─────────────────────────────────────────────────
      // Postgres ABORTA la transacción completa tras un error (lección ya vivida en este
      // repo, SN.22 — "de una transacción abortada no se sale con un try/catch"): cada intento
      // de violación va aislado en su propio SAVEPOINT, o el resto del test (incluida la
      // inserción real del agreement) fallaría con 25P02, no con el CHECK que se busca probar.
      async function expectCheckViolation(fn) {
        await trx.raw('SAVEPOINT sp_check');
        let code = null;
        try { await fn(); } catch (e) { code = e.code; }
        await trx.raw('ROLLBACK TO SAVEPOINT sp_check');
        return code;
      }
      const codeClass = await expectCheckViolation(() => trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'no_existe', amount_assigned: 1 }));
      ok(codeClass === '23514', 'CHECK rechaza classification inválida');

      const codeMethod = await expectCheckViolation(() => trx('finance.payment_allocations').insert({ tenant_id: T, lot_id: lot.id, classification: 'gasto', amount_assigned: 1, payment_method: 'bitcoin' }));
      ok(codeMethod === '23514', 'CHECK rechaza payment_method inválido');

      const codeOverAmount = await expectCheckViolation(() => trx('budget.expense_obligations').insert({
        tenant_id: T, concept: 'x', beneficiary: 'x', original_amount: 100, reserved_amount: 60, paid_amount: 60, authorized_by: 'smoke',
      }));
      ok(codeOverAmount === '23514', 'CHECK rechaza reserved+paid > original_amount');

      // ── Agreement (acuerdo de negociación) ───────────────────────────────────
      const [agreement] = await trx('finance.payment_negotiation_agreements').insert({
        tenant_id: T, obligation_source: 'supplier_payable', obligation_id: supplierObl.id,
        responsible_user: 'smoke', counterpart_text: 'Lic. Proveedor', committed_date: testDate,
        committed_amount: 30000, allows_partial: true, created_by: 'smoke',
      }).returning('*');
      ok(agreement.allows_partial === true, 'acuerdo de negociación registrado (permite parcialidad)');

      // ── UNION de obligaciones disponibles (réplica de listObligations) ───────
      const legBudget = trx('budget.expense_obligations as o').select(
        trx.raw(`'budget_expense'::text AS obligation_source`), 'o.id AS obligation_id', 'o.beneficiary', 'o.concept',
        trx.raw(`'gasto'::text AS classification`), trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.status',
      ).whereNotIn('o.status', ['cancelled']);
      const legCommitment = trx('finance.financial_commitments as o').select(
        trx.raw(`'financial_commitment'::text AS obligation_source`), 'o.id AS obligation_id', 'o.beneficiary', 'o.concept',
        trx.raw(`'compromiso_financiero'::text AS classification`), trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.status',
      ).whereNotIn('o.status', ['cancelled']);
      const legSupplier = trx('commercial.supplier_payment_obligations as o').join('catalog.suppliers as s', 's.id', 'o.supplier_id').select(
        trx.raw(`'supplier_payable'::text AS obligation_source`), 'o.id AS obligation_id', 's.name AS beneficiary', 'o.concept',
        trx.raw(`'proveedor_mercancia'::text AS classification`), trx.raw('(o.original_amount - o.reserved_amount - o.paid_amount) AS available_amount'),
        'o.status',
      ).whereNotIn('o.status', ['cancelled']);
      const unionSql = `(${legBudget.toQuery()} UNION ALL ${legCommitment.toQuery()} UNION ALL ${legSupplier.toQuery()}) AS ob`;
      const union = await trx.select('ob.*').from(trx.raw(unionSql)).whereIn('ob.obligation_id', [expense.id, expense2.id, commitment.id, supplierObl.id]);
      ok(union.length === 4, 'UNION de obligaciones trae los 3 orígenes (4 filas: 2 gastos + 1 compromiso + 1 proveedor)');
      const byId = new Map(union.map((r) => [r.obligation_id, r]));
      ok(byId.get(expense.id).classification === 'gasto' && Number(byId.get(expense.id).available_amount) === 0, 'gasto pagado → disponible $0, clasificación=gasto');
      ok(byId.get(commitment.id).classification === 'compromiso_financiero' && Number(byId.get(commitment.id).available_amount) === 50000, 'compromiso sin tocar → disponible = $50,000');
      ok(byId.get(supplierObl.id).beneficiary === supplier.name, 'proveedor: beneficiary resuelto desde catalog.suppliers (join)');

      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const [after] = await knex('budget.expense_obligations').where({ concept: 'Renta CEDIS septiembre' }).count('* as n');
    ok(Number(after.n) === 0, 'rollback: 0 filas persistidas (no ensucia la data real)');

    console.log(`\nTP payment-calendar: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('ERROR:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  }
})();
