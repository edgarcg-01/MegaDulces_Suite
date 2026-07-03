/**
 * Fase LM-K.0 — allowlist de sucursales habilitadas para entrega a domicilio.
 *
 * `logistics.home_delivery_warehouses` — qué sucursales (por warehouse_code de
 * Kepler, el mismo que emite el poller) pueden capturar folio + despachar. Piloto:
 * SOLO Padre Hidalgo (01), La Piedad Abastos (02), 8 Esquinas (03). Expandir =
 * insertar/activar fila, sin tocar código. Los endpoints de lookup/dispatch
 * rechazan folios de sucursales no habilitadas.
 *
 * warehouse_code = code del BRANCHES del poller (00..05), NO un UUID.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

  if (!(await knex.schema.withSchema('logistics').hasTable('home_delivery_warehouses'))) {
    await knex.schema.withSchema('logistics').createTable('home_delivery_warehouses', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('warehouse_code', 10).notNullable(); // Kepler almacén / branch code
      t.string('name', 120);
      t.boolean('enabled').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'warehouse_code'], { indexName: 'logistics_hd_wh_tenant_code_unique' });
    });
    await knex.raw(`
      ALTER TABLE logistics.home_delivery_warehouses
        ADD CONSTRAINT fk_logistics_hd_wh_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE CASCADE
    `);
  }

  await knex.raw(`ALTER TABLE logistics.home_delivery_warehouses ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE logistics.home_delivery_warehouses FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON logistics.home_delivery_warehouses`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON logistics.home_delivery_warehouses
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.home_delivery_warehouses TO app_runtime');

  // Seed piloto: 3 sucursales habilitadas.
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);
    const rows = [
      { warehouse_code: '01', name: 'Padre Hidalgo' },
      { warehouse_code: '02', name: 'La Piedad Abastos' },
      { warehouse_code: '03', name: '8 Esquinas' },
    ];
    for (const r of rows) {
      await trx('logistics.home_delivery_warehouses')
        .insert({
          tenant_id: MEGA_DULCES_TENANT_ID,
          warehouse_code: r.warehouse_code,
          name: r.name,
          enabled: true,
        })
        .onConflict(['tenant_id', 'warehouse_code'])
        .ignore();
    }
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('home_delivery_warehouses');
};
