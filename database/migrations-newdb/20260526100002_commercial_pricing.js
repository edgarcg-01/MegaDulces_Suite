/**
 * Migración: commercial.price_lists + commercial.product_prices.
 *
 * Estrategia de precios: 1 cliente → 1 lista de precio default (FK en customers).
 * Una lista puede tener N precios (uno por producto). Si un producto no tiene
 * precio en la lista del cliente, se usa el precio base del catálogo o se
 * bloquea el pedido (decisión a nivel API).
 *
 * Al final agregamos la FK que faltaba en customers.default_price_list_id.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // commercial.price_lists — listas de precio (ej. "Mayoreo", "Menudeo", "Cliente Premium")
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('price_lists', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('code', 50).notNullable();
    table.string('name', 200).notNullable();
    table.string('currency', 3).notNullable().defaultTo('MXN');
    table.date('valid_from');
    table.date('valid_to');
    table.boolean('is_default').notNullable().defaultTo(false);
    table.boolean('active').notNullable().defaultTo(true);
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'code'], { indexName: 'commercial_price_lists_tenant_code_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_price_lists_tenant_id_composite' });

    table.index('tenant_id', 'idx_commercial_price_lists_tenant');
    table.index(['tenant_id', 'active'], 'idx_commercial_price_lists_tenant_active');
  });

  await knex.raw(`
    ALTER TABLE commercial.price_lists
      ADD CONSTRAINT fk_commercial_price_lists_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // commercial.product_prices — precio de un producto en una lista
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('product_prices', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('price_list_id').notNullable();
    table.uuid('product_id').notNullable();
    table.decimal('price', 14, 4).notNullable(); // 4 decimales para precios unitarios chicos
    table.decimal('tax_rate', 5, 4).notNullable().defaultTo(0.16); // IVA MX default 16%
    table.integer('min_qty').notNullable().defaultTo(1);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'price_list_id', 'product_id'], { indexName: 'commercial_product_prices_list_product_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_product_prices_tenant_id_composite' });

    table.check('?? >= 0', ['price'], 'commercial_product_prices_price_nonneg');
    table.check('?? >= 0 AND ?? <= 1', ['tax_rate', 'tax_rate'], 'commercial_product_prices_tax_rate_range');
    table.check('?? >= 1', ['min_qty'], 'commercial_product_prices_min_qty_positive');

    table.index('tenant_id', 'idx_commercial_product_prices_tenant');
    table.index(['tenant_id', 'price_list_id'], 'idx_commercial_product_prices_list');
    table.index(['tenant_id', 'product_id'], 'idx_commercial_product_prices_product');
  });

  await knex.raw(`
    ALTER TABLE commercial.product_prices
      ADD CONSTRAINT fk_commercial_product_prices_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.product_prices
      ADD CONSTRAINT fk_commercial_product_prices_list
      FOREIGN KEY (tenant_id, price_list_id)
      REFERENCES commercial.price_lists(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE commercial.product_prices
      ADD CONSTRAINT fk_commercial_product_prices_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES public.products(tenant_id, id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // FK deferida: customers.default_price_list_id → price_lists
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE commercial.customers
      ADD CONSTRAINT fk_commercial_customers_default_price_list
      FOREIGN KEY (tenant_id, default_price_list_id)
      REFERENCES commercial.price_lists(tenant_id, id) ON DELETE SET NULL
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // RLS + grants
  // ─────────────────────────────────────────────────────────────────────────
  for (const t of ['commercial.price_lists', 'commercial.product_prices']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.price_lists, commercial.product_prices TO app_runtime');

  await knex.raw(`COMMENT ON COLUMN commercial.product_prices.tax_rate IS 'Tasa de IVA por producto (0.16 = 16%). Permite manejar productos exentos (0) o tasa cero/preferente.'`);
};

exports.down = async function (knex) {
  await knex.raw('ALTER TABLE commercial.customers DROP CONSTRAINT IF EXISTS fk_commercial_customers_default_price_list');
  await knex.schema.withSchema('commercial').dropTableIfExists('product_prices');
  await knex.schema.withSchema('commercial').dropTableIfExists('price_lists');
};
