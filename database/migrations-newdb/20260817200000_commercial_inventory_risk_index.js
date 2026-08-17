/**
 * Fase PREV.3 — Índice de riesgo de inventario (Apéndice B §14-15).
 *
 * Índice COMPUTADO por (almacén, producto): cuántos expedientes, cuántas pérdidas no
 * identificadas, cuántas pérdidas en monitoreo y el valor de la merma → un score + nivel
 * para DIRIGIR RECURSOS de Prevención. La reincidencia sube el nivel.
 *
 * Principio (Frank §13): NO acusa personas. El eje es SKU/almacén/proceso, nunca colaborador.
 *
 * Tabla derivada (se recalcula por scanner nocturno + endpoint manual). RLS forzado.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('inventory_risk_index')) return;

  await knex.schema.withSchema('commercial').createTable('inventory_risk_index', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.uuid('product_id').notNullable();
    t.integer('investigations_count').notNullable().defaultTo(0);
    t.integer('pni_count').notNullable().defaultTo(0); // pérdidas no identificadas / en monitoreo
    t.integer('monitoring_losses').notNullable().defaultTo(0); // conteos de monitoreo con faltante
    t.decimal('shrink_value', 16, 4).notNullable().defaultTo(0); // Σ|valor| de diferencias negativas
    t.decimal('risk_score', 10, 2).notNullable().defaultTo(0);
    t.string('risk_level', 10).notNullable().defaultTo('bajo'); // bajo | medio | alto | critico
    t.timestamp('last_event_at');
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'id'], { indexName: 'commercial_inv_risk_tenant_id_composite' });
    t.check("?? in ('bajo','medio','alto','critico')", ['risk_level'], 'commercial_inv_risk_level_chk');
    t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_inv_risk_whp');
    t.index(['tenant_id', 'risk_level'], 'idx_commercial_inv_risk_level');
  });

  // Una fila por (almacén, producto).
  await knex.raw(`
    CREATE UNIQUE INDEX commercial_inv_risk_natural_unique
      ON commercial.inventory_risk_index (tenant_id, warehouse_id, product_id)
  `);

  await knex.raw(`
    ALTER TABLE commercial.inventory_risk_index
      ADD CONSTRAINT fk_commercial_inv_risk_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.inventory_risk_index
      ADD CONSTRAINT fk_commercial_inv_risk_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE commercial.inventory_risk_index
      ADD CONSTRAINT fk_commercial_inv_risk_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.inventory_risk_index ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.inventory_risk_index FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_risk_index`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.inventory_risk_index
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_risk_index TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.inventory_risk_index IS 'Índice de riesgo por (almacén,producto) (Fase PREV.3): score+nivel desde expedientes+monitoreo para dirigir Prevención. NO por persona.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_risk_index');
};
