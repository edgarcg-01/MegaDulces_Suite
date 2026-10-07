/**
 * RR — Detalle (drill-down) de las rutas del PUSH. El side-peek de
 * /comercial/ventas-por-ruta lee `wincaja.v_sales_lines` (venta a bordo Wincaja),
 * que NO tiene el push de las camionetas de PH (Kepler local → runner .249 →
 * mart.ventas). Por eso el desglose de julio de esas rutas salía vacío.
 *
 *   - analytics.route_push_lines = line-level del push (feed import-route-push-lines.js,
 *     desde .249 mart.ventas; UPSERT DO NOTHING, ticket POS inmutable).
 *   - analytics.v_route_sales_lines = UNIÓN de la venta a bordo Wincaja + el push,
 *     con el MISMO shape que consume salesByRouteDetail → una sola fuente para el drill.
 *     Fuentes disjuntas por ruta/fecha (Wincaja ≤ cutover, push ≥ cutover) → UNION ALL
 *     no duplica.
 *
 * analytics.* sin RLS → tenant explícito en cada query. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS analytics.route_push_lines (
      tenant_id     uuid NOT NULL,
      route_no      text NOT NULL,          -- '21'..'28' (sucursal 'ruta_NN' sin prefijo)
      business_date date NOT NULL,
      folio         text NOT NULL,          -- ticket (mart.ventas.folio)
      sku           text NOT NULL,
      producto      text,
      qty           numeric NOT NULL DEFAULT 0,
      importe       numeric NOT NULL DEFAULT 0,
      imported_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, route_no, business_date, folio, sku)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rpl_route_date ON analytics.route_push_lines (tenant_id, route_no, business_date)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.route_push_lines TO app_runtime`);

  // Vista unificada para el drill-down (mismas columnas que usa salesByRouteDetail).
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_sales_lines AS
      SELECT tenant_id, source_branch, sale_channel, business_date, sku, qty, importe,
             consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines
       WHERE sale_channel = 'ruta_venta'
      UNION ALL
      SELECT tenant_id, route_no AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe,
             folio AS consecutivo, folio AS doc_ref, NULL::text AS cliente
        FROM analytics.route_push_lines`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_sales_lines TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_sales_lines`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.route_push_lines`);
};
