/**
 * Fase P2.3 (FEFO / caducidad) — ledger de movimientos por LOTE. Ver ADR-022.
 *
 * `commercial.stock_movements` registra el movimiento a nivel SKU. Esta tabla lo
 * hace a nivel LOTE: qué lote (lot_code + expiry_date) se consumió, cuánto, y por
 * qué referencia (order). Habilita **trazabilidad para retiros**: "¿qué pedidos
 * consumieron el lote X?" y "¿de qué lotes salió el pedido Y?".
 *
 * Se llena en `OrderStockService.consume` por diff before/after de stock_lots (el
 * trigger hace el decremento FEFO real; acá se observa y se registra con la ref).
 * Append-only. RLS forzado + grant app_runtime. FKs compuestas a tablas reales.
 *
 * Alcance P2.3 = VENTAS (consume). Recepciones ya quedan en stock_lots.received_at;
 * ajustes/reconcile a nivel lote = extensión futura.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('stock_lot_movements')) return;

  await knex.schema.withSchema('commercial').createTable('stock_lot_movements', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.uuid('product_id').notNullable();
    t.string('lot_code', 60).notNullable();
    t.date('expiry_date'); // snapshot del lote (null = sin caducidad)
    t.string('movement_type', 20).notNullable(); // 'sale' (P2.3); extensible
    t.decimal('quantity', 14, 3).notNullable(); // cantidad consumida de este lote (positiva)
    t.string('reference_type', 40);
    t.uuid('reference_id');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');

    t.primary('id');
    t.check('?? > 0', ['quantity'], 'commercial_stock_lot_movements_qty_pos');

    t.index(['tenant_id', 'lot_code'], 'idx_commercial_slm_lot');           // recall por lote
    t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_slm_whp');
    t.index(['tenant_id', 'reference_type', 'reference_id'], 'idx_commercial_slm_ref'); // lotes de un pedido
  });

  await knex.raw(`
    ALTER TABLE commercial.stock_lot_movements
      ADD CONSTRAINT fk_commercial_slm_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock_lot_movements
      ADD CONSTRAINT fk_commercial_slm_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock_lot_movements
      ADD CONSTRAINT fk_commercial_slm_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.stock_lot_movements ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.stock_lot_movements FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.stock_lot_movements`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.stock_lot_movements
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT ON commercial.stock_lot_movements TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.stock_lot_movements IS 'Ledger de movimientos por lote (FEFO/trazabilidad, ADR-022 P2.3). Registra qué lote consumió cada venta (diff before/after de stock_lots en consume). Append-only.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_lot_movements');
};
