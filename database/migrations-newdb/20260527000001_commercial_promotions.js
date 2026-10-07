/**
 * Migración: commercial.promotions — motor de promociones flexible.
 *
 * Diseño:
 *   - 1 row = 1 promoción configurada por el admin.
 *   - `promotion_type` discrimina los 6 tipos soportados; `rules` JSONB lleva
 *     la config específica de cada tipo (no hay tabla hija por tipo — el shape
 *     del JSON cambia según el tipo, validado en backend).
 *   - Vigencia opcional via `starts_at` / `ends_at`. NULL = sin restricción.
 *   - `priority`: cuando varias promos aplican al mismo pedido, gana la de
 *     priority MENOR (1 > 100). Default 100.
 *   - `applies_to`: 'all_customers' (default) o 'specific_customers' con la
 *     lista en `applies_to_customer_ids` JSONB array.
 *   - `usage_count` / `usage_limit`: cap global opcional para promos limitadas.
 *
 * Auto-apply en pedidos: NO se hace en esta migración (catálogo first; el
 * apply en OrdersService es sprint aparte).
 *
 * Tipos soportados (definidos en backend/frontend, NO CHECK estricto en SQL
 * para permitir agregar tipos sin migrar):
 *   - percent_off_product   : { product_id, percent }
 *   - percent_off_basket    : { percent }
 *   - nxm                   : { product_id, n_buy, m_pay }
 *   - volume_discount       : { product_id, tiers: [{ min_qty, percent }, ...] }
 *   - bundle_fixed_price    : { items: [{ product_id, quantity }, ...], price }
 *   - cross_sell_discount   : { trigger_product_id, target_product_id, percent }
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('commercial').createTable('promotions', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.text('code').notNullable(); // ej: 'NAVIDAD-2026', '2X1-PULPARINDO'
    table.text('name').notNullable();
    table.text('description');
    table.text('promotion_type').notNullable();
    table.jsonb('rules').notNullable(); // config específica del tipo
    table.integer('priority').notNullable().defaultTo(100);
    table.timestamp('starts_at'); // null = sin fecha inicio
    table.timestamp('ends_at'); // null = sin fecha fin
    table.integer('usage_limit'); // null = ilimitado
    table.integer('usage_count').notNullable().defaultTo(0);
    table.decimal('min_order_amount', 12, 2); // null = sin mínimo
    table.text('applies_to').notNullable().defaultTo('all_customers');
    table.jsonb('applies_to_customer_ids'); // null si applies_to='all_customers'
    table.boolean('active').notNullable().defaultTo(true);
    table.uuid('created_by_user_id');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('deleted_at');

    table.primary('id');
    table.unique(['tenant_id', 'code'], { indexName: 'commercial_promotions_code_unique' });

    table.index('tenant_id', 'idx_commercial_promotions_tenant');
    table.index(['tenant_id', 'active', 'starts_at', 'ends_at'], 'idx_commercial_promotions_active_window');
    table.index(['tenant_id', 'promotion_type'], 'idx_commercial_promotions_type');
  });

  await knex.raw(`
    ALTER TABLE commercial.promotions
      ADD CONSTRAINT fk_commercial_promotions_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    ALTER TABLE commercial.promotions
      ADD CONSTRAINT chk_commercial_promotions_type
      CHECK (promotion_type IN (
        'percent_off_product',
        'percent_off_basket',
        'nxm',
        'volume_discount',
        'bundle_fixed_price',
        'cross_sell_discount'
      ))
  `);

  await knex.raw(`
    ALTER TABLE commercial.promotions
      ADD CONSTRAINT chk_commercial_promotions_applies_to
      CHECK (applies_to IN ('all_customers', 'specific_customers'))
  `);

  await knex.raw(`
    ALTER TABLE commercial.promotions
      ADD CONSTRAINT chk_commercial_promotions_window
      CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at)
  `);

  await knex.raw(`
    ALTER TABLE commercial.promotions
      ADD CONSTRAINT chk_commercial_promotions_priority
      CHECK (priority >= 0 AND priority <= 1000)
  `);

  await knex.raw(`ALTER TABLE commercial.promotions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.promotions FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.promotions
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);

  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.promotions TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.promotions IS 'Catálogo de promociones configurables. rules JSONB lleva config específica por promotion_type. usage_count se incrementa al aplicar (futuro).'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('promotions');
};
