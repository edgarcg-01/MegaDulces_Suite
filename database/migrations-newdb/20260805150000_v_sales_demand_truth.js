/**
 * HVT.2 — `analytics.v_sales_demand_truth`: demanda REAL anclada a REVENUE (money-anchored),
 * robusta al desmadre de unidades de `sales_daily.units`.
 *
 * POR QUÉ (hallazgo HVT.3): `sales_daily.units` NO es aditivo/consistente. Los canales
 * registran en unidades distintas — mostrador Kepler = piezas individuales (~$3/u en La Rosa);
 * Wincaja = cajas/paquetes (~$57/u). Sumar units de ambos = sumar piezas + cajas = inválido,
 * infla la demanda 2-6× y explotó el sugerido de /compras (14.9k–36.9k cajas vs 679 reales).
 * El **revenue SÍ es aditivo y estable** (net, money-anchored). → demanda = revenue ÷ precio.
 *
 * Misma tesis que arregló sell-out (RA-PRO.39): convertir por PRECIO, no por factor de unidad.
 *   demand_boxes_day  = (revenue_90d / 90) / cja_price        (usa analytics.product_box_price)
 *   demand_pieces_day = demand_boxes_day × box_factor          (usa analytics.v_product_box_factor)
 * Validado La Rosa: money-anchored → 299 cajas (vs 679 workbook), units → 36,922. ~100× mejor.
 *
 * Peso (unit_kind='weight', granel/kg): el precio-caja no aplica → demand_boxes_day NULL; el
 * consumidor usa units (kg SÍ es aditivo). `units_per_day_raw` se expone SOLO para diagnóstico
 * (NO usar para reabasto salvo weight). Sin RLS (analytics) → filtro tenant_id explícito.
 * Ventana móvil 90d vía current_date. Idempotente (CREATE OR REPLACE).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_sales_demand_truth AS
    WITH rev AS (
      SELECT tenant_id, product_id, warehouse_id,
             sum(revenue)                                   AS rev_90d,
             sum(revenue) FILTER (WHERE channel LIKE 'wincaja_%') AS rev_wincaja_90d,
             sum(units)                                     AS units_raw_90d,
             max(unit_kind)                                 AS unit_kind
        FROM analytics.sales_daily
       WHERE sale_date >= current_date - 90
         AND sale_date <= current_date
       GROUP BY tenant_id, product_id, warehouse_id
    )
    SELECT
      r.tenant_id, r.product_id, r.warehouse_id, r.unit_kind,
      round(r.rev_90d, 2)                                       AS rev_90d,
      round(r.rev_90d / 90.0, 4)                                AS rev_per_day,
      v.box_factor,
      bp.cja_price,
      -- demanda money-anchored (fuente de verdad para reabasto de SKUs con precio de caja)
      CASE WHEN bp.cja_price > 0 AND r.unit_kind IS DISTINCT FROM 'weight'
           THEN round((r.rev_90d / 90.0) / bp.cja_price, 4) END AS demand_boxes_day,
      CASE WHEN bp.cja_price > 0 AND r.unit_kind IS DISTINCT FROM 'weight'
           THEN round(((r.rev_90d / 90.0) / bp.cja_price) * COALESCE(v.box_factor, 1), 4) END AS demand_pieces_day,
      -- diagnóstico: demanda por units cruda (NO confiable — mezcla piezas/cajas) y su gap
      round(r.units_raw_90d / 90.0, 4)                          AS units_per_day_raw,
      CASE WHEN bp.cja_price > 0 AND r.unit_kind IS DISTINCT FROM 'weight'
             AND (r.rev_90d / 90.0) / bp.cja_price > 0
           THEN round((r.units_raw_90d / 90.0) / NULLIF((r.rev_90d / 90.0) / bp.cja_price * COALESCE(v.box_factor, 1), 0), 2) END AS raw_vs_truth_ratio
    FROM rev r
    LEFT JOIN analytics.v_product_box_factor v ON v.tenant_id = r.tenant_id AND v.product_id = r.product_id
    LEFT JOIN analytics.product_box_price   bp ON bp.tenant_id = r.tenant_id AND bp.product_id = r.product_id AND bp.cja_price > 0
    WHERE r.rev_90d > 0`);
  await knex.raw(`GRANT SELECT ON analytics.v_sales_demand_truth TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_sales_demand_truth`);
};
