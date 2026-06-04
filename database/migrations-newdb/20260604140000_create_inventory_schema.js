/**
 * Inventory schema — master de productos del ERP MegaDulces.
 *
 * Estructura jerárquica:
 *   inventory.products         (~13,852) — TODOS los SKUs del ERP (catalogo_completo)
 *   inventory.products_active  (~6,489)  — subset vendible hoy (productos_activos del ERP)
 *   catalog.products           (1,199)   — planograma de Mega Dulces (subset comercializado)
 *   trade.planogram_skus       (852)     — subset auditado visualmente
 *
 * Fuente: ERP MegaDulces via FDW (`erp.catalogo_completo` + `erp.productos_activos`).
 *
 * LOCAL: el importer (`sync-inventory-from-erp.js`) UPSERT desde FDW periódicamente.
 * RAILWAY: el FDW no llega a `.245`. Los datos se sincronizan via CSV/script
 * cuando se ejecuta sync local→Railway (mismo patrón que `catalog.products_top_sellers`).
 *
 * Ambas tablas son TABLE reales (no MATVIEW) para que funcionen en Railway sin FDW.
 *
 * NO multi-tenant: el ERP MegaDulces es uno solo. Si en el futuro hay otro
 * ERP/tenant, se agrega `tenant_id` por migración.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS inventory`);
  await knex.raw(`GRANT USAGE ON SCHEMA inventory TO app_runtime`);
  await knex.raw(
    `COMMENT ON SCHEMA inventory IS 'Master de productos del ERP MegaDulces. Tabla products = todos (~13852). Tabla products_active = vendibles (~6489). Catalog.products = subset comercializado por Mega Dulces (1199 planograma).'`,
  );

  // ── inventory.products: catálogo completo del ERP ──
  await knex.schema.withSchema('inventory').createTable('products', (table) => {
    table.string('sku', 20).notNullable();
    table.boolean('producto_servicio');
    table.string('codigo_barras', 30);
    table.string('subfamilia', 10);
    table.string('nombre', 100);
    table.string('descripcion', 200);
    table.string('unidad_compra', 10);
    table.string('unidad_venta', 10);
    table.bigInteger('factor_compra');
    table.bigInteger('factor_venta');
    table.decimal('venta_valor_anual', 16, 6);
    table.decimal('venta_valor_costo_anual', 16, 6);
    table.decimal('venta_unidad_anual', 16, 6);
    table.string('categoria', 10);
    table.bigInteger('ieps_compra');
    table.bigInteger('iva_compra');
    table.bigInteger('ieps_venta');
    table.bigInteger('iva_venta');
    table.bigInteger('ptos_frecuencia');
    table.timestamp('fecha_alta');
    table.timestamp('fecha_ultima_modificacion');
    table.string('a_1', 20);
    table.string('a_2', 10);
    table.string('a_3', 10);
    // Audit del sync
    table.timestamp('synced_at').notNullable().defaultTo(knex.fn.now());
    table.string('synced_from', 50).defaultTo('erp.catalogo_completo');

    table.primary('sku', 'inventory_products_pk');
  });

  await knex.raw(
    `CREATE INDEX idx_inventory_products_categoria ON inventory.products (categoria)`,
  );
  await knex.raw(
    `CREATE INDEX idx_inventory_products_subfamilia ON inventory.products (subfamilia)`,
  );
  await knex.raw(
    `CREATE INDEX idx_inventory_products_codigo_barras ON inventory.products (codigo_barras) WHERE codigo_barras IS NOT NULL`,
  );

  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.products TO app_runtime`,
  );
  await knex.raw(
    `COMMENT ON TABLE inventory.products IS 'Catálogo MASTER del ERP MegaDulces (~13852 SKUs). Sync from erp.catalogo_completo. NO multi-tenant (un solo ERP).'`,
  );

  // ── inventory.products_active: subset vendible ──
  // Estructura idéntica + flag is_active = true por definición.
  // FK a inventory.products(sku) para mantener referencia.
  await knex.schema
    .withSchema('inventory')
    .createTable('products_active', (table) => {
      table.string('sku', 20).notNullable();
      // Replicamos las cols principales del master (para queries directos sin JOIN)
      table.string('codigo_barras', 30);
      table.string('subfamilia', 10);
      table.string('nombre', 100);
      table.string('descripcion', 200);
      table.string('unidad_compra', 10);
      table.string('unidad_venta', 10);
      table.string('categoria', 10);
      // Sync
      table.timestamp('synced_at').notNullable().defaultTo(knex.fn.now());

      table.primary('sku', 'inventory_products_active_pk');
    });

  await knex.raw(`
    ALTER TABLE inventory.products_active
      ADD CONSTRAINT fk_inventory_products_active_sku
      FOREIGN KEY (sku) REFERENCES inventory.products(sku) ON DELETE CASCADE
  `);

  await knex.raw(
    `CREATE INDEX idx_inventory_products_active_categoria ON inventory.products_active (categoria)`,
  );

  await knex.raw(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON inventory.products_active TO app_runtime`,
  );
  await knex.raw(
    `COMMENT ON TABLE inventory.products_active IS 'SKUs activos (vendibles hoy) del ERP MegaDulces (~6489). Sync from erp.productos_activos. Subset de inventory.products via FK.'`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('inventory').dropTableIfExists('products_active');
  await knex.schema.withSchema('inventory').dropTableIfExists('products');
  await knex.raw(`DROP SCHEMA IF EXISTS inventory RESTRICT`);
};
