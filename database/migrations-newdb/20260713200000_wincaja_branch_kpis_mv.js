/**
 * W.6 - Materialized view de KPIs por sucursal (overview instantaneo).
 *
 * El endpoint /commercial/wincaja/overview corria 5 agregaciones vivas sobre las
 * vistas silver; la de v_sales_daily re-escanea ~2.6M lineas (concentrada) y tardaba
 * ~7s por request. Esta MV precomputa los 8 renglones (uno por sucursal) y el
 * importer la refresca al final del feed gold -> overview lee 8 filas, instantaneo.
 *
 * RLS: Postgres NO soporta RLS en materialized views (igual que analytics.*). La MV
 * embebe tenant_id (viene de las vistas base) y el consumidor filtra explicito por
 * current_tenant_id(). El REFRESH corre como owner (postgres) via el importer, que
 * ve todos los tenants a traves de las vistas security_invoker.
 *
 * WITH NO DATA: no computar en migrate-time (evita 7s en el arranque / boot Railway).
 * El primer REFRESH lo hace el importer. UNIQUE index habilita REFRESH CONCURRENTLY.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  const exists = await knex.raw(
    `SELECT 1 FROM pg_matviews WHERE schemaname = 'wincaja' AND matviewname = 'mv_branch_kpis'`,
  );
  if (exists.rows.length) return;

  await knex.raw(`
    CREATE MATERIALIZED VIEW wincaja.mv_branch_kpis AS
    WITH sp AS (
      SELECT tenant_id, source_branch FROM wincaja.branches
    ),
    sales AS (
      SELECT tenant_id, source_branch, SUM(importe) AS venta_total, SUM(qty) AS unidades
      FROM wincaja.v_sales_daily GROUP BY 1, 2
    ),
    stk AS (
      SELECT tenant_id, source_branch, SUM(valor_inventario) AS inventario_valor, COUNT(*) AS skus_stock
      FROM wincaja.v_stock GROUP BY 1, 2
    ),
    ar AS (
      SELECT tenant_id, source_branch, SUM(saldo) AS cartera, COUNT(*) AS cartera_clientes
      FROM wincaja.v_ar_customer WHERE is_internal = false AND saldo > 0 GROUP BY 1, 2
    ),
    lost AS (
      SELECT tenant_id, source_branch, SUM(importe_perdido) AS venta_perdida, COUNT(*) AS faltantes
      FROM wincaja.v_lost_demand GROUP BY 1, 2
    )
    SELECT
      sp.tenant_id,
      sp.source_branch,
      COALESCE(sales.venta_total, 0)      AS venta_total,
      COALESCE(sales.unidades, 0)         AS unidades,
      COALESCE(stk.inventario_valor, 0)   AS inventario_valor,
      COALESCE(stk.skus_stock, 0)         AS skus_stock,
      COALESCE(ar.cartera, 0)             AS cartera,
      COALESCE(ar.cartera_clientes, 0)    AS cartera_clientes,
      COALESCE(lost.venta_perdida, 0)     AS venta_perdida,
      COALESCE(lost.faltantes, 0)         AS faltantes
    FROM sp
    LEFT JOIN sales USING (tenant_id, source_branch)
    LEFT JOIN stk   USING (tenant_id, source_branch)
    LEFT JOIN ar    USING (tenant_id, source_branch)
    LEFT JOIN lost  USING (tenant_id, source_branch)
    WITH NO DATA
  `);

  await knex.raw(`CREATE UNIQUE INDEX mv_branch_kpis_pk ON wincaja.mv_branch_kpis (tenant_id, source_branch)`);
  await knex.raw(`GRANT SELECT ON wincaja.mv_branch_kpis TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS wincaja.mv_branch_kpis`);
};
