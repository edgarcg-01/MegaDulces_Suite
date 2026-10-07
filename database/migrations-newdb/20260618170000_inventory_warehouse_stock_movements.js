/**
 * Fase I.5 (P1/A3) — ledger de movimientos para el inventario por SKU.
 *
 * `commercial.stock_movements` es por `product_id` (UUID, NOT NULL + FK a
 * catalog.products), así que NO sirve para el mundo `inventory.*` (por sku, sin
 * UUID). La reconciliación de un folio en modo `inventory` ajustaba
 * `inventory.warehouse_stock` SIN dejar bitácora → ajuste no auditable.
 *
 * Esta tabla es el espejo por-SKU de `commercial.stock_movements`: trazabilidad
 * append-only de cada cambio al saldo de `inventory.warehouse_stock`.
 *
 * Aditivo e idempotente. Multi-tenant + RLS forzado + grant app_runtime
 * (igual que el resto de inventory.warehouse_stock).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('inventory').hasTable('warehouse_stock_movements')) return;

  await knex.schema.withSchema('inventory').createTable('warehouse_stock_movements', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.string('sku', 40).notNullable();
    t.string('movement_type', 20).notNullable(); // 'adjust' | 'in' | 'out'
    t.decimal('quantity', 14, 3).notNullable(); // siempre positivo; el signo lo dicta el tipo
    t.decimal('quantity_before', 14, 3);
    t.decimal('quantity_after', 14, 3);
    t.string('reference_type', 50); // 'inventory_count', etc.
    t.uuid('reference_id'); // sin FK (polimórfico)
    t.text('notes');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');

    t.primary('id');
    t.check(`?? IN ('in','out','adjust')`, ['movement_type'], 'inventory_wh_stock_mov_type_valid');
    t.check('?? >= 0', ['quantity'], 'inventory_wh_stock_mov_qty_nonneg');

    t.index(['tenant_id', 'warehouse_id', 'sku'], 'idx_inventory_wh_stock_mov_wh_sku');
    t.index(['tenant_id', 'reference_type', 'reference_id'], 'idx_inventory_wh_stock_mov_ref');
    t.index(['tenant_id', 'created_at'], 'idx_inventory_wh_stock_mov_date');
  });

  await knex.raw(`ALTER TABLE inventory.warehouse_stock_movements ADD CONSTRAINT fk_inv_wh_stock_mov_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock_movements ADD CONSTRAINT fk_inv_wh_stock_mov_warehouse FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id) ON DELETE CASCADE`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock_movements ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE inventory.warehouse_stock_movements FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON inventory.warehouse_stock_movements`);
  await knex.raw(`CREATE POLICY tenant_isolation ON inventory.warehouse_stock_movements USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.warehouse_stock_movements TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE inventory.warehouse_stock_movements IS 'Bitácora append-only del saldo inventory.warehouse_stock (por sku). Espejo de commercial.stock_movements para el mundo inventory. Poblado por la reconciliación de folios en modo inventory.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('inventory').dropTableIfExists('warehouse_stock_movements');
};
