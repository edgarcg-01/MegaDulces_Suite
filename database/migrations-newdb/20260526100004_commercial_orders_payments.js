/**
 * Migración: commercial.orders + order_lines + payments.
 *
 * Beta = pago solo EFECTIVO. CHECK constraint en payment_method y orders
 * restringe a 'cash'. Cuando se agreguen otros métodos se modifica el CHECK
 * (drop + recreate) o se reemplaza por tabla `payment_methods` catalogable.
 *
 * Estados del pedido:
 *   draft        — borrador editable
 *   confirmed    — confirmado, stock reservado
 *   fulfilled    — entregado, stock consumido
 *   cancelled    — cancelado, reservas liberadas
 *
 * Totales: se calculan en servicio (sum order_lines.line_total).
 * Se persisten en orders para queries de reportes sin agregaciones costosas.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // commercial.orders — pedidos B2B
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('orders', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('code', 30).notNullable(); // secuencial humano: "PD-2026-00001"
    table.uuid('customer_id').notNullable();
    table.uuid('user_id').notNullable(); // vendedor que tomó el pedido
    table.uuid('warehouse_id').notNullable();
    table.uuid('price_list_id'); // snapshot de la lista usada
    table.string('status', 20).notNullable().defaultTo('draft');
    table.string('payment_method', 20).notNullable().defaultTo('cash');
    table.decimal('subtotal', 14, 2).notNullable().defaultTo(0);
    table.decimal('tax_total', 14, 2).notNullable().defaultTo(0);
    table.decimal('total', 14, 2).notNullable().defaultTo(0);
    table.decimal('paid_amount', 14, 2).notNullable().defaultTo(0);
    table.decimal('balance_due', 14, 2).notNullable().defaultTo(0);
    table.string('currency', 3).notNullable().defaultTo('MXN');
    table.text('notes');
    table.timestamp('confirmed_at');
    table.timestamp('fulfilled_at');
    table.timestamp('cancelled_at');
    table.text('cancellation_reason');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'code'], { indexName: 'commercial_orders_tenant_code_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_orders_tenant_id_composite' });

    table.check(`?? IN ('draft', 'confirmed', 'fulfilled', 'cancelled')`, ['status'], 'commercial_orders_status_valid');
    table.check(`?? IN ('cash')`, ['payment_method'], 'commercial_orders_payment_method_beta_cash_only');
    table.check('?? >= 0', ['subtotal'], 'commercial_orders_subtotal_nonneg');
    table.check('?? >= 0', ['tax_total'], 'commercial_orders_tax_nonneg');
    table.check('?? >= 0', ['total'], 'commercial_orders_total_nonneg');
    table.check('?? >= 0', ['paid_amount'], 'commercial_orders_paid_nonneg');

    table.index('tenant_id', 'idx_commercial_orders_tenant');
    table.index(['tenant_id', 'customer_id'], 'idx_commercial_orders_customer');
    table.index(['tenant_id', 'user_id'], 'idx_commercial_orders_user');
    table.index(['tenant_id', 'status'], 'idx_commercial_orders_status');
    table.index(['tenant_id', 'created_at'], 'idx_commercial_orders_tenant_date');
  });

  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT fk_commercial_orders_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT fk_commercial_orders_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT fk_commercial_orders_user
      FOREIGN KEY (tenant_id, user_id)
      REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT fk_commercial_orders_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT fk_commercial_orders_price_list
      FOREIGN KEY (tenant_id, price_list_id)
      REFERENCES commercial.price_lists(tenant_id, id) ON DELETE SET NULL
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // commercial.order_lines — renglones del pedido
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('order_lines', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('order_id').notNullable();
    table.uuid('product_id').notNullable();
    table.integer('line_number').notNullable(); // orden visual dentro del pedido
    table.decimal('quantity', 14, 3).notNullable();
    table.decimal('unit_price', 14, 4).notNullable(); // snapshot al momento del pedido
    table.decimal('tax_rate', 5, 4).notNullable().defaultTo(0.16);
    table.decimal('discount_percent', 5, 4).notNullable().defaultTo(0);
    table.decimal('line_subtotal', 14, 2).notNullable();
    table.decimal('line_tax', 14, 2).notNullable();
    table.decimal('line_total', 14, 2).notNullable();
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.primary('id');
    table.unique(['tenant_id', 'order_id', 'line_number'], { indexName: 'commercial_order_lines_order_line_unique' });

    table.check('?? > 0', ['quantity'], 'commercial_order_lines_quantity_positive');
    table.check('?? >= 0', ['unit_price'], 'commercial_order_lines_unit_price_nonneg');
    table.check('?? >= 0 AND ?? <= 1', ['discount_percent', 'discount_percent'], 'commercial_order_lines_discount_range');

    table.index('tenant_id', 'idx_commercial_order_lines_tenant');
    table.index(['tenant_id', 'order_id'], 'idx_commercial_order_lines_order');
    table.index(['tenant_id', 'product_id'], 'idx_commercial_order_lines_product');
  });

  await knex.raw(`
    ALTER TABLE commercial.order_lines
      ADD CONSTRAINT fk_commercial_order_lines_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.order_lines
      ADD CONSTRAINT fk_commercial_order_lines_order
      FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE commercial.order_lines
      ADD CONSTRAINT fk_commercial_order_lines_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // commercial.payments — cobros aplicados a un pedido (beta = cash only)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('payments', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('order_id').notNullable();
    table.uuid('customer_id').notNullable();
    table.decimal('amount', 14, 2).notNullable();
    table.string('payment_method', 20).notNullable().defaultTo('cash');
    table.string('reference', 100); // folio de comprobante, número de transferencia, etc.
    table.uuid('received_by').notNullable(); // user_id cajero/vendedor
    table.timestamp('received_at').notNullable().defaultTo(knex.fn.now());
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_payments_tenant_id_composite' });

    table.check(`?? IN ('cash')`, ['payment_method'], 'commercial_payments_method_beta_cash_only');
    table.check('?? > 0', ['amount'], 'commercial_payments_amount_positive');

    table.index('tenant_id', 'idx_commercial_payments_tenant');
    table.index(['tenant_id', 'order_id'], 'idx_commercial_payments_order');
    table.index(['tenant_id', 'customer_id'], 'idx_commercial_payments_customer');
    table.index(['tenant_id', 'received_at'], 'idx_commercial_payments_tenant_date');
  });

  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT fk_commercial_payments_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT fk_commercial_payments_order
      FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT fk_commercial_payments_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT fk_commercial_payments_received_by
      FOREIGN KEY (tenant_id, received_by)
      REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
  `);

  // RLS + grants
  for (const t of ['commercial.orders', 'commercial.order_lines', 'commercial.payments']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.orders, commercial.order_lines, commercial.payments TO app_runtime');

  await knex.raw(`COMMENT ON CONSTRAINT commercial_orders_payment_method_beta_cash_only ON commercial.orders IS 'Beta only cash. Cuando se agreguen otros métodos: ALTER TABLE ... DROP CONSTRAINT y recrear con la nueva lista o reemplazar por tabla payment_methods.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.orders.balance_due IS 'total - paid_amount. Se actualiza al insertar/borrar payments (a nivel servicio o trigger futuro).'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('payments');
  await knex.schema.withSchema('commercial').dropTableIfExists('order_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('orders');
};
