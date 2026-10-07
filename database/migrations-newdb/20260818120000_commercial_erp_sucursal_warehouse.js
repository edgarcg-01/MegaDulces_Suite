/**
 * Fase WMS-REC.1 (crosswalk) — Mapa Sucursal ERP → Almacén destino.
 *
 * La orden de entrada del ERP trae la SUCURSAL de Kepler ('00'=CEDIS, '01'=PH…), pero
 * el Vale necesita un `commercial.warehouses.id` (dimensión distinta, sin mapeo limpio).
 * Esta tabla lo resuelve: se configura UNA vez (sucursal → almacén) y a partir de ahí el
 * almacén destino se autollena al buscar la orden.
 *
 * 1 almacén por sucursal (PK sucursal). RLS forzado + grant app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('erp_sucursal_warehouse')) return;

  await knex.schema.withSchema('commercial').createTable('erp_sucursal_warehouse', (t) => {
    t.uuid('tenant_id').notNullable();
    t.string('sucursal', 8).notNullable(); // código Kepler '00'..'05'
    t.uuid('warehouse_id').notNullable();
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by');

    t.primary(['tenant_id', 'sucursal']);
    t.index(['tenant_id', 'warehouse_id'], 'idx_commercial_erpsucwh_wh');
  });

  await knex.raw(`
    ALTER TABLE commercial.erp_sucursal_warehouse
      ADD CONSTRAINT fk_commercial_erpsucwh_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.erp_sucursal_warehouse
      ADD CONSTRAINT fk_commercial_erpsucwh_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.erp_sucursal_warehouse ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.erp_sucursal_warehouse FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.erp_sucursal_warehouse`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.erp_sucursal_warehouse
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.erp_sucursal_warehouse TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.erp_sucursal_warehouse IS 'Crosswalk Sucursal ERP → almacén destino (WMS-REC.1): autollena el almacén del Vale desde la sucursal de la orden Kepler.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('erp_sucursal_warehouse');
};
