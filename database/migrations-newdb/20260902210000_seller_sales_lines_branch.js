/**
 * [RR-PROMO.4] — `analytics.v_seller_sales_lines` expone `source_branch`, porque el código
 * de vendedor NO identifica a una persona por sí solo.
 *
 * El bug: la vista sólo publicaba `vendedor`, y el motor de incentivos agrupaba por ahí.
 * Pero el código de vendedor es **por sucursal** (la PK de `wincaja.vendedores` es
 * `(tenant, source_branch, source_dataset, vendedor)`), y en la práctica se repite:
 *
 *     código 33 · sucursal 30 → MANUEL GARCIA ZURITA
 *     código 33 · sucursal 50 → JOSE RAMON RODRIGUEZ VARELA
 *     código 33 · sucursal 44 → JOSE ANTONIO ESPINOZA
 *
 * Medido en prod (jun–ago 2026), con venta desde más de una sucursal bajo el mismo código:
 * mayoreo 23 ($10.4M en suc 10 y 50), mayoreo 33 ($10.1M en 30 y 50), mayoreo 75 ($2.6M en
 * 10 y 30), vecinal 94 ($1.3M en 30 y 32), vecinal 43, y el genérico 00 en tres sucursales.
 *
 * Agrupar por `vendedor` a secas **fusiona a dos personas en una fila** y junta sus clientes
 * para el umbral del incentivo: un cliente que no llega a $500 con ninguno de los dos podía
 * cruzarlo al sumarlos, y el bono se pagaba mal. Dentro de UNA sucursal el código sí es
 * único (verificado: 1 nombre por (sucursal, código)), así que el par es la identidad buena.
 *
 * `CREATE OR REPLACE` agregando la columna AL FINAL — es lo único que Postgres admite sin
 * DROP, y hay código colgando de la vista.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_seller_sales_lines AS
    SELECT sl.tenant_id, sl.business_date, sl.sku, sl.product_id,
           sl.qty, sl.importe, sl.consecutivo, sl.cliente,
           'ruta'::text                       AS canal,
           sl.source_branch                   AS vendedor,
           'ruta'::text                       AS vendedor_origen,
           sl.source_branch                   AS route_no,
           CASE WHEN sl.qty <> 0 THEN sl.importe / sl.qty END AS precio_unitario,
           -- En RD la ruta ES el vendedor y ES su propia sucursal de origen.
           sl.source_branch                   AS source_branch
      FROM analytics.v_route_sales_lines sl
     WHERE sl.sale_channel = 'ruta_venta'
       AND sl.source_branch <> 'VEC-PH-H'

    UNION ALL

    SELECT vl.tenant_id, vl.business_date, vl.sku, vl.product_id,
           vl.qty, vl.importe, vl.consecutivo, vl.cliente,
           CASE vl.sale_channel
             WHEN 'preventa_vecinal' THEN 'vecinal'
             WHEN 'mayoreo_credito'  THEN 'mayoreo'
             ELSE 'mostrador' END             AS canal,
           COALESCE(NULLIF(btrim(vl.vendedor), ''), '(sin vendedor)') AS vendedor,
           'wincaja'::text                    AS vendedor_origen,
           NULL::text                         AS route_no,
           CASE WHEN vl.qty <> 0 THEN vl.importe / vl.qty END AS precio_unitario,
           -- La sucursal del POS: sin esto el código de vendedor no identifica a nadie.
           vl.source_branch                   AS source_branch
      FROM wincaja.v_sales_lines vl
     WHERE vl.sale_channel IN ('preventa_vecinal', 'mayoreo_credito', 'mostrador')`);

  await knex.raw(`GRANT SELECT ON analytics.v_seller_sales_lines TO app_runtime`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  // No se puede quitar una columna con CREATE OR REPLACE; se deja (es aditiva e inerte
  // para quien no la lea). Revertir de verdad exigiría DROP y hay código colgando.
};
