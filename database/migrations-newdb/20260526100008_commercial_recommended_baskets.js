/**
 * Migración: commercial.recommended_baskets — canasta estratégica por customer.
 *
 * Modelo:
 *   - 1 row por (tenant_id, customer_id) — UPSERT en cada cómputo.
 *   - `items` JSONB: array de { product_id, category, score, reason, sample_price }.
 *   - `category_counts` JSONB: snapshot rápido sin parsear `items`.
 *   - `computed_at`: timestamp del cómputo (para staleness checks).
 *
 * Categorías (definidas en el service):
 *   - base         — productos que el customer COMPRA regularmente (top SUYOS).
 *   - focus        — productos TOP del tenant que el customer NO compra (oportunidad).
 *   - exploración  — productos de las marcas del customer que aún no probó.
 *   - innovación   — productos creados recientemente sin historia.
 *
 * Refresh: cron + endpoint manual. No usa MV porque los datos varían por
 * customer y queremos UPSERT controlado (no recálculo completo).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('commercial').createTable('recommended_baskets', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('customer_id').notNullable();
    table.jsonb('items').notNullable().defaultTo('[]'); // array de recomendaciones
    table.jsonb('category_counts').notNullable().defaultTo('{}'); // {base: 5, focus: 10, ...}
    table.integer('total_recommendations').notNullable().defaultTo(0);
    table.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.primary('id');
    table.unique(['tenant_id', 'customer_id'], {
      indexName: 'commercial_recommended_baskets_customer_unique',
    });

    table.index('tenant_id', 'idx_commercial_recommended_baskets_tenant');
    table.index(['tenant_id', 'computed_at'], 'idx_commercial_recommended_baskets_tenant_computed');
  });

  await knex.raw(`
    ALTER TABLE commercial.recommended_baskets
      ADD CONSTRAINT fk_commercial_recommended_baskets_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.recommended_baskets
      ADD CONSTRAINT fk_commercial_recommended_baskets_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.recommended_baskets ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.recommended_baskets FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.recommended_baskets
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.recommended_baskets TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.recommended_baskets IS 'Canasta estratégica por customer. 1 row UPSERT por customer. Items JSONB con categoría + score + reason. Refresh via cron o manual.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('recommended_baskets');
};
