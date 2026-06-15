/**
 * Thot (ADR-018) — feature store: presencia en PdV desde capturas de Trade.
 *
 * `intelligence.pdv_presence` proyecta `daily_captures.exhibiciones.productosMarcados`
 * (señal de EJECUCIÓN/qué exhibe físicamente el PdV) al nivel cliente, uniendo
 * `commercial.customers.store_id → daily_captures.store_id`. Thot la consume como
 * una señal más:
 *   - whitespace : zona compra el producto (zone_demand) y el PdV NO lo exhibe (presence=0).
 *   - recompra   : el PdV ya lo exhibe (presence>0) → reabasto de baja fricción.
 *
 * Comparte DATO con Trade (no código) — la construye un job offline, igual que
 * zone_demand/product_affinity. tenant_id + RLS forzado + grants app_runtime.
 * El compute escribe con el user postgres (bypassa RLS). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS intelligence`);
  await knex.raw(`GRANT USAGE ON SCHEMA intelligence TO app_runtime`);

  const has = await knex.schema.withSchema('intelligence').hasTable('pdv_presence');
  if (!has) {
    await knex.schema.withSchema('intelligence').createTable('pdv_presence', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('customer_id').notNullable(); // cliente con tienda ligada (customers.store_id)
      t.uuid('product_id').notNullable();
      t.integer('marks').notNullable().defaultTo(0); // veces marcado en exhibiciones
      t.integer('capture_count').notNullable().defaultTo(0); // en cuántas visitas apareció
      t.timestamp('last_seen', { useTz: true }); // fecha de la última visita donde apareció
      t.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary('id');
      t.unique(['tenant_id', 'customer_id', 'product_id'], { indexName: 'uq_pdv_presence' });
      t.index(['tenant_id', 'customer_id'], 'idx_pdv_presence_customer');
    });
    await knex.raw(`ALTER TABLE intelligence.pdv_presence ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE intelligence.pdv_presence FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON intelligence.pdv_presence
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.pdv_presence TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('intelligence').dropTableIfExists('pdv_presence');
};
