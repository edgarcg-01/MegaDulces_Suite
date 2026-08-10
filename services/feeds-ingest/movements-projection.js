/* eslint-disable no-console */
/**
 * Proyección de MOVIMIENTOS Wincaja → shape de analytics.stock_movements — fuente única del SQL.
 * La usa el handler wincaja-sales-bronze para re-derivar SCOPED a (branch, días) tras cada push.
 *
 * Mismo shaping que import-wincaja-stock-movements.js (tipos, naturaleza, signed_qty, unit_cost,
 * amount, folio 'WIN-...'), pero SIMPLIFICADO para el camino live de las sucursales wincaja_only
 * (30/32/50): dataset='actual', SIN cutover Kepler ni multi-dataset (esos aplican al histórico).
 * Todo inline validado (UUID/branch/fecha) → sin bind params (idéntico bajo knex/pg).
 *
 * Grano: agrega por (día, tipo, sku). source_branch='W<branch>' (el feed Kepler excluye 'W%').
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRANCH_RE = /^[0-9A-Za-z_-]{1,12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Columnas del INSERT a analytics.stock_movements, EN ESTE ORDEN (el SELECT las emite igual).
const SM_COLS = ['tenant_id', 'warehouse_id', 'product_id', 'sku', 'doc_date', 'genero', 'naturaleza',
  'doc_type', 'doc_code', 'folio', 'movement_kind', 'movement_label', 'signed_qty', 'qty', 'unit_cost', 'amount', 'source_branch'];

/**
 * @returns {string} SELECT que emite las columnas SM_COLS (en orden), scoped a (branch, days).
 */
function buildMovementsSelect({ tenantId, branch, warehouseId, days } = {}) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new Error(`movements-projection: tenantId inválido: ${tenantId}`);
  if (!UUID_RE.test(String(warehouseId || ''))) throw new Error(`movements-projection: warehouseId inválido: ${warehouseId}`);
  if (!BRANCH_RE.test(String(branch || ''))) throw new Error(`movements-projection: branch inválido: ${branch}`);
  if (!Array.isArray(days) || !days.length) throw new Error('movements-projection: days requerido');
  for (const d of days) if (!DAY_RE.test(String(d))) throw new Error(`día inválido: ${d}`);
  const dayList = days.map((d) => `DATE '${d}'`).join(',');
  const IS_SALIDA = "agg.tipo IN ('V','S','I')";
  return `
  WITH agg AS (
    SELECT m.fecha::date AS doc_date, d.tipo, d.articulo AS sku,
           SUM(ABS(d.cantidad_regular))        AS qty,
           SUM(ABS(COALESCE(d.valor_costo,0))) AS cost_total,
           SUM(ABS(COALESCE(d.valor_venta,0))) AS venta_total
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m
      ON m.tenant_id=d.tenant_id AND m.source_branch=d.source_branch
     AND m.source_dataset=d.source_dataset AND m.consecutivo=d.consecutivo
    WHERE d.tenant_id='${tenantId}' AND d.source_branch='${branch}' AND d.source_dataset='actual'
      AND d.tipo IN ('V','C','E','S','D','I','P','M') AND COALESCE(m.cancelado,false)=false
      AND d.cantidad_regular<>0 AND ABS(d.cantidad_regular)<10000000
      AND m.fecha IN (${dayList})
    GROUP BY 1,2,3
  )
  SELECT
    '${tenantId}'::uuid, '${warehouseId}'::uuid, p.id, agg.sku, agg.doc_date, 'W',
    CASE WHEN ${IS_SALIDA} THEN 'D' ELSE 'A' END,
    agg.tipo, 'WIN_'||agg.tipo,
    'WIN-'||to_char(agg.doc_date,'YYYYMMDD')||'-'||agg.tipo,
    CASE WHEN ${IS_SALIDA} THEN 'salida' ELSE 'entrada' END,
    CASE agg.tipo WHEN 'V' THEN 'Venta' WHEN 'C' THEN 'Compra' WHEN 'E' THEN 'Entrada (ajuste)'
         WHEN 'S' THEN 'Salida (ajuste)' WHEN 'D' THEN 'Devolución de venta' WHEN 'I' THEN 'Merma / baja'
         WHEN 'P' THEN 'Compra (pedido)' WHEN 'M' THEN 'Ajuste (entrada)' END,
    (CASE WHEN ${IS_SALIDA} THEN -1 ELSE 1 END) * agg.qty, agg.qty,
    CASE WHEN agg.qty>0 THEN (CASE WHEN ${IS_SALIDA} AND agg.venta_total>0 THEN agg.venta_total ELSE agg.cost_total END)/agg.qty END,
    CASE WHEN ${IS_SALIDA} AND agg.venta_total>0 THEN agg.venta_total ELSE agg.cost_total END,
    'W${branch}'
  FROM agg
  LEFT JOIN catalog.products p ON p.tenant_id='${tenantId}' AND p.sku=agg.sku AND p.deleted_at IS NULL`;
}

module.exports = { buildMovementsSelect, SM_COLS };
