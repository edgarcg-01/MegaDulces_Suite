/**
 * Migración: commercial.customer_360 — feature store por customer (Fase M, Sprint M.0).
 *
 * 1 row por (tenant_id, customer_id) — UPSERT en cada cómputo (cron nightly + on-demand).
 * Es la "telemetría" del cliente de la que leen el Motor de Decisión (NBA), el agente
 * y las superficies. NO toca dinero — solo deriva métricas de commercial.orders.
 *
 * Métricas (todas derivadas de orders confirmed/fulfilled):
 *   - orders_count, first_order_at, last_order_at, recency_days
 *   - frequency_90d, monetary_90d, aov
 *   - cadence_days  → mediana de días entre pedidos (percentile_cont 0.5); null si <3 pedidos
 *   - next_order_estimate → last_order_at + cadence_days
 *   - lifecycle_stage → new / active / at_risk / lost (reactivated reservado, no se emite en v1)
 *
 * RLS forzado (mismo patrón que recommended_baskets). Refresh via cron + endpoint manual.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('customer_360');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('customer_360', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('customer_id').notNullable();

    table.integer('orders_count').notNullable().defaultTo(0);
    table.timestamp('first_order_at').nullable();
    table.timestamp('last_order_at').nullable();
    table.integer('recency_days').nullable();
    table.integer('frequency_90d').notNullable().defaultTo(0);
    table.decimal('monetary_90d', 14, 2).notNullable().defaultTo(0);
    table.decimal('aov', 14, 2).notNullable().defaultTo(0);
    table.decimal('cadence_days', 8, 2).nullable();
    table.date('next_order_estimate').nullable();
    table.string('lifecycle_stage', 20).notNullable().defaultTo('new');

    table.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.primary('id');
    table.unique(['tenant_id', 'customer_id'], {
      indexName: 'commercial_customer_360_customer_unique',
    });
    table.index('tenant_id', 'idx_commercial_customer_360_tenant');
    table.index(['tenant_id', 'lifecycle_stage'], 'idx_commercial_customer_360_tenant_stage');
    table.index(['tenant_id', 'next_order_estimate'], 'idx_commercial_customer_360_tenant_next_order');
  });

  await knex.raw(`
    ALTER TABLE commercial.customer_360
      ADD CONSTRAINT chk_commercial_customer_360_stage
      CHECK (lifecycle_stage IN ('new', 'active', 'at_risk', 'lost', 'reactivated'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.customer_360
      ADD CONSTRAINT fk_commercial_customer_360_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.customer_360
      ADD CONSTRAINT fk_commercial_customer_360_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.customer_360 ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.customer_360 FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.customer_360
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.customer_360 TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.customer_360 IS 'Feature store por customer (Fase M). 1 row UPSERT por customer. RFM + cadencia + lifecycle_stage + next_order_estimate derivados de commercial.orders. Refresh via cron o manual. No toca dinero.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('customer_360');
};
