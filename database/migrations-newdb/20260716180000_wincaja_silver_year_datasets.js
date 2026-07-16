/**
 * Fix anti-doble-conteo de wincaja.v_sales_lines para datasets HISTÓRICOS por AÑO.
 *
 * La lógica previa solo permitía filas no-concentrada con `fecha > conc_max` (la
 * concentrada era la base histórica y 'actual' solo aportaba lo posterior). Pero los
 * datasets por año (ej '2025') aportan fechas ANTERIORES al rango de la concentrada
 * (que en prod solo tiene 2026) → quedaban EXCLUIDAS (fecha < conc_max) y el 2025 de
 * las sucursales nunca llegaba al gold (solo las rutas, que no están en concentrada).
 *
 * Fix: la cutoff ahora también calcula `conc_min`; se aceptan filas no-concentrada
 * cuya fecha esté FUERA del rango de la concentrada — posterior (`> conc_max`, caso
 * 'actual') o ANTERIOR (`< conc_min`, caso años históricos). Cero doble conteo: la
 * concentrada sigue siendo autoritativa dentro de su propio rango [conc_min, conc_max].
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH conc_dates AS (
      -- Fechas EXACTAS que cubre la concentrada (autoritativa en su rango). El dedup es
      -- POR FECHA, no por rango [min,max]: así es robusto a fechas POS basura (2000/2020/
      -- 2029) que envenenaban el min/max y hacían caer los años históricos dentro del rango.
      SELECT DISTINCT tenant_id, source_branch, fecha::date AS d
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
    )
    SELECT
      m.tenant_id,
      m.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,
      m.source_dataset,
      m.fecha::date                    AS business_date,
      d.articulo                       AS sku,
      (p.sku IS NOT NULL)              AS in_kepler_catalog,
      d.cantidad_regular               AS qty,
      d.valor_venta                    AS importe,
      d.valor_costo                    AS costo,
      m.consecutivo,
      d.documento                      AS doc_ref,
      m.vendedor,
      m.tercero                        AS cliente,
      m.caja,
      m.cajero,
      CASE WHEN b.is_route THEN 'ruta_venta'
           ELSE COALESCE(cc.channel, 'mostrador') END AS sale_channel
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m
      ON  m.tenant_id     = d.tenant_id
      AND m.source_branch = d.source_branch
      AND m.source_dataset= d.source_dataset
      AND m.consecutivo   = d.consecutivo
    LEFT JOIN conc_dates cd
      ON cd.tenant_id = m.tenant_id AND cd.source_branch = m.source_branch AND cd.d = m.fecha::date
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = m.tenant_id AND p.sku = d.articulo AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT k.channel, k.es_venta
      FROM wincaja.caja_channels k
      WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
        AND k.source_branch IN (m.source_branch, '*')
      ORDER BY (k.source_branch = m.source_branch) DESC
      LIMIT 1
    ) cc ON true
    WHERE d.tipo = 'V'
      AND COALESCE(m.cancelado, false) = false
      AND COALESCE(cc.es_venta, true) = true
      AND NOT EXISTS (
        SELECT 1 FROM wincaja.clientes cli
        WHERE cli.tenant_id = m.tenant_id AND cli.source_branch = m.source_branch
          AND cli.source_dataset = m.source_dataset AND cli.cliente = m.tercero
          AND cli.nombre ILIKE 'ALMAC%'
      )
      AND (
        m.source_dataset = 'concentrada'
        OR cd.d IS NULL   -- la concentrada NO cubre esta fecha → no es duplicado, se conserva
      )
  `);
};

// Revierte a la versión previa (sin conc_min → año histórico vuelve a quedar excluido).
exports.down = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH cutoff AS (
      SELECT tenant_id, source_branch, MAX(fecha)::date AS conc_max
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
      GROUP BY tenant_id, source_branch
    )
    SELECT
      m.tenant_id, m.source_branch, b.warehouse_code, (b.kepler_code IS NULL) AS wincaja_only,
      m.source_dataset, m.fecha::date AS business_date, d.articulo AS sku,
      (p.sku IS NOT NULL) AS in_kepler_catalog, d.cantidad_regular AS qty, d.valor_venta AS importe,
      d.valor_costo AS costo, m.consecutivo, d.documento AS doc_ref, m.vendedor, m.tercero AS cliente,
      m.caja, m.cajero,
      CASE WHEN b.is_route THEN 'ruta_venta' ELSE COALESCE(cc.channel, 'mostrador') END AS sale_channel
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m
      ON m.tenant_id=d.tenant_id AND m.source_branch=d.source_branch AND m.source_dataset=d.source_dataset AND m.consecutivo=d.consecutivo
    LEFT JOIN cutoff c ON c.tenant_id=m.tenant_id AND c.source_branch=m.source_branch
    LEFT JOIN wincaja.branches b ON b.tenant_id=m.tenant_id AND b.source_branch=m.source_branch
    LEFT JOIN catalog.products p ON p.tenant_id=m.tenant_id AND p.sku=d.articulo AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT k.channel, k.es_venta FROM wincaja.caja_channels k
      WHERE k.tenant_id=m.tenant_id AND k.caja=m.caja AND k.source_branch IN (m.source_branch, '*')
      ORDER BY (k.source_branch=m.source_branch) DESC LIMIT 1
    ) cc ON true
    WHERE d.tipo='V' AND COALESCE(m.cancelado,false)=false AND COALESCE(cc.es_venta,true)=true
      AND NOT EXISTS (SELECT 1 FROM wincaja.clientes cli WHERE cli.tenant_id=m.tenant_id AND cli.source_branch=m.source_branch AND cli.source_dataset=m.source_dataset AND cli.cliente=m.tercero AND cli.nombre ILIKE 'ALMAC%')
      AND (m.source_dataset='concentrada' OR c.conc_max IS NULL OR m.fecha::date > c.conc_max)
  `);
};
