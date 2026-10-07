/**
 * Thot (ADR-018) — feature store del motor de inteligencia. Rebanada T.1.
 *
 * Schema `intelligence.*` con 2 tablas precomputadas por cron desde el ERP:
 *   - product_affinity  : market-basket dirigido (A→B) con co_count/support/confidence/lift.
 *                         "Quien compra A también compra B" → driver de "completá la canasta".
 *   - zone_demand       : demanda por zona (units/revenue/demand_index 0..1) → zona-fit.
 *
 * Ambas: tenant_id + RLS forzado + grants app_runtime (lectura runtime via TenantKnexService).
 * El compute escribe con el user postgres (bypassa RLS). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS intelligence`);
  await knex.raw(`GRANT USAGE ON SCHEMA intelligence TO app_runtime`);

  const hasAff = await knex.schema.withSchema('intelligence').hasTable('product_affinity');
  if (!hasAff) {
    await knex.schema.withSchema('intelligence').createTable('product_affinity', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('product_a').notNullable(); // si está en el carrito/habitual...
      t.uuid('product_b').notNullable(); // ...sugerí B
      t.integer('co_count').notNullable().defaultTo(0);
      t.decimal('support', 10, 6);
      t.decimal('confidence', 10, 6); // P(B | A)
      t.decimal('lift', 10, 4); // >1 = asociación real
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary('id');
      t.unique(['tenant_id', 'product_a', 'product_b'], { indexName: 'uq_affinity_pair' });
      t.index(['tenant_id', 'product_a', 'lift'], 'idx_affinity_lookup');
    });
    await knex.raw(`ALTER TABLE intelligence.product_affinity ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE intelligence.product_affinity FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON intelligence.product_affinity
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.product_affinity TO app_runtime`);
  }

  const hasZone = await knex.schema.withSchema('intelligence').hasTable('zone_demand');
  if (!hasZone) {
    await knex.schema.withSchema('intelligence').createTable('zone_demand', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('zona', 100).notNullable();
      t.uuid('product_id').notNullable();
      t.decimal('units', 16, 2);
      t.decimal('revenue', 16, 2);
      t.decimal('demand_index', 6, 4); // 0..1 normalizado dentro de la zona
      t.integer('rank'); // 1..N por unidades dentro de la zona
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary('id');
      t.unique(['tenant_id', 'zona', 'product_id'], { indexName: 'uq_zone_demand' });
      t.index(['tenant_id', 'zona', 'demand_index'], 'idx_zone_demand_lookup');
      t.index(['tenant_id', 'product_id'], 'idx_zone_demand_product');
    });
    await knex.raw(`ALTER TABLE intelligence.zone_demand ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE intelligence.zone_demand FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON intelligence.zone_demand
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.zone_demand TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('intelligence').dropTableIfExists('product_affinity');
  await knex.schema.withSchema('intelligence').dropTableIfExists('zone_demand');
  // No drop schema: puede albergar más features de Thot.
};
