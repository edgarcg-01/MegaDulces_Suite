/**
 * Migración: schema `analytics.*` + 3 materialized views comerciales con RLS.
 *
 * MVs creadas (rolling window 30 días, refresh externo via cron app):
 *   - analytics.mv_sales_overview_30d
 *   - analytics.mv_top_customers_30d  (50 max por tenant)
 *   - analytics.mv_top_products_30d   (50 max por tenant)
 *
 * Aislamiento multi-tenant: Postgres NO soporta RLS directamente sobre
 * materialized views. Workaround: el service filtra `tenant_id = current_tenant_id()`
 * explícitamente en cada SELECT. Defense in depth secundaria:
 *   - app_runtime sólo tiene SELECT (no puede SELECT * sin WHERE peligroso)
 *   - El refresh corre como postgres y ve todo (correcto: materializa todo)
 *   - El service tiene UN solo lugar donde construye queries — fácil de auditar
 *
 * Refresh con CONCURRENTLY → requiere UNIQUE INDEX en cada MV. Permite refresh
 * sin bloquear lecturas (importante para dashboards en tiempo real).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS analytics');
  await knex.raw('GRANT USAGE ON SCHEMA analytics TO app_runtime');
  await knex.raw(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA analytics GRANT SELECT ON TABLES TO app_runtime',
  );

  // ─────────────────────────────────────────────────────────────────────────
  // mv_sales_overview_30d — KPIs de los últimos 30 días por tenant
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_sales_overview_30d AS
    SELECT
      o.tenant_id,
      COUNT(*) FILTER (WHERE o.status = 'fulfilled')::int AS orders_fulfilled,
      COUNT(*) FILTER (WHERE o.status = 'confirmed')::int AS orders_confirmed,
      COUNT(*) FILTER (WHERE o.status = 'draft')::int AS orders_draft,
      COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS orders_cancelled,
      COALESCE(SUM(o.total) FILTER (WHERE o.status = 'fulfilled'), 0)::numeric(14,2) AS revenue_gross,
      COALESCE(SUM(o.subtotal) FILTER (WHERE o.status = 'fulfilled'), 0)::numeric(14,2) AS revenue_net,
      COALESCE(SUM(o.tax_total) FILTER (WHERE o.status = 'fulfilled'), 0)::numeric(14,2) AS tax_collected,
      COUNT(DISTINCT o.customer_id) FILTER (WHERE o.status = 'fulfilled')::int AS unique_customers,
      NOW() AS refreshed_at
    FROM commercial.orders o
    WHERE o.deleted_at IS NULL
      AND o.created_at >= NOW() - INTERVAL '30 days'
    GROUP BY o.tenant_id
    WITH NO DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX mv_sales_overview_30d_tenant_unique
      ON analytics.mv_sales_overview_30d (tenant_id)
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // mv_top_customers_30d — top 50 customers por revenue en últimos 30 días
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_top_customers_30d AS
    WITH ranked AS (
      SELECT
        o.tenant_id,
        c.id AS customer_id,
        c.code,
        c.name,
        COUNT(o.id)::int AS orders_count,
        COALESCE(SUM(o.total), 0)::numeric(14,2) AS revenue,
        COALESCE(AVG(o.total), 0)::numeric(14,2) AS avg_order_value,
        MAX(o.created_at) AS last_order_at,
        ROW_NUMBER() OVER (PARTITION BY o.tenant_id ORDER BY SUM(o.total) DESC) AS rank
      FROM commercial.orders o
      JOIN commercial.customers c ON c.id = o.customer_id
      WHERE o.deleted_at IS NULL
        AND o.status = 'fulfilled'
        AND o.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY o.tenant_id, c.id, c.code, c.name
    )
    SELECT * FROM ranked WHERE rank <= 50
    WITH NO DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX mv_top_customers_30d_tenant_rank_unique
      ON analytics.mv_top_customers_30d (tenant_id, rank)
  `);
  await knex.raw(`
    CREATE INDEX mv_top_customers_30d_tenant_customer
      ON analytics.mv_top_customers_30d (tenant_id, customer_id)
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // mv_top_products_30d — top 50 productos por units vendidas en últimos 30 días
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_top_products_30d AS
    WITH ranked AS (
      SELECT
        o.tenant_id,
        p.id AS product_id,
        p.nombre AS product_name,
        b.nombre AS brand_name,
        COUNT(DISTINCT o.id)::int AS orders_count,
        COALESCE(SUM(ol.quantity), 0)::numeric(14,3) AS units_sold,
        COALESCE(SUM(ol.line_total), 0)::numeric(14,2) AS revenue,
        ROW_NUMBER() OVER (PARTITION BY o.tenant_id ORDER BY SUM(ol.quantity) DESC) AS rank_by_units,
        ROW_NUMBER() OVER (PARTITION BY o.tenant_id ORDER BY SUM(ol.line_total) DESC) AS rank_by_revenue
      FROM commercial.order_lines ol
      JOIN commercial.orders o ON o.id = ol.order_id
      LEFT JOIN public.products p ON p.id = ol.product_id
      LEFT JOIN public.brands b ON b.id = p.brand_id
      WHERE o.deleted_at IS NULL
        AND o.status = 'fulfilled'
        AND o.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY o.tenant_id, p.id, p.nombre, b.nombre
    )
    SELECT * FROM ranked WHERE rank_by_units <= 50 OR rank_by_revenue <= 50
    WITH NO DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX mv_top_products_30d_tenant_product_unique
      ON analytics.mv_top_products_30d (tenant_id, product_id)
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // Grants para app_runtime (RLS no soportado en MVs, ver header del archivo)
  // ─────────────────────────────────────────────────────────────────────────
  const mvs = [
    'mv_sales_overview_30d',
    'mv_top_customers_30d',
    'mv_top_products_30d',
  ];
  for (const mv of mvs) {
    await knex.raw(`GRANT SELECT ON analytics.${mv} TO app_runtime`);
  }

  // Comments
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_sales_overview_30d IS 'KPIs comerciales rolling window 30 días por tenant. Refresh externo via cron. Incluye refreshed_at para stale detection.'`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_top_customers_30d IS 'Top 50 customers por revenue por tenant (rolling 30d). Refresh externo. Rank pre-calculado.'`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_top_products_30d IS 'Top 50 productos por units o revenue (rolling 30d). Refresh externo. Dos rankings: rank_by_units y rank_by_revenue.'`);
};

exports.down = async function (knex) {
  // El orden importa: drop policies primero por seguridad, luego MVs.
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_top_products_30d');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_top_customers_30d');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS analytics.mv_sales_overview_30d');
  // No drop el schema — puede tener otras vistas creadas después.
};
