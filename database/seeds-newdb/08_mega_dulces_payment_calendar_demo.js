/**
 * Fase TP (ADR-064) — Calendario de Pagos: seed de EJEMPLO/DEMO de 90 días.
 *
 * Puebla los 3 orígenes de obligación (Presupuestos/Finanzas/Compras), la capacidad diaria
 * (con un par de incidencias a propósito) y una mezcla real de pagos en TODOS los estados que
 * la pantalla sabe mostrar, para poder visualizar el módulo sin esperar captura manual:
 *
 *   - Capacidad: 90 días (hoy-30 .. hoy+59), 2 días SIN capacidad definida (NULL≠0, a propósito),
 *     1 día con capacidad reducida para que el consumo la EXCEDA (banner de incidencia), y 1
 *     ajuste posterior de capacidad (historial con 2 filas).
 *   - 12 gastos autorizados (Presupuestos), 8 compromisos financieros (Finanzas) y ~16
 *     obligaciones a PROVEEDORES REALES del catálogo (Compras — no se inventan proveedores).
 *   - Pagos: ejecutados (con método variado), uno fallido, uno agrupando 2 obligaciones (un pago
 *     cubre varias facturas), uno parcializado en 2 fechas (una factura en 2 pagos), uno
 *     reprogramado (cancela+recrea, conserva lineage), varios pendientes sin preparar, y una
 *     buena porción de obligaciones sin asignar (para que "Obligaciones disponibles" tenga qué
 *     mostrar). `reserved_amount`/`paid_amount`/`status` de cada obligación se RECALCULAN igual
 *     que `PaymentCalendarService.recalcObligation` — nunca a mano.
 *
 * Idempotente: todo fila lleva `created_by = 'seed:payment-calendar-demo'`; si ya existe al menos
 * una, el seed no hace nada (border a border-re-correr no duplica). Para re-sembrar, borrar antes
 * las filas con ese `created_by` en las 3 tablas de origen (cascada arrastra lotes/allocations).
 *
 * @param { import("knex").Knex } knex
 */
const TENANT_ID = '00000000-0000-0000-0000-00000000d01c';
const SEED_TAG = 'seed:payment-calendar-demo';

const TABLE_BY_SOURCE = {
  budget_expense: 'budget.expense_obligations',
  financial_commitment: 'finance.financial_commitments',
  supplier_payable: 'commercial.supplier_payment_obligations',
};

