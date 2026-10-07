/**
 * Fase ABC.0 — clasificación ABC por (almacén, producto). Ver FASE_ABC_CYCLE_COUNT.md.
 *
 * Clasifica cada (almacén, producto) por **valor de consumo anualizado** (unidades
 * vendidas en una ventana trailing × costo unitario), via Pareto por almacén:
 *   A = hasta 80% del valor · B = 80–95% · C = 95–100% (y todo lo sin ventas).
 *
 * Materializada (no on-the-fly) para que el scheduling de conteo cíclico sea estable
 * y barato de leer. Se recomputa por cron (semanal) o endpoint manual: DELETE+INSERT
 * atómico por tenant (el cómputo vive en InventoryAbcService).
 *
 * Patrón del proyecto: tenant_id, RLS forzado, FKs compuestas a tablas reales,
 * grant app_runtime, idempotente (guard hasTable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('abc_classification')) return;

  await knex.schema.withSchema('commercial').createTable('abc_classification', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.uuid('product_id').notNullable();
    t.string('abc_class', 1).notNullable(); // 'A' | 'B' | 'C'
    t.decimal('annual_value', 16, 2).notNullable().defaultTo(0); // consumo anualizado × costo
    t.decimal('units_window', 14, 3).notNullable().defaultTo(0); // unidades vendidas en la ventana
    t.decimal('value_share', 6, 4).notNullable().defaultTo(0);   // share ACUMULADO de valor (0..1)
    t.integer('window_days').notNullable().defaultTo(90);
    t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'warehouse_id', 'product_id'], { indexName: 'commercial_abc_natural_unique' });
    t.check(`?? in ('A','B','C')`, ['abc_class'], 'commercial_abc_class_valid');
    t.index(['tenant_id', 'warehouse_id', 'abc_class'], 'idx_commercial_abc_wh_class');
  });

  await knex.raw(`
    ALTER TABLE commercial.abc_classification
      ADD CONSTRAINT fk_commercial_abc_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.abc_classification
      ADD CONSTRAINT fk_commercial_abc_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.abc_classification
      ADD CONSTRAINT fk_commercial_abc_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.abc_classification ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.abc_classification FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.abc_classification`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.abc_classification
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, DELETE ON commercial.abc_classification TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.abc_classification IS 'Clasificación ABC por (almacén, producto) por valor de consumo anualizado (Pareto). FASE_ABC_CYCLE_COUNT. Recomputada full (DELETE+INSERT) por InventoryAbcService.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('abc_classification');
};
