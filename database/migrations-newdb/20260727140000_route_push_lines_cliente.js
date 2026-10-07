/**
 * RR — Cliente en el line-level del push. El `push-ruta.cmd` ya empuja el cliente
 * (`kdm1.c10`) pero cae en la columna mal nombrada `mart.ventas.forma_pago`. La venta en
 * ruta NO es mayormente público (71% del importe tiene cliente identificado), así que el
 * desglose por cliente del drill-down lo necesita. Agrega `cliente` a route_push_lines y
 * lo expone en la vista unificada (público = 'CONTADO'/vacío → NULL, alinea con la lógica
 * público del detalle: NULL/''/'0001').
 *
 * Idempotente. @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasColumn('route_push_lines', 'cliente'))) {
    await knex.raw(`ALTER TABLE analytics.route_push_lines ADD COLUMN cliente text`);
  }
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_sales_lines AS
      SELECT tenant_id, source_branch, sale_channel, business_date, sku, qty, importe,
             consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines
       WHERE sale_channel = 'ruta_venta'
      UNION ALL
      SELECT tenant_id, route_no AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe,
             folio AS consecutivo, folio AS doc_ref, cliente
        FROM analytics.route_push_lines`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_sales_lines TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_sales_lines AS
      SELECT tenant_id, source_branch, sale_channel, business_date, sku, qty, importe,
             consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines WHERE sale_channel = 'ruta_venta'
      UNION ALL
      SELECT tenant_id, route_no, 'ruta_venta'::text, business_date, sku, qty, importe,
             folio, folio, NULL::text FROM analytics.route_push_lines`);
  await knex.raw(`ALTER TABLE analytics.route_push_lines DROP COLUMN IF EXISTS cliente`);
};
