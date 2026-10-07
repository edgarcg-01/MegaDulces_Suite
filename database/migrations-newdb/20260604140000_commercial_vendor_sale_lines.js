/**
 * Migración: commercial.vendor_sale_lines — líneas de venta de la captura del vendedor.
 *
 * 1 fila por producto detectado por OCR en el ticket de venta (corte) que el
 * vendedor sube en la "captura diaria especial". Registro de venta LIVIANO:
 * NO es un pedido (orders), NO toca stock, NO crea route_tickets. Sirve para
 * dos agrupaciones:
 *   - "venta diaria por cliente"  → group by store_id + sale_date
 *   - "venta por ticket de vendedor" → group by capture_ref
 *
 * Anclado a la TIENDA de trade (store_id = el "cliente"). El producto matchea
 * catalog.products (misma identidad que planograma y ventas comerciales).
 *
 * Multi-tenant: tenant_id + RLS forzada + trigger auto_populate_tenant_id.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('vendor_sale_lines');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('vendor_sale_lines', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('capture_ref').notNullable(); // agrupa las filas de una captura (= "por ticket de vendedor")
    table.uuid('vendor_user_id').notNullable(); // vendedor que captura (del JWT)
    table.uuid('store_id').notNullable(); // tienda de trade = "cliente"
    table.date('sale_date').notNullable();

    table.uuid('product_id').notNullable();
    table.text('product_name'); // snapshot del nombre al momento de la venta (protege reportes vs churn de catálogo)
    table.decimal('quantity', 12, 3).notNullable();
    table.string('confidence', 20); // high|medium|low del matcher (auditoría)

    table.text('ticket_photo_url');
    table.string('ticket_cloudinary_public_id', 255);

    table.uuid('daily_capture_id'); // back-link suave a la visita (sin FK cross-schema)
    table.uuid('sync_uuid'); // idempotencia offline

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_vendor_sale_lines_tenant_id_composite' });

    table.index(['tenant_id', 'store_id', 'sale_date'], 'idx_commercial_vsl_store_date');
    table.index(['tenant_id', 'capture_ref'], 'idx_commercial_vsl_capture');
    table.index(['tenant_id', 'vendor_user_id', 'sale_date'], 'idx_commercial_vsl_vendor_date');
    table.index(['tenant_id', 'product_id'], 'idx_commercial_vsl_product');
  });

  // activo GENERATED desde deleted_at (convención del proyecto)
  await knex.raw(`
    ALTER TABLE commercial.vendor_sale_lines
      ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED
  `);

  // CHECK cantidad > 0
  await knex.raw(`
    ALTER TABLE commercial.vendor_sale_lines
      ADD CONSTRAINT chk_vendor_sale_lines_qty CHECK (quantity > 0)
  `);

  // FKs cross-schema (tablas reales). store_id/vendor_user_id NO llevan FK
  // (stores/users via vistas; se validan en la app — patrón route_tickets).
  await knex.raw(`
    ALTER TABLE commercial.vendor_sale_lines
      ADD CONSTRAINT fk_vendor_sale_lines_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.vendor_sale_lines
      ADD CONSTRAINT fk_vendor_sale_lines_product
      FOREIGN KEY (product_id) REFERENCES catalog.products(id) ON DELETE RESTRICT
  `);

  // Idempotencia offline: múltiples NULL permitidos.
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_vendor_sale_lines_tenant_sync
      ON commercial.vendor_sale_lines (tenant_id, sync_uuid)
      WHERE sync_uuid IS NOT NULL AND deleted_at IS NULL
  `);

  // RLS forzada + policy + grants
  await knex.raw(`ALTER TABLE commercial.vendor_sale_lines ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.vendor_sale_lines FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.vendor_sale_lines
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);

  // Trigger auto_populate_tenant_id (backstop; el insert igual setea tenant_id explícito)
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON commercial.vendor_sale_lines;
    CREATE TRIGGER trg_auto_populate_tenant_id
      BEFORE INSERT ON commercial.vendor_sale_lines
      FOR EACH ROW
      EXECUTE FUNCTION public.auto_populate_tenant_id();
  `);

  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.vendor_sale_lines TO app_runtime');

  await knex.raw(`
    COMMENT ON TABLE commercial.vendor_sale_lines IS
      'Líneas de venta de la captura del vendedor (1 fila por producto OCR del ticket). '
      'Registro liviano, no es pedido ni route_ticket, no toca stock. Agrupable por '
      'store_id (venta por cliente/tienda) y capture_ref (venta por ticket de vendedor).'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('vendor_sale_lines');
};
