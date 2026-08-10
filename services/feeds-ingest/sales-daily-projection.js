/* eslint-disable no-console */
/**
 * Proyección canónica venta Wincaja → shape de analytics.sales_daily — ÚNICA fuente del SQL.
 * La usan: (a) el gold feed on-prem import-wincaja-analytics.js (corrida completa) y
 * (b) el handler wincaja-sales-bronze (re-derivación SCOPED a las (branch, día) tocadas).
 *
 * Todos los valores se INLINEAN tras validación estricta (UUID / branch / fecha) → el SQL
 * no lleva bind params, así funciona idéntico bajo knex.raw(sql) y pg client.query(sql)
 * (evita el choque de placeholders `?` vs `$n`). NO reimplementa lógica: es el mismo
 * SELECT_SRC histórico (canal, unidad CJA×factor/KGS, costo, blends por fecha).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH_RE = /^[0-9A-Za-z_-]{1,12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Cutovers de blend Kepler/Wincaja para sucursales COMPARTIDAS (idénticos al gold feed).
const PH_CUTOVER = "DATE '2026-07-01'";
const LP_CUTOVER = "DATE '2025-10-01'";
const YURE_CUTOVER = "DATE '2026-02-18'";
const ZAMORA_CUTOVER = "DATE '2026-03-16'";

/**
 * @param {object} o
 * @param {string} o.tenantId  UUID (validado, inline).
 * @param {string[]=} o.branches  source_branch a acotar (p.ej. ['30','32','50']). Sin esto = todas.
 * @param {string[]=} o.days      business_date 'YYYY-MM-DD' a acotar. Sin esto = todas.
 * @returns {string} SQL SELECT (sin bind params).
 */
function buildSalesDailySrc({ tenantId, branches = null, days = null } = {}) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new Error(`sales-daily-projection: tenantId inválido: ${tenantId}`);
  let scope = '';
  if (Array.isArray(branches) && branches.length) {
    for (const b of branches) if (!BRANCH_RE.test(String(b))) throw new Error(`branch inválido: ${b}`);
    scope += ` AND s.source_branch IN (${branches.map((b) => `'${b}'`).join(',')})`;
  }
  if (Array.isArray(days) && days.length) {
    for (const d of days) if (!DAY_RE.test(String(d))) throw new Error(`día inválido: ${d}`);
    scope += ` AND s.business_date IN (${days.map((d) => `DATE '${d}'`).join(',')})`;
  }
  return `
  WITH am AS (
    SELECT DISTINCT ON (tenant_id, articulo)
           tenant_id, articulo,
           upper(btrim(coalesce(unidad_venta, ''))) AS uv, factor_venta
      FROM wincaja.articulos
     ORDER BY tenant_id, articulo, source_dataset DESC
  )
  SELECT
    p.id                         AS product_id,
    w.id                         AS warehouse_id,
    s.business_date              AS sale_date,
    'wincaja_' || CASE s.sale_channel
       WHEN 'mayoreo_credito'  THEN 'credito'
       WHEN 'preventa_vecinal' THEN 'preventa'
       WHEN 'ruta_venta'       THEN 'ruta'
       WHEN 'mostrador'        THEN 'mostrador'
       ELSE s.sale_channel END   AS channel,
    SUM(CASE WHEN am.uv = 'CJA' THEN s.qty * COALESCE(NULLIF(am.factor_venta, 0), 1)
             ELSE s.qty END)      AS units,
    CASE WHEN bool_or(am.uv = 'KGS') THEN 'weight' ELSE 'piece' END AS unit_kind,
    SUM(s.importe)               AS revenue,
    SUM(s.costo)                 AS cost,
    SUM(s.importe) - SUM(s.costo) AS margin,
    SUM(s.tickets)               AS tickets
  FROM wincaja.v_sales_daily s
  JOIN catalog.products p
    ON p.tenant_id = s.tenant_id AND p.sku = s.sku AND p.deleted_at IS NULL
  JOIN commercial.warehouses w
    ON w.tenant_id = s.tenant_id AND w.deleted_at IS NULL
   AND w.code = CASE WHEN s.source_branch = '10' THEN '01'
                     WHEN s.source_branch = '42' THEN '02'
                     WHEN s.source_branch = '44' THEN '04'
                     WHEN s.source_branch = '54' THEN '05'
                     ELSE s.warehouse_code END
  LEFT JOIN am ON am.tenant_id = s.tenant_id AND am.articulo = s.sku
  WHERE s.tenant_id = '${tenantId}'
    AND ( s.wincaja_only = true
          OR (s.source_branch = '10' AND s.business_date < ${PH_CUTOVER})
          OR (s.source_branch = '42' AND s.business_date < ${LP_CUTOVER})
          OR (s.source_branch = '44' AND s.business_date < ${YURE_CUTOVER})
          OR (s.source_branch = '54' AND s.business_date < ${ZAMORA_CUTOVER}) )
    ${scope}
  GROUP BY p.id, w.id, s.business_date, channel`;
}

module.exports = { buildSalesDailySrc, UUID_RE };
