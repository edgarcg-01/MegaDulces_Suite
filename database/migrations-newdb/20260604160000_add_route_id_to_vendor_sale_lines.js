/**
 * Agrega route_id a commercial.vendor_sale_lines.
 *
 * El vendedor tiene una ruta asignada (daily_assignments) además de la tienda.
 * Persistir route_id en las líneas de venta permite el reporte "venta por ruta"
 * para el supervisor. Nullable + index; sin FK (la ruta vive en catalogs y se
 * valida en la app vía el selector, mismo criterio que route_tickets.route_code).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'route_id');
  if (has) return;

  await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (table) => {
    table.uuid('route_id');
    table.index(['tenant_id', 'route_id'], 'idx_commercial_vsl_route');
  });

  await knex.raw(`
    COMMENT ON COLUMN commercial.vendor_sale_lines.route_id IS
      'Ruta asignada del vendedor (catalogs rutas) al momento de la captura. Para reporte venta por ruta.'
  `);
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('commercial.vendor_sale_lines', 'route_id');
  if (has) {
    await knex.schema.withSchema('commercial').alterTable('vendor_sale_lines', (table) => {
      table.dropIndex(['tenant_id', 'route_id'], 'idx_commercial_vsl_route');
      table.dropColumn('route_id');
    });
  }
};
