/**
 * RA.11 + RA.13a + RA.14 — Flujo de compras (apartados faltantes, ADR-030).
 * Espeja la cadena real de Kepler (X-A-30 requisición → X-A-35 OC → X-A-37 vale →
 * X-A-40 orden de entrada [entra al inventario] → X-A-20 aplica/CxP; traspaso = género N).
 *
 *   RA.11  origen de surtido proveedor vs sucursal (traspaso interno, MVP solo clasifica):
 *          purchase_requisitions/_lines += source_type + source_warehouse_id.
 *   RA.13a mínimo de pedido del proveedor EN CAJAS (Kepler no lo trae → manual):
 *          catalog.suppliers.min_order_boxes.
 *   RA.14  flujo post-aprobación approved→ordered→received (espejo cadena Kepler):
 *          estado CHECK += 'received'; ordered_at/by + received_at/by (header);
 *          received_qty + received_at (líneas) → fill rate = received/final.
 *
 * Idempotente (hasColumn / pg_constraint guards). Composite FK (tenant_id, ...).
 *
 * @param { import("knex").Knex } knex
 */

async function addColIfMissing(knex, schema, table, col, ddl) {
  if (!(await knex.schema.withSchema(schema).hasColumn(table, col))) {
    await knex.raw(ddl);
  }
}

async function addConstraintIfMissing(knex, name, ddl) {
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='${name}') THEN
        ${ddl}
      END IF;
    END $$`);
}

exports.up = async function (knex) {
  // ── RA.13a — catalog.suppliers.min_order_boxes ────────────────────────
  await addColIfMissing(knex, 'catalog', 'suppliers', 'min_order_boxes',
    `ALTER TABLE catalog.suppliers ADD COLUMN min_order_boxes numeric(14,3)`);
  await knex.raw(`COMMENT ON COLUMN catalog.suppliers.min_order_boxes IS 'RA.13a — pedido mínimo del proveedor EN CAJAS (unidad de compra). Kepler no lo trae; captura manual. Se compara Σ(final_qty/factor_purchase) por proveedor y solo avisa.'`);

  // ── RA.11 — origen de surtido (proveedor | sucursal) ──────────────────
  for (const table of ['purchase_requisitions', 'purchase_requisition_lines']) {
    await addColIfMissing(knex, 'commercial', table, 'source_type',
      `ALTER TABLE commercial.${table} ADD COLUMN source_type varchar(8) NOT NULL DEFAULT 'supplier' CHECK (source_type IN ('supplier','branch'))`);
    await addColIfMissing(knex, 'commercial', table, 'source_warehouse_id',
      `ALTER TABLE commercial.${table} ADD COLUMN source_warehouse_id uuid`);
    // FK compuesta al almacén origen (traspaso interno). Nullable → no se aplica cuando NULL.
    await addConstraintIfMissing(knex, `fk_${table}_src_wh`,
      `ALTER TABLE commercial.${table} ADD CONSTRAINT fk_${table}_src_wh
         FOREIGN KEY (tenant_id, source_warehouse_id)
         REFERENCES commercial.warehouses (tenant_id, id) ON DELETE RESTRICT;`);
    // branch ⇒ debe indicar almacén origen.
    await addConstraintIfMissing(knex, `chk_${table}_branch_src`,
      `ALTER TABLE commercial.${table} ADD CONSTRAINT chk_${table}_branch_src
         CHECK (source_type <> 'branch' OR source_warehouse_id IS NOT NULL);`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.purchase_requisition_lines.source_type IS 'RA.11 — supplier (compra, cadena Kepler género X) | branch (traspaso interno desde CEDIS, género N). MVP solo clasifica; no genera el movimiento.'`);

  // ── RA.14 — auditoría del flujo post-aprobación ───────────────────────
  await addColIfMissing(knex, 'commercial', 'purchase_requisitions', 'ordered_at',
    `ALTER TABLE commercial.purchase_requisitions ADD COLUMN ordered_at timestamptz`);
  await addColIfMissing(knex, 'commercial', 'purchase_requisitions', 'ordered_by',
    `ALTER TABLE commercial.purchase_requisitions ADD COLUMN ordered_by uuid`);
  await addColIfMissing(knex, 'commercial', 'purchase_requisitions', 'received_at',
    `ALTER TABLE commercial.purchase_requisitions ADD COLUMN received_at timestamptz`);
  await addColIfMissing(knex, 'commercial', 'purchase_requisitions', 'received_by',
    `ALTER TABLE commercial.purchase_requisitions ADD COLUMN received_by uuid`);

  await addColIfMissing(knex, 'commercial', 'purchase_requisition_lines', 'received_qty',
    `ALTER TABLE commercial.purchase_requisition_lines ADD COLUMN received_qty numeric(14,3)`);
  await addColIfMissing(knex, 'commercial', 'purchase_requisition_lines', 'received_at',
    `ALTER TABLE commercial.purchase_requisition_lines ADD COLUMN received_at timestamptz`);

  // estado CHECK += 'received' (el inline CHECK se llama purchase_requisitions_estado_check).
  await knex.raw(`ALTER TABLE commercial.purchase_requisitions DROP CONSTRAINT IF EXISTS purchase_requisitions_estado_check`);
  await addConstraintIfMissing(knex, 'chk_purch_req_estado',
    `ALTER TABLE commercial.purchase_requisitions ADD CONSTRAINT chk_purch_req_estado
       CHECK (estado IN ('draft','pending_approval','approved','ordered','received','cancelled'));`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.purchase_requisitions DROP CONSTRAINT IF EXISTS chk_purch_req_estado`);
  for (const table of ['purchase_requisitions', 'purchase_requisition_lines']) {
    await knex.raw(`ALTER TABLE commercial.${table} DROP CONSTRAINT IF EXISTS chk_${table}_branch_src`);
    await knex.raw(`ALTER TABLE commercial.${table} DROP CONSTRAINT IF EXISTS fk_${table}_src_wh`);
    for (const col of ['source_type', 'source_warehouse_id']) {
      if (await knex.schema.withSchema('commercial').hasColumn(table, col)) {
        await knex.raw(`ALTER TABLE commercial.${table} DROP COLUMN ${col}`);
      }
    }
  }
  for (const col of ['ordered_at', 'ordered_by', 'received_at', 'received_by']) {
    if (await knex.schema.withSchema('commercial').hasColumn('purchase_requisitions', col)) {
      await knex.raw(`ALTER TABLE commercial.purchase_requisitions DROP COLUMN ${col}`);
    }
  }
  for (const col of ['received_qty', 'received_at']) {
    if (await knex.schema.withSchema('commercial').hasColumn('purchase_requisition_lines', col)) {
      await knex.raw(`ALTER TABLE commercial.purchase_requisition_lines DROP COLUMN ${col}`);
    }
  }
  if (await knex.schema.withSchema('catalog').hasColumn('suppliers', 'min_order_boxes')) {
    await knex.raw(`ALTER TABLE catalog.suppliers DROP COLUMN min_order_boxes`);
  }
  // Nota: no se re-crea el CHECK viejo de estado (down deja el estado sin constraint; up lo repone).
};
