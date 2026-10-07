/**
 * Sprint M.6 — Enriquecimiento completo del schema vs Mega_Dulces ERP.
 *
 * Después del M.1 importábamos los campos básicos (nombre, sku, brand, etc.).
 * El M.6 cubre las columnas de ALTO + MEDIO valor que el ERP expone y que
 * la app necesita para margen, UX, vendor mobile y reporting.
 *
 * Agrega:
 *   products:
 *     - description           TEXT          descripción larga (catalogo_completo.descripcion)
 *     - cost_with_tax         NUMERIC(14,4) costo c/IVA por unidad (productos_activos.costo_civa) → margen
 *     - cost_per_case         NUMERIC(14,4) costo por caja (productos_activos.costo_x_caja) → vendor mobile
 *     - cost_base             NUMERIC(14,4) costo matriz (catalogo_etiquetas.costo_matriz) → margen real
 *     - location              VARCHAR(20)   ubicación física (catalogo_etiquetas.ubicacion) → picking
 *     - location_warehouse    VARCHAR(20)   ubicación bodega (catalogo_etiquetas.ubicacion_bodega)
 *     - iva_purchase_rate     NUMERIC(5,4)  IVA de compra (cc.iva_compra) — distinto del IVA venta
 *     - ieps_purchase_rate    NUMERIC(5,4)  IEPS de compra (cc.ieps_compra)
 *     - loyalty_points        INTEGER       puntos de frecuencia (cc.ptos_frecuencia) — para programas
 *
 *   public.vendedores (nueva):
 *     - codigo (PK), nombre — staff del ERP. Útil para mapear ventas → user_id.
 *
 *   commercial.product_prices:
 *     - SIN cambios de schema. El importer M.6.2 pasa a usar `p_X_ca` como
 *       `min_qty` por tier (antes hardcodeado en 1). Así una asignación a
 *       price_list P3 respeta el volume tier definido en el ERP.
 *
 * Todas las columnas son nullable + idempotentes (`IF NOT EXISTS`). El down
 * solo dropea columnas/tabla nueva — no toca data importada previamente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── products: enriquecimiento ──────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS description          TEXT,
      ADD COLUMN IF NOT EXISTS cost_with_tax        NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS cost_per_case        NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS cost_base            NUMERIC(14,4),
      ADD COLUMN IF NOT EXISTS location             VARCHAR(20),
      ADD COLUMN IF NOT EXISTS location_warehouse   VARCHAR(20),
      ADD COLUMN IF NOT EXISTS iva_purchase_rate    NUMERIC(5,4),
      ADD COLUMN IF NOT EXISTS ieps_purchase_rate   NUMERIC(5,4),
      ADD COLUMN IF NOT EXISTS loyalty_points       INTEGER
  `);

  // Índice por location para queries de picking (vendor mobile).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_tenant_location
      ON products (tenant_id, location)
      WHERE location IS NOT NULL AND deleted_at IS NULL
  `);

  // ── vendedores (legacy ERP staff) ──────────────────────────────────────
  // Multi-tenant + RLS forzado, mismo patrón que el resto.
  const hasVendedores = await knex.schema.hasTable('vendedores_erp');
  if (!hasVendedores) {
    await knex.schema.createTable('vendedores_erp', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      // English snake_case (convención CLAUDE.md para columnas nuevas).
      // El cleanup P1 (migración 20260602110000) renombra desde codigo/nombre
      // las DBs que ya hayan corrido esta migración. Para fresh installs van
      // directo con code/name.
      t.string('code', 20).notNullable();
      t.string('name', 100).notNullable();
      t.uuid('user_id').nullable(); // mapeo opcional al user de la app cuando exista identidad cruzada
      t.boolean('activo').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.foreign('tenant_id').references('id').inTable('tenants').onDelete('RESTRICT');
      t.foreign('user_id').references('id').inTable('users').onDelete('SET NULL');
      t.unique(['tenant_id', 'code'], { indexName: 'vendedores_erp_tenant_code_unique' });
      t.unique(['tenant_id', 'id'], { indexName: 'vendedores_erp_tenant_id_composite' });
    });

    await knex.raw(`ALTER TABLE vendedores_erp ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE vendedores_erp FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON vendedores_erp
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON vendedores_erp TO app_runtime`);
    await knex.raw(`
      CREATE TRIGGER vendedores_erp_auto_populate_tenant_id
        BEFORE INSERT ON vendedores_erp
        FOR EACH ROW
        EXECUTE FUNCTION public.auto_populate_tenant_id()
    `);
  }

  console.log('[mega_dulces_full_enrichment] products +9 cols, vendedores_erp tabla nueva');
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_products_tenant_location`);
  await knex.raw(`
    ALTER TABLE products
      DROP COLUMN IF EXISTS description,
      DROP COLUMN IF EXISTS cost_with_tax,
      DROP COLUMN IF EXISTS cost_per_case,
      DROP COLUMN IF EXISTS cost_base,
      DROP COLUMN IF EXISTS location,
      DROP COLUMN IF EXISTS location_warehouse,
      DROP COLUMN IF EXISTS iva_purchase_rate,
      DROP COLUMN IF EXISTS ieps_purchase_rate,
      DROP COLUMN IF EXISTS loyalty_points
  `);
  // No drop vendedores_erp por default — tiene data potencialmente útil.
  // Si necesitás drop, hacelo manual.
};
