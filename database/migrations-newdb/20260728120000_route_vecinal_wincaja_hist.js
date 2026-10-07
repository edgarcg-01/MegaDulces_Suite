/**
 * RR — VINCULAR la venta vecinal histórica de Wincaja al reporte por ruta.
 *
 * La vecinal de Padre Hidalgo es UNA operación con dos fuentes: Wincaja `.mdb` (canal
 * `preventa_vecinal`, suc '10', ene–jun 2026, congelada en el cutover) → Kepler md_01
 * (`1V001`/`1V002`, jun27→, ya cableado). Este view surface el tramo Wincaja como una
 * ruta histórica SEPARADA (`VEC-PH-H`) SIN copiar filas: se agrega un 3er UNION que
 * remapea el canal `preventa_vecinal` de la suc madre a `sale_channel='ruta_venta'`.
 *
 * Corte en el cutover (`< 2026-06-27`) = a prueba de solape con Kepler (que arranca el 27);
 * en la práctica la vecinal Wincaja de PH ya no tiene días ≥27, el filtro es cinturón.
 * La branch `VEC-PH-H` (is_route, parent='10') y el rollup mensual los pone el feed
 * `import-wincaja-vecinal-routes.js` (data, no schema → fuera del boot de Railway).
 *
 * Idempotente (CREATE OR REPLACE). @param { import("knex").Knex } knex
 */
const CUTOVER = '2026-06-27';

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_sales_lines AS
      SELECT tenant_id, source_branch, sale_channel, business_date, sku, qty, importe,
             consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines
       WHERE sale_channel = 'ruta_venta'
      UNION ALL
      SELECT tenant_id, route_no AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe, folio AS consecutivo, folio AS doc_ref, cliente
        FROM analytics.route_push_lines
      UNION ALL
      SELECT tenant_id, 'VEC-PH-H'::text AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe, consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines
       WHERE sale_channel = 'preventa_vecinal' AND source_branch = '10'
         AND business_date < DATE '${CUTOVER}'`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_sales_lines TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_route_sales_lines AS
      SELECT tenant_id, source_branch, sale_channel, business_date, sku, qty, importe,
             consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines WHERE sale_channel = 'ruta_venta'
      UNION ALL
      SELECT tenant_id, route_no AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe, folio AS consecutivo, folio AS doc_ref, cliente
        FROM analytics.route_push_lines`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_sales_lines TO app_runtime`);
};
