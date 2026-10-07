/**
 * commercial.carga_load_items — checklist de carga del vendedor.
 *
 * 1 row por (tenant_id, order_id, product_id) que el vendedor marcó como
 *   - 'loaded'     → SÍ se cargó al camión.
 *   - 'not_loaded' → NO se carga (sin stock, dañado, no cabe, …) + motivo.
 * 'pending' (aún no decidido) = AUSENCIA de fila.
 *
 * Registro AUDITABLE: NO muta el pedido ni el stock. La oficina/supervisor lo
 * consulta para ver qué NO se cargó (y por qué). El descuento/fulfillment del
 * pedido sigue su flujo propio e independiente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('commercial').createTable('carga_load_items', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('order_id').notNullable();
    table.uuid('product_id').notNullable();
    table.text('product_name'); // snapshot para reporte sin join
    table.date('delivery_date'); // fecha de carga (próximo día hábil)
    table.text('status').notNullable(); // 'loaded' | 'not_loaded'
    table.text('reason'); // motivo del 'not_loaded'
    table.decimal('quantity', 14, 3); // snapshot de la cantidad de la línea
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'order_id', 'product_id'], {
      indexName: 'commercial_carga_load_items_line_unique',
    });
    table.index('tenant_id', 'idx_commercial_carga_load_items_tenant');
    table.index(['tenant_id', 'delivery_date'], 'idx_commercial_carga_load_items_tenant_date');
  });

  await knex.raw(`
    ALTER TABLE commercial.carga_load_items
      ADD CONSTRAINT chk_carga_load_items_status CHECK (status IN ('loaded', 'not_loaded'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.carga_load_items
      ADD CONSTRAINT fk_commercial_carga_load_items_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.carga_load_items
      ADD CONSTRAINT fk_commercial_carga_load_items_order
      FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.carga_load_items ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.carga_load_items FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.carga_load_items
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.carga_load_items TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.carga_load_items IS 'Checklist de carga del vendedor: líneas (order_id,product_id) cargadas (loaded) o NO (not_loaded + motivo). pending = sin fila. Auditable; no muta pedido/stock.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('carga_load_items');
};
