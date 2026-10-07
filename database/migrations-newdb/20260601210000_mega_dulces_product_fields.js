/**
 * Sprint M.1 — Extender schema de products para alinearse con la fuente real
 * (`Mega_Dulces` DB en .245). Agrega:
 *
 *   - `categories` tabla nueva (tenant_id, code, name)  → tipos de producto
 *   - `products.sku`           varchar(20)   external SKU (Mega_Dulces.articulo)
 *   - `products.barcode`       varchar(30)   código de barras EAN/UPC
 *   - `products.category_id`   uuid → categories.id
 *   - `products.unit_purchase` varchar(10)   PZA, CAJA, etc
 *   - `products.unit_sale`     varchar(10)
 *   - `products.factor_purchase` integer    cuántas unidades base por unit_purchase
 *   - `products.factor_sale`     integer
 *   - `products.iva_rate`     numeric(5,4)  IVA por producto (en Mega_Dulces vive a nivel item, no a nivel precio)
 *   - `products.ieps_rate`    numeric(5,4)
 *   - `brands.code`            varchar(20)  external code (Mega_Dulces.subfamilia)
 *
 * Análisis previo de Mega_Dulces:
 *   - "Jerarquía" categoria→subfamilia→familia es flat sucio: 57% de productos
 *     tienen `categoria == subfamilia`; del 43% restante `categoria` describe
 *     tipo de producto y `subfamilia` el proveedor. Por eso colapsamos a 2
 *     dimensiones limpias: `category_id` (qué es) + `brand_id` (quién lo hace).
 *
 *   - El importer (M.2) resuelve el mapping desde Mega_Dulces y rellena estas
 *     columnas. Los productos ya existentes en postgres_platform quedan NULL
 *     en estas columnas hasta el primer run del importer.
 *
 * Todas las columnas nuevas son nullable + idempotentes (`IF NOT EXISTS`) →
 * la migración no rompe nada en runtime. El composite unique se agrega DESPUÉS
 * de que el importer haya rellenado `sku`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── categories ─────────────────────────────────────────────────────────
  // Multi-tenant: composite PK natural (tenant_id, id) para coincidir con el
  // patrón de brands/products/etc y permitir composite FKs.
  const hasCategories = await knex.schema.hasTable('categories');
  if (!hasCategories) {
    await knex.schema.createTable('categories', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('code', 20).notNullable();
      t.string('name', 100).notNullable();
      t.boolean('activo').notNullable().defaultTo(true);
      t.integer('orden').notNullable().defaultTo(0);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').nullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by').nullable();
      t.timestamp('deleted_at', { useTz: true }).nullable();
      t.uuid('deleted_by').nullable();

      t.foreign('tenant_id').references('id').inTable('tenants').onDelete('RESTRICT');
      t.foreign('created_by').references('id').inTable('users').onDelete('SET NULL');
      t.foreign('updated_by').references('id').inTable('users').onDelete('SET NULL');
      t.foreign('deleted_by').references('id').inTable('users').onDelete('SET NULL');

      t.unique(['tenant_id', 'code'], { indexName: 'categories_tenant_code_unique' });
      t.unique(['tenant_id', 'id'], { indexName: 'categories_tenant_id_composite' });
    });

    // RLS forzado (mismo patrón que products/brands).
    await knex.raw(`ALTER TABLE categories ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE categories FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON categories
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);

    // Grants para app_runtime (RLS los limita por tenant_id).
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON categories TO app_runtime`);

    // Trigger auto_populate_tenant_id (mismo patrón que el resto de tablas MT).
    await knex.raw(`
      CREATE TRIGGER categories_auto_populate_tenant_id
        BEFORE INSERT ON categories
        FOR EACH ROW
        EXECUTE FUNCTION public.auto_populate_tenant_id()
    `);
  }

  // ── products: nuevas columnas ──────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE products
      ADD COLUMN IF NOT EXISTS sku                VARCHAR(20),
      ADD COLUMN IF NOT EXISTS barcode            VARCHAR(30),
      ADD COLUMN IF NOT EXISTS category_id        UUID,
      ADD COLUMN IF NOT EXISTS unit_purchase      VARCHAR(10),
      ADD COLUMN IF NOT EXISTS unit_sale          VARCHAR(10),
      ADD COLUMN IF NOT EXISTS factor_purchase    INTEGER,
      ADD COLUMN IF NOT EXISTS factor_sale        INTEGER,
      ADD COLUMN IF NOT EXISTS iva_rate           NUMERIC(5,4),
      ADD COLUMN IF NOT EXISTS ieps_rate          NUMERIC(5,4)
  `);

  // FK composite a categories (mantiene el patrón tenant-safe).
  // Sólo agregar si no existe — pg no tiene IF NOT EXISTS para FKs así que
  // chequeamos por information_schema.
  const fkExists = await knex.raw(`
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'products'
       AND constraint_name = 'fk_products_tenant_category'
       AND constraint_type = 'FOREIGN KEY'
  `);
  if (fkExists.rowCount === 0) {
    await knex.raw(`
      ALTER TABLE products
        ADD CONSTRAINT fk_products_tenant_category
        FOREIGN KEY (tenant_id, category_id)
        REFERENCES categories(tenant_id, id)
        ON DELETE SET NULL
    `);
  }

  // Index parcial para búsqueda por sku/barcode (los más usados en scan).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_sku_unique
      ON products (tenant_id, sku)
      WHERE sku IS NOT NULL AND deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_tenant_barcode
      ON products (tenant_id, barcode)
      WHERE barcode IS NOT NULL AND deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_tenant_category
      ON products (tenant_id, category_id)
      WHERE category_id IS NOT NULL
  `);

  // ── brands: agregar code externo ──────────────────────────────────────
  await knex.raw(`
    ALTER TABLE brands
      ADD COLUMN IF NOT EXISTS code VARCHAR(20)
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS brands_tenant_code_unique
      ON brands (tenant_id, code)
      WHERE code IS NOT NULL AND deleted_at IS NULL
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Revertir las columnas (no la tabla categories — puede tener data).
  await knex.raw(`
    ALTER TABLE products
      DROP CONSTRAINT IF EXISTS fk_products_tenant_category
  `);
  await knex.raw(`DROP INDEX IF EXISTS products_tenant_sku_unique`);
  await knex.raw(`DROP INDEX IF EXISTS idx_products_tenant_barcode`);
  await knex.raw(`DROP INDEX IF EXISTS idx_products_tenant_category`);
  await knex.raw(`
    ALTER TABLE products
      DROP COLUMN IF EXISTS sku,
      DROP COLUMN IF EXISTS barcode,
      DROP COLUMN IF EXISTS category_id,
      DROP COLUMN IF EXISTS unit_purchase,
      DROP COLUMN IF EXISTS unit_sale,
      DROP COLUMN IF EXISTS factor_purchase,
      DROP COLUMN IF EXISTS factor_sale,
      DROP COLUMN IF EXISTS iva_rate,
      DROP COLUMN IF EXISTS ieps_rate
  `);

  await knex.raw(`DROP INDEX IF EXISTS brands_tenant_code_unique`);
  await knex.raw(`ALTER TABLE brands DROP COLUMN IF EXISTS code`);

  // Down NO borra `categories` por defecto — tiene data. Si necesitás drop,
  // hacelo manualmente.
};
