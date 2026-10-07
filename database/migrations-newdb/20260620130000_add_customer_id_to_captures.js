/**
 * Captura del vendedor anclada al CLIENTE comercial (commercial.customers) en
 * vez de a la tienda de Trade (store_id detectado por GPS).
 *
 * Agrega `customer_id` (nullable, sin FK duro — patrón store_id/vendor_user_id:
 * se valida en la app, las refs cross-schema a vistas no llevan FK) a:
 *   - trade.daily_captures  (visita/exhibidor)  + recrear vista public.daily_captures
 *   - commercial.vendor_sale_lines (líneas de venta OCR)
 * y hace `commercial.vendor_sale_lines.store_id` NULLABLE (ahora se deriva de
 * customer.store_id y puede quedar null si el cliente no tiene tienda vinculada).
 *
 * customer_id es NULLABLE: las capturas existentes (auditoría de trade clásica,
 * apps/view) NO tienen cliente — siguen funcionando store-based. Solo la captura
 * del vendedor (apps/vendor) lo manda.
 *
 * IMPORTANTE (search_path no incluye `trade`): el INSERT del service usa
 * `daily_captures` sin calificar → resuelve a la VISTA public.daily_captures
 * (lista de columnas explícita). Hay que recrearla para exponer customer_id, o
 * el INSERT del campo se descarta. Patrón conocido (ver expose_skip_scoring).
 *
 * Idempotente: guards hasColumn. CREATE OR REPLACE VIEW agrega columnas al final.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1. trade.daily_captures + índice (tenant, customer)
  const hasDc = await knex.schema.hasColumn('trade.daily_captures', 'customer_id');
  if (!hasDc) {
    await knex.schema.withSchema('trade').alterTable('daily_captures', (t) => {
      t.uuid('customer_id');
      t.index(['tenant_id', 'customer_id'], 'idx_daily_captures_tenant_customer');
    });
    await knex.raw(`
      COMMENT ON COLUMN trade.daily_captures.customer_id IS
        'Cliente comercial (commercial.customers) de la captura del vendedor. Ancla principal; store_id se deriva de customer.store_id (puede ser null). Null en auditorías de trade clásicas (store-based).'
    `);
  }

  // Recrear la vista passthrough para exponer customer_id (al final).
  await knex.raw(`
    CREATE OR REPLACE VIEW public.daily_captures AS
    SELECT
      id, tenant_id, folio, user_id, store_id, fecha, hora_inicio, hora_fin,
      exhibiciones, stats, latitud, longitud, config_version_id, score_maximo,
      score_calidad_pct, score_cobertura_pct, score_final_pct, created_at,
      created_by, updated_at, updated_by, deleted_at, deleted_by, activo,
      captured_by_username, zona_captura, sync_uuid, route_id, skip_scoring, customer_id
    FROM trade.daily_captures
  `);

  // 2. commercial.vendor_sale_lines + índice
  const hasVsl = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'customer_id');
  if (!hasVsl) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (t) => {
      t.uuid('customer_id');
      t.index(['tenant_id', 'customer_id'], 'idx_commercial_vsl_customer');
    });
    await knex.raw(`
      COMMENT ON COLUMN commercial.vendor_sale_lines.customer_id IS
        'Cliente comercial de la venta del vendedor. Ancla principal; store_id se deriva de customer.store_id (puede ser null).'
    `);
  }

  // store_id deja de ser obligatorio (se deriva del cliente; null si no hay tienda vinculada).
  await knex.raw(`ALTER TABLE commercial.vendor_sale_lines ALTER COLUMN store_id DROP NOT NULL`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Vista sin customer_id (orden y columnas previas).
  await knex.raw(`
    CREATE OR REPLACE VIEW public.daily_captures AS
    SELECT
      id, tenant_id, folio, user_id, store_id, fecha, hora_inicio, hora_fin,
      exhibiciones, stats, latitud, longitud, config_version_id, score_maximo,
      score_calidad_pct, score_cobertura_pct, score_final_pct, created_at,
      created_by, updated_at, updated_by, deleted_at, deleted_by, activo,
      captured_by_username, zona_captura, sync_uuid, route_id, skip_scoring
    FROM trade.daily_captures
  `);

  const hasDc = await knex.schema.hasColumn('trade.daily_captures', 'customer_id');
  if (hasDc) {
    await knex.schema.withSchema('trade').alterTable('daily_captures', (t) => {
      t.dropIndex(['tenant_id', 'customer_id'], 'idx_daily_captures_tenant_customer');
      t.dropColumn('customer_id');
    });
  }

  const hasVsl = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'customer_id');
  if (hasVsl) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (t) => {
      t.dropIndex(['tenant_id', 'customer_id'], 'idx_commercial_vsl_customer');
      t.dropColumn('customer_id');
    });
  }
  // store_id NOT NULL no se restaura (podría haber filas con null).
};
