/**
 * Migración: commercial.stock + commercial.stock_movements.
 *
 * stock           — saldo actual por (warehouse, product). UNIQUE composite.
 * stock_movements — bitácora append-only de cada movimiento de inventario.
 *                   El trigger podría mantener stock.quantity sincronizado,
 *                   pero por ahora lo manejamos a nivel servicio (más visible
 *                   en debugging y reportes). Si después aparece corrupción
 *                   por concurrencia, agregar trigger.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // commercial.stock — saldo de inventario por (warehouse, product)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('stock', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('warehouse_id').notNullable();
    table.uuid('product_id').notNullable();
    table.decimal('quantity', 14, 3).notNullable().defaultTo(0); // 3 decimales para fraccionables
    table.decimal('reserved_quantity', 14, 3).notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'warehouse_id', 'product_id'], { indexName: 'commercial_stock_wh_product_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_stock_tenant_id_composite' });

    table.check('?? >= 0', ['quantity'], 'commercial_stock_quantity_nonneg');
    table.check('?? >= 0', ['reserved_quantity'], 'commercial_stock_reserved_nonneg');
    table.check('?? >= ??', ['quantity', 'reserved_quantity'], 'commercial_stock_quantity_ge_reserved');

    table.index('tenant_id', 'idx_commercial_stock_tenant');
    table.index(['tenant_id', 'warehouse_id'], 'idx_commercial_stock_tenant_warehouse');
    table.index(['tenant_id', 'product_id'], 'idx_commercial_stock_tenant_product');
  });

  await knex.raw(`
    ALTER TABLE commercial.stock
      ADD CONSTRAINT fk_commercial_stock_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock
      ADD CONSTRAINT fk_commercial_stock_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock
      ADD CONSTRAINT fk_commercial_stock_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // commercial.stock_movements — bitácora append-only
  // types: 'in' (entrada), 'out' (salida), 'adjust' (ajuste manual),
  //        'reserve' (reserva por pedido), 'release' (cancelación reserva),
  //        'sale' (consumo de reserva al fulfillment)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('stock_movements', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('warehouse_id').notNullable();
    table.uuid('product_id').notNullable();
    table.string('movement_type', 20).notNullable();
    table.decimal('quantity', 14, 3).notNullable(); // siempre positivo; el tipo define el signo lógico
    table.decimal('quantity_before', 14, 3);
    table.decimal('quantity_after', 14, 3);
    table.string('reference_type', 50); // 'order', 'adjustment', 'transfer', etc.
    table.uuid('reference_id'); // sin FK porque puede apuntar a tablas distintas
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');

    table.primary('id');

    table.check(`?? IN ('in', 'out', 'adjust', 'reserve', 'release', 'sale')`, ['movement_type'], 'commercial_stock_movements_type_valid');
    table.check('?? >= 0', ['quantity'], 'commercial_stock_movements_quantity_nonneg');

    table.index('tenant_id', 'idx_commercial_stock_movements_tenant');
    table.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_stock_movements_wh_product');
    table.index(['tenant_id', 'reference_type', 'reference_id'], 'idx_commercial_stock_movements_reference');
    table.index(['tenant_id', 'created_at'], 'idx_commercial_stock_movements_tenant_date');
  });

  await knex.raw(`
    ALTER TABLE commercial.stock_movements
      ADD CONSTRAINT fk_commercial_stock_movements_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock_movements
      ADD CONSTRAINT fk_commercial_stock_movements_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock_movements
      ADD CONSTRAINT fk_commercial_stock_movements_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
  `);

  // RLS + grants
  for (const t of ['commercial.stock', 'commercial.stock_movements']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.stock, commercial.stock_movements TO app_runtime');

  await knex.raw(`COMMENT ON COLUMN commercial.stock_movements.quantity IS 'Siempre positivo. El signo lógico lo dicta movement_type (in/sale aumenta o disminuye el saldo).'`);
  await knex.raw(`COMMENT ON COLUMN commercial.stock_movements.reference_id IS 'Apunta a la entidad origen (order, adjustment, etc.). Sin FK por ser polimórfico — validar a nivel servicio.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_movements');
  await knex.schema.withSchema('commercial').dropTableIfExists('stock');
};