exports.seed = async function (knex) {
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${TENANT_ID}'`);

    const already = await trx('budget.expense_obligations').where({ tenant_id: TENANT_ID, created_by: SEED_TAG }).first('id');
    if (already) {
      console.log('[08_payment_calendar_demo] ya sembrado — nada que hacer (borra las filas con created_by = seed:payment-calendar-demo en budget.expense_obligations/finance.financial_commitments/commercial.supplier_payment_obligations para re-sembrar).');
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dateAt = (offset) => { const d = new Date(today); d.setDate(d.getDate() + offset); return d.toISOString().slice(0, 10); };
    const dowAt = (offset) => { const d = new Date(today); d.setDate(d.getDate() + offset); return d.getDay(); };
    const tsAt = (offset, hour) => new Date(`${dateAt(offset)}T${String(hour).padStart(2, '0')}:00:00`);

    // ── 1) Capacidad diaria (90 días: hoy-30 .. hoy+59) ──────────────────────────────────
    const START = -30, END = 59;
    const DOW_CAPACITY = [40000, 180000, 260000, 150000, 320000, 220000, 60000]; // dom..sáb
    const NO_CAPACITY_OFFSETS = new Set([25, 52]); // "no definida" a propósito (NULL ≠ 0)
    const LOW_CAPACITY_OFFSET = 10; // capacidad reducida a propósito → se excede con los pagos de abajo
    const BUMP_OFFSET = 5; // ejemplo de ajuste posterior (historial con 2 filas)

    let capDays = 0;
    for (let o = START; o <= END; o++) {
      if (NO_CAPACITY_OFFSETS.has(o)) continue;
      let amount = DOW_CAPACITY[dowAt(o)];
      if (o === LOW_CAPACITY_OFFSET) amount = 20000;
      await trx('budget.daily_capacity')
        .insert({ tenant_id: TENANT_ID, capacity_date: dateAt(o), authorized_amount: amount, created_by: SEED_TAG, updated_by: SEED_TAG })
        .onConflict(['tenant_id', 'capacity_date']).merge({ authorized_amount: amount, updated_by: SEED_TAG, updated_at: trx.fn.now() });
      await trx('budget.daily_capacity_history').insert({
        tenant_id: TENANT_ID, capacity_date: dateAt(o), previous_amount: null, new_amount: amount,
        reason: o === LOW_CAPACITY_OFFSET ? 'Capacidad reducida por temporada baja (demo — a propósito se excede)' : 'Alta inicial (seed demo)',
        changed_by: SEED_TAG,
      });
      capDays++;
    }
    // Ajuste posterior de capacidad (Presupuestos amplía por temporada alta) — historial 2 filas.
    const bumpPrev = DOW_CAPACITY[dowAt(BUMP_OFFSET)];
    await trx('budget.daily_capacity').where({ tenant_id: TENANT_ID, capacity_date: dateAt(BUMP_OFFSET) })
      .update({ authorized_amount: 400000, note: 'Se amplía por temporada alta (demo)', updated_by: SEED_TAG, updated_at: trx.fn.now() });
    await trx('budget.daily_capacity_history').insert({
      tenant_id: TENANT_ID, capacity_date: dateAt(BUMP_OFFSET), previous_amount: bumpPrev, new_amount: 400000,
      reason: 'Se amplía por temporada alta (demo)', changed_by: SEED_TAG,
    });
    console.log(`[08_payment_calendar_demo] capacidad: ${capDays} días definidos, ${NO_CAPACITY_OFFSETS.size} sin definir (a propósito), 1 reducida (día +${LOW_CAPACITY_OFFSET}, para exceder), 1 con ajuste posterior (día +${BUMP_OFFSET}).`);

    // ── 2) Gastos autorizados (Presupuestos) ─────────────────────────────────────────────
    const expenseSeeds = [
      { concept: 'Renta CEDIS', beneficiary: 'Arrendadora Bodegas del Bajío SA', area: 'CEDIS', subtype: 'renta', amount: 45000, due: 3 },
      { concept: 'Luz CEDIS', beneficiary: 'CFE Suministro Básico', area: 'CEDIS', subtype: 'luz', amount: 18500, due: 3 },
      { concept: 'Luz Sucursal Centro', beneficiary: 'CFE Suministro Básico', area: 'Sucursal Centro', subtype: 'luz', amount: 9200, due: 10 },
      { concept: 'Nómina quincenal', beneficiary: 'Nómina Mega Dulces', area: 'General', subtype: 'sueldos', amount: 620000, due: 14, critical: 'No se puede retrasar el pago de nómina' },
      { concept: 'Comisiones vendedores', beneficiary: 'Nómina Mega Dulces', area: 'Ventas', subtype: 'comisiones', amount: 84300, due: 5 },
      { concept: 'Internet y telefonía', beneficiary: 'Telmex Empresarial', area: 'CEDIS', subtype: 'operativo', amount: 6750, due: 18 },
      { concept: 'Mantenimiento de flotilla', beneficiary: 'Taller Mecánico Reyes', area: 'Logística', subtype: 'operativo', amount: 32400, due: 22 },
      { concept: 'Seguro de flotilla (anual)', beneficiary: 'Aseguradora GNP', area: 'Logística', subtype: 'otro', amount: 145000, due: 40, critical: 'Vence la póliza — sin seguro la flotilla no puede operar' },
      { concept: 'Renta bodega Guadalajara', beneficiary: 'Inmobiliaria Jalisco SA', area: 'Sucursal GDL', subtype: 'renta', amount: 28000, due: 33 },
      { concept: 'Papelería y consumibles', beneficiary: 'Office Depot', area: 'General', subtype: 'operativo', amount: 4100, due: 48 },
      { concept: 'Nómina quincenal', beneficiary: 'Nómina Mega Dulces', area: 'General', subtype: 'sueldos', amount: 615000, due: 28, critical: 'No se puede retrasar el pago de nómina' },
      { concept: 'Publicidad digital', beneficiary: 'Meta Ads', area: 'Mercadotecnia', subtype: 'operativo', amount: 22000, due: 55 },
    ];
    const expenses = [];
    for (const e of expenseSeeds) {
      const [row] = await trx('budget.expense_obligations').insert({
        tenant_id: TENANT_ID, concept: e.concept, beneficiary: e.beneficiary, area: e.area, subtype: e.subtype,
        original_amount: e.amount, original_due_date: dateAt(e.due), is_critical: !!e.critical, critical_reason: e.critical || null,
        authorized_by: SEED_TAG, created_by: SEED_TAG,
      }).returning('*');
      expenses.push(row);
    }

    // ── 3) Compromisos financieros (Finanzas) ────────────────────────────────────────────
    const commitmentSeeds = [
      { concept: 'Factoraje semanal', beneficiary: 'Fondeadora XYZ Factoraje', subtype: 'factoraje', amount: 210000, due: 2 },
      { concept: 'Interés crédito puente', beneficiary: 'BanBajío Empresarial', subtype: 'interes', amount: 38700, due: 6 },
      { concept: 'Amortización crédito simple', beneficiary: 'BanBajío Empresarial', subtype: 'amortizacion', amount: 95000, due: 12 },
      { concept: 'Factoraje semanal', beneficiary: 'Fondeadora XYZ Factoraje', subtype: 'factoraje', amount: 198500, due: 9 },
      { concept: 'Interés tarjeta empresarial', beneficiary: 'Banorte Empresarial', subtype: 'interes', amount: 14200, due: 20, critical: 'Penalización alta por atraso' },
      { concept: 'Amortización arrendamiento financiero', beneficiary: 'Arrendadora de Flotillas SA', subtype: 'amortizacion', amount: 67000, due: 35 },
      { concept: 'Comisión línea de crédito', beneficiary: 'BanBajío Empresarial', subtype: 'otro', amount: 11000, due: 42 },
      { concept: 'Factoraje semanal', beneficiary: 'Fondeadora XYZ Factoraje', subtype: 'factoraje', amount: 205000, due: 16 },
    ];
    const commitments = [];
    for (const c of commitmentSeeds) {
      const [row] = await trx('finance.financial_commitments').insert({
        tenant_id: TENANT_ID, concept: c.concept, beneficiary: c.beneficiary, subtype: c.subtype,
        original_amount: c.amount, original_due_date: dateAt(c.due), is_critical: !!c.critical, critical_reason: c.critical || null,
        authorized_by: SEED_TAG, created_by: SEED_TAG,
      }).returning('*');
      commitments.push(row);
    }

    // ── 4) Obligaciones a proveedor (Compras) — proveedores REALES, no se inventan ───────
    const suppliers = await trx('catalog.suppliers').where({ tenant_id: TENANT_ID, activo: true }).whereNull('deleted_at').orderBy('name').limit(10);
    const supplierObligations = [];
    if (suppliers.length === 0) {
      console.warn('[08_payment_calendar_demo] sin proveedores activos en catalog.suppliers — se saltan las obligaciones a proveedor.');
    } else {
      const dueOffsets = [-20, -16, -12, -8, -4, -1, 2, 6, 10, 14, 18, 22, 26, 30, 36, 44];
      const concepts = ['Compra de dulces surtidos', 'Reposición de inventario', 'Mercancía de temporada', 'Pedido consolidado del mes'];
      for (let i = 0; i < dueOffsets.length; i++) {
        const supplier = suppliers[i % suppliers.length];
        const amount = 8000 + ((i * 3700) % 55000);
        const [row] = await trx('commercial.supplier_payment_obligations').insert({
          tenant_id: TENANT_ID, supplier_id: supplier.id, invoice_folio: `F-DEMO-${1000 + i}`,
          concept: concepts[i % concepts.length], original_amount: amount, original_due_date: dateAt(dueOffsets[i]),
          authorized_by: SEED_TAG, created_by: SEED_TAG,
        }).returning('*');
        row.supplier_name = supplier.name;
        supplierObligations.push(row);
      }
    }
    console.log(`[08_payment_calendar_demo] obligaciones creadas: ${expenses.length} gastos, ${commitments.length} compromisos, ${supplierObligations.length} a proveedor.`);

    // ── 5) Motor de asignación: lotes + pagos + items (misma lógica que el servicio) ──────
    async function recalcObligation(source, id) {
      const table = TABLE_BY_SOURCE[source];
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
    }
    async function getOrCreateLot(date) {
      let lot = await trx('finance.payment_calendar_lots').where({ tenant_id: TENANT_ID, lot_date: date }).first();
      if (!lot) [lot] = await trx('finance.payment_calendar_lots').insert({ tenant_id: TENANT_ID, lot_date: date }).returning('*');
      return lot;
    }
    async function createAllocation(date, classification, items, opts = {}) {
      const lot = await getOrCreateLot(date);
      const amount = items.reduce((s, it) => s + it.applied_amount, 0);
      const [alloc] = await trx('finance.payment_allocations').insert({
        tenant_id: TENANT_ID, lot_id: lot.id, classification, amount_assigned: amount,
        status: opts.status || 'pending', payment_method: opts.payment_method || null,
        destination_account_text: opts.destination || null, reference_text: opts.reference || null,
        cash_register_text: opts.cash || null, executed_at: opts.executedAt || null,
        failure_reason: opts.failureReason || null, notes: opts.notes || null,
        reprogrammed_from_id: opts.reprogrammedFromId || null, created_by: SEED_TAG,
      }).returning('*');
      for (const it of items) {
        await trx('finance.payment_allocation_items').insert({ tenant_id: TENANT_ID, allocation_id: alloc.id, obligation_source: it.source, obligation_id: it.id, applied_amount: it.applied_amount });
      }
      for (const it of items) await recalcObligation(it.source, it.id);
      return alloc;
    }
    const item = (obligation, source, amount) => ({ id: obligation.id, source, applied_amount: amount ?? Number(obligation.original_amount) });

    let allocCount = 0;
    // 5a. Ejecutados (método variado) — obligaciones con vencimiento en el pasado.
    if (supplierObligations[0]) { await createAllocation(dateAt(-18), 'proveedor_mercancia', [item(supplierObligations[0], 'supplier_payable')], { status: 'executed', payment_method: 'transferencia', destination: 'CLABE 012180001234567890', executedAt: tsAt(-18, 11) }); allocCount++; }
    if (supplierObligations[1]) { await createAllocation(dateAt(-12), 'proveedor_mercancia', [item(supplierObligations[1], 'supplier_payable')], { status: 'executed', payment_method: 'cheque', reference: 'CH-10231', executedAt: tsAt(-12, 10) }); allocCount++; }
    if (commitments[0]) { await createAllocation(dateAt(-9), 'compromiso_financiero', [item(commitments[0], 'financial_commitment')], { status: 'executed', payment_method: 'cargo_automatico', destination: 'CLABE 072180009876543210', executedAt: tsAt(-9, 6) }); allocCount++; }
    if (expenses[1]) { await createAllocation(dateAt(-5), 'gasto', [item(expenses[1], 'budget_expense')], { status: 'executed', payment_method: 'efectivo', cash: 'Caja chica CEDIS', executedAt: tsAt(-5, 16) }); allocCount++; }
    if (supplierObligations[2]) { await createAllocation(dateAt(-4), 'proveedor_mercancia', [item(supplierObligations[2], 'supplier_payable')], { status: 'executed', payment_method: 'transferencia', destination: 'CLABE 012180001234567890', executedAt: tsAt(-4, 9) }); allocCount++; }

    // 5b. Fallidos (NO liquidan; el saldo regresa a revisión).
    if (supplierObligations[3]) { await createAllocation(dateAt(-6), 'proveedor_mercancia', [item(supplierObligations[3], 'supplier_payable')], { status: 'failed', failureReason: 'Cuenta CLABE destino inválida' }); allocCount++; }
    if (expenses[2]) { await createAllocation(dateAt(-1), 'gasto', [item(expenses[2], 'budget_expense')], { status: 'failed', failureReason: 'Rebotó por fondos insuficientes en la cuenta origen' }); allocCount++; }

    // 5c. Un pago agrupa 2 obligaciones (criterio: una sola transferencia cubre varias facturas).
    if (expenses[4] && expenses[5]) {
      await createAllocation(dateAt(3), 'gasto', [item(expenses[4], 'budget_expense', 15000), item(expenses[5], 'budget_expense')], { notes: 'Pago conjunto: adelanto de comisiones + internet/telefonía (demo)' });
      allocCount++;
    }

    // 5d. Una obligación se parcializa en 2 fechas (sin doble-reserva).
    if (supplierObligations[6]) {
      const total = Number(supplierObligations[6].original_amount);
      const half = Math.round(total * 0.6);
      await createAllocation(dateAt(15), 'proveedor_mercancia', [item(supplierObligations[6], 'supplier_payable', half)], { notes: 'Primera parcialidad (60%) — acuerdo con el proveedor' });
      await createAllocation(dateAt(35), 'proveedor_mercancia', [item(supplierObligations[6], 'supplier_payable', total - half)], { notes: 'Segunda parcialidad (40%)' });
      allocCount += 2;
    }

    // 5e. Reprogramado: se cancela el pago original y se recrea en otra fecha (conserva lineage).
    if (supplierObligations[7]) {
      const original = await createAllocation(dateAt(20), 'proveedor_mercancia', [item(supplierObligations[7], 'supplier_payable')], { notes: 'Pago original (antes de reprogramar)' });
      await trx('finance.payment_allocations').where({ id: original.id }).update({ status: 'cancelled', notes: `${original.notes}\n[reprogramado a ${dateAt(27)}]`, updated_by: SEED_TAG, updated_at: trx.fn.now() });
      await recalcObligation('supplier_payable', supplierObligations[7].id);
      const lot2 = await getOrCreateLot(dateAt(27));
      const [reprog] = await trx('finance.payment_allocations').insert({
        tenant_id: TENANT_ID, lot_id: lot2.id, classification: 'proveedor_mercancia',
        amount_assigned: Number(supplierObligations[7].original_amount), reprogrammed_from_id: original.id,
        notes: 'Reprogramado desde una fecha anterior (demo)', created_by: SEED_TAG,
      }).returning('*');
      await trx('finance.payment_allocation_items').insert({ tenant_id: TENANT_ID, allocation_id: reprog.id, obligation_source: 'supplier_payable', obligation_id: supplierObligations[7].id, applied_amount: Number(supplierObligations[7].original_amount) });
      await recalcObligation('supplier_payable', supplierObligations[7].id);
      allocCount += 2;
    }

    // 5f. Excede la capacidad del día +LOW_CAPACITY_OFFSET a propósito (banner de incidencia):
    // 2 pagos SEPARADOS el mismo día ($14,200 + $9,200 = $23,400 > $20,000 de capacidad).
    if (commitments[4]) { await createAllocation(dateAt(LOW_CAPACITY_OFFSET), 'compromiso_financiero', [item(commitments[4], 'financial_commitment')], { notes: 'Demo: junto con el siguiente pago, excede la capacidad reducida del día' }); allocCount++; }
    if (expenses[2]) { await createAllocation(dateAt(LOW_CAPACITY_OFFSET), 'gasto', [item(expenses[2], 'budget_expense')], { notes: 'Demo: segundo intento tras el fallo anterior — este día excede la capacidad' }); allocCount++; }

    // 5g. Pendientes sin preparar (fecha futura, sin banco/método) — el resto de la agenda.
    if (expenses[6]) { await createAllocation(dateAt(22), 'gasto', [item(expenses[6], 'budget_expense')]); allocCount++; }
    if (commitments[5]) { await createAllocation(dateAt(35), 'compromiso_financiero', [item(commitments[5], 'financial_commitment')]); allocCount++; }
    if (supplierObligations[9]) { await createAllocation(dateAt(14), 'proveedor_mercancia', [item(supplierObligations[9], 'supplier_payable')], { payment_method: 'cheque', reference: 'CH-10240', notes: 'Preparado, aún no ejecutado' }); allocCount++; }

    // ── 6) Estados de lote (released/closed) sobre los días ya pagados ───────────────────
    for (const offset of [-18, -12, -9]) {
      const lot = await trx('finance.payment_calendar_lots').where({ tenant_id: TENANT_ID, lot_date: dateAt(offset) }).first();
      if (lot) await trx('finance.payment_calendar_lots').where({ id: lot.id }).update({ status: 'closed', released_by: SEED_TAG, released_at: trx.fn.now(), closed_by: SEED_TAG, closed_at: trx.fn.now() });
    }
    const releasedLot = await trx('finance.payment_calendar_lots').where({ tenant_id: TENANT_ID, lot_date: dateAt(-5) }).first();
    if (releasedLot) await trx('finance.payment_calendar_lots').where({ id: releasedLot.id }).update({ status: 'released', released_by: SEED_TAG, released_at: trx.fn.now() });

    console.log(`[08_payment_calendar_demo] ${allocCount} pagos creados (ejecutados/fallidos/agrupado/parcializado/reprogramado/pendientes). Obligaciones sin asignar quedan disponibles para probar el flujo completo.`);
  });
};
