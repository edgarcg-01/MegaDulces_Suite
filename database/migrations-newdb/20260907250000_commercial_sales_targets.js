/**
 * BI.9 — `commercial.sales_targets`: metas de venta (objetivo de monto) por
 * (scope, mes). scope = 'total' (una meta global del mes) | 'branch' (por sucursal,
 * scope_key = warehouse_code) | 'channel' (scope_key = canal). Es el ÚNICO origen de
 * "vs objetivo" del sub-modulo Analisis: sin captura no hay meta (no se inventa).
 *
 * Datos PROPIOS (capturados a mano, HITL) -> tabla real es legitima (no es derivable
 * del ODS). Patron del proyecto: tenant_id + RLS forzado + audit + grant app_runtime +
 * idempotente. scope_key NOT NULL default '' para que el UNIQUE funcione en 'total'.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('sales_targets')) return;

  await knex.schema.withSchema('commercial').createTable('sales_targets', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('scope', 10).notNullable();          // total | branch | channel
    t.string('scope_key', 64).notNullable().defaultTo(''); // warehouse_code | canal | '' (total)
    t.string('year_month', 7).notNullable();       // YYYY-MM
    t.decimal('target_monto', 16, 2).notNullable().defaultTo(0);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by').nullable();
    t.uuid('updated_by').nullable();

    t.primary('id');
    t.unique(['tenant_id', 'scope', 'scope_key', 'year_month'], { indexName: 'commercial_sales_targets_natural_unique' });
    t.check(`?? in ('total','branch','channel')`, ['scope'], 'commercial_sales_targets_scope_valid');
    t.index(['tenant_id', 'year_month'], 'idx_commercial_sales_targets_ym');
  });

  await knex.raw(`
    ALTER TABLE commercial.sales_targets
      ADD CONSTRAINT fk_commercial_sales_targets_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.sales_targets ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.sales_targets FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.sales_targets`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.sales_targets
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.sales_targets TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.sales_targets IS 'BI.9 — metas de venta por (scope, mes) capturadas a mano. Unico origen de vs-objetivo del sub-modulo Analisis.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('sales_targets');
};
