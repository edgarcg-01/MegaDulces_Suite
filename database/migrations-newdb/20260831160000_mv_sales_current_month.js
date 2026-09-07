/**
 * PERF — el reporte Sell-Out (`/comercial/sell-out`) abre por defecto en el MES EN CURSO,
 * y el mes en curso nunca es month-aligned (`isMonthAligned = ... && to < inicioMesActual`),
 * así que SIEMPRE cae al path diario: escanea `analytics.sales_daily` del mes (111k filas) y
 * agrupa por producto×sucursal×canal con un `Sort` que se DERRAMA A DISCO → ~1 s por carga
 * (peor en prod), devolviendo ~18k filas.
 *
 * Este matview pre-agrega el MES EN CURSO a grano (producto, almacén, canal) con la MISMA
 * semántica que el path diario (`sum(units)`, `sum(revenue)`) — NO replica la lógica de
 * cajas del rollup mensual (`sales_boxes_monthly`), justamente para no arriesgar números.
 * `sellOut()` lo lee para el mes en curso (con FALLBACK al diario si falta/está vacío), y
 * re-agrupa ~18k filas por canal → rápido, sin el sort-a-disco.
 *
 * Cubre `[inicio de mes .. hoy]` en TZ MX; se refresca cada 15 min (AnalyticsRefreshService).
 * Al cambiar de mes, el matview pasa a cubrir el mes nuevo y el mes anterior queda como mes
 * cerrado (rollup `sales_boxes_monthly`, si el feed lo pobló). Llave UNIQUE para CONCURRENTLY.
 * Sin RLS (analytics.*): `sellOut` filtra `tenant_id` explícito.
 *
 * Idempotente: DROP MATERIALIZED VIEW IF EXISTS + CREATE.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_current_month CASCADE`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sales_current_month AS
      SELECT tenant_id,
             product_id,
             warehouse_id,
             channel,
             SUM(units)          AS units,
             SUM(revenue)        AS revenue,
             max(unit_kind)      AS unit_kind,
             max(sale_date)      AS last_sale_date
        FROM analytics.sales_daily
       WHERE sale_date >= date_trunc('month', (now() AT TIME ZONE 'America/Mexico_City')::date)
         AND sale_date <= (now() AT TIME ZONE 'America/Mexico_City')::date
       GROUP BY tenant_id, product_id, warehouse_id, channel
  `);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_sales_current_month ON analytics.mv_sales_current_month (tenant_id, product_id, warehouse_id, channel)`);
  await knex.raw(`CREATE INDEX ix_mv_sales_current_month_wh ON analytics.mv_sales_current_month (tenant_id, warehouse_id)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_sales_current_month TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sales_current_month IS
    'PERF: ventas del MES EN CURSO pre-agregadas (producto×almacén×canal, sum units/revenue) para el path diario de sellOut. Refresco 15 min. Reemplaza el scan de 111k filas de sales_daily + sort-a-disco. Mismos números que el diario (verificado). Fallback: si falta/vacío, sellOut escanea sales_daily.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_current_month CASCADE`);
};
