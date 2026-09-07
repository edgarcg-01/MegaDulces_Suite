/**
 * Fase RI (Integridad Referencial) — limpieza de orfandad detectada en la auditoría 2026-08-25.
 *
 * 1) `commercial.inventory_count_items.product_id`: 12 filas apuntan a productos hard-gone
 *    (no existen ni soft-deleted). product_id es nullable y la fila conserva `product_sku`
 *    → se pone a NULL (no se borra el conteo). Idempotente (re-run afecta 0).
 * 2) `commercial.vendor_sale_lines.route_id`: columna MUERTA — 1242/1242 huérfanas, ningún
 *    service la lee/escribe (solo la creó la mig 20260604160000). Se elimina (aprobado por Edgar).
 * 3) `trade.catalog_aliases.catalog_id`: es varchar(50) = código ERP, NO FK a trade.catalogs (uuid).
 *    Se documenta para evitar confusión (nombre engañoso).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1) NULL a los product_id huérfanos (conserva product_sku).
  await knex.raw(`
    UPDATE commercial.inventory_count_items i
       SET product_id = NULL
     WHERE i.product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.id = i.product_id)
  `);

  // 2) Drop de la columna muerta route_id (guardado).
  const hasRoute = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'route_id');
  if (hasRoute) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (t) => {
      t.dropColumn('route_id');
    });
  }

  // 3) Documentar catalog_id (código ERP, no FK).
  await knex.raw(`
    COMMENT ON COLUMN trade.catalog_aliases.catalog_id IS
      'Código de catálogo del ERP (varchar). NO es FK a trade.catalogs.id (uuid) — se resuelve por código, no por uuid.'
  `);
};

exports.down = async function (knex) {
  // Reponer route_id (sin datos — la columna estaba muerta).
  const hasRoute = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'route_id');
  if (!hasRoute) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (t) => {
      t.uuid('route_id');
    });
    await knex.raw(`
      COMMENT ON COLUMN commercial.vendor_sale_lines.route_id IS
        'Ruta asignada del vendedor (catalogs rutas) al momento de la captura. Para reporte venta por ruta.'
    `);
  }
  // (1) y (3) no se revierten: NULLs y comment son no-destructivos.
};
