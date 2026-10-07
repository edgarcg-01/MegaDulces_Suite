/* eslint-disable no-console */
/**
 * Paso 0 de Thot T.R0 — auditoría read-only del dato real antes de diseñar findings
 * comerciales. Misma disciplina que el audit de Horus 360 (no diseñar reglas sobre
 * datos que no existen). Conexión local (knexfile-newdb development = superuser → ve
 * todo); filtra tenant_id explícito. Corre: node database/scripts/thot-findings-audit.js
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

(async () => {
  const out = {};
  const scalar = async (label, sql, binds = []) => {
    try {
      const r = await knex.raw(sql, binds);
      out[label] = r.rows;
    } catch (e) {
      out[label] = `ERR ${e.message}`;
    }
  };

  // 1. customer_360: tamaño + lifecycle + cuántos tienen cadencia (≥3 pedidos) + AOV
  await scalar('c360_total', `SELECT count(*)::int n FROM commercial.customer_360 WHERE tenant_id = ?`, [T]);
  await scalar(
    'c360_by_lifecycle',
    `SELECT lifecycle_stage, count(*)::int n, count(cadence_days)::int with_cadence,
            count(next_order_estimate)::int with_next, round(avg(aov)::numeric,2) avg_aov,
            round(avg(orders_count)::numeric,1) avg_orders
     FROM commercial.customer_360 WHERE tenant_id = ? GROUP BY lifecycle_stage ORDER BY n DESC`,
    [T],
  );
  await scalar(
    'c360_overdue',
    `SELECT count(*) FILTER (WHERE next_order_estimate <= current_date)::int overdue,
            count(*) FILTER (WHERE next_order_estimate <= current_date - 14)::int overdue_14
     FROM commercial.customer_360 WHERE tenant_id = ? AND lifecycle_stage IN ('active','at_risk')`,
    [T],
  );

  // 2. orders: volumen + distribución de # pedidos por cliente (clave para reglas de historia)
  await scalar(
    'orders_by_status',
    `SELECT status, count(*)::int n FROM commercial.orders WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY status ORDER BY n DESC`,
    [T],
  );
  await scalar(
    'customers_by_order_count',
    `WITH oc AS (
       SELECT customer_id, count(*) c FROM commercial.orders
       WHERE tenant_id = ? AND status IN ('confirmed','fulfilled') AND deleted_at IS NULL
       GROUP BY customer_id)
     SELECT
       count(*) FILTER (WHERE c >= 1)::int ge1,
       count(*) FILTER (WHERE c >= 2)::int ge2,
       count(*) FILTER (WHERE c >= 3)::int ge3,
       count(*) FILTER (WHERE c >= 5)::int ge5,
       count(*) FILTER (WHERE c >= 8)::int ge8
     FROM oc`,
    [T],
  );

  // 3. order_lines: ¿hay líneas? productos distintos por pedido (basket) + por cliente
  await scalar(
    'order_lines_total',
    `SELECT count(*)::int lines,
            count(distinct order_id)::int orders_with_lines,
            round(avg(per_order)::numeric,2) avg_distinct_per_order
     FROM (SELECT order_id, count(distinct product_id) per_order
           FROM commercial.order_lines WHERE tenant_id = ? GROUP BY order_id) s`,
    [T],
  );

  // 4. catalog.products: margen + rotación + categoría disponibles
  await scalar(
    'products_signal_coverage',
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE cost_with_tax > 0)::int with_cost,
            count(*) FILTER (WHERE rotation_tier IS NOT NULL)::int with_rotation,
            count(*) FILTER (WHERE category_id IS NOT NULL)::int with_category,
            count(*) FILTER (WHERE brand_id IS NOT NULL)::int with_brand
     FROM catalog.products WHERE tenant_id = ? AND deleted_at IS NULL`,
    [T],
  );

  // 5. intelligence.*: señales precomputadas (whitespace/zona/afinidad/presencia)
  await scalar('aff_rows', `SELECT count(*)::int n FROM intelligence.product_affinity WHERE tenant_id = ?`, [T]);
  await scalar('zone_rows', `SELECT count(*)::int n, count(distinct zona)::int zonas FROM intelligence.zone_demand WHERE tenant_id = ?`, [T]);
  await scalar(
    'pdv_presence',
    `SELECT count(*)::int n, count(distinct customer_id)::int customers FROM intelligence.pdv_presence WHERE tenant_id = ?`,
    [T],
  ).catch(() => (out.pdv_presence = 'tabla ausente'));

  // 6. categoría por cliente: ¿se puede detectar "categoría abandonada"?
  await scalar(
    'category_history',
    `WITH cc AS (
       SELECT o.customer_id, p.category_id, count(distinct o.id) orders_with_cat
       FROM commercial.orders o
       JOIN commercial.order_lines ol ON ol.order_id = o.id AND ol.tenant_id = o.tenant_id
       JOIN catalog.products p ON p.id = ol.product_id AND p.tenant_id = o.tenant_id
       WHERE o.tenant_id = ? AND o.status IN ('confirmed','fulfilled') AND o.deleted_at IS NULL
         AND p.category_id IS NOT NULL
       GROUP BY o.customer_id, p.category_id)
     SELECT count(distinct customer_id)::int customers_with_cat_history,
            count(*) FILTER (WHERE orders_with_cat >= 2)::int cat_pairs_ge2
     FROM cc`,
    [T],
  );

  console.log(JSON.stringify(out, null, 2));
  await knex.destroy();
})().catch((e) => {
  console.error('ERR', e.stack || e.message);
  process.exit(1);
});
