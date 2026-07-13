/**
 * W.5 - Capa SILVER de Wincaja: vistas canonicas sobre el landing bronze.
 *
 * Decision (ver ADR-031 + FASE_W "centralizar consumo, separar raw"): NO se
 * fusiona fisicamente Wincaja con Kepler. Estas vistas traducen `wincaja.*` al
 * shape canonico (sku / warehouse / date / qty / $) que consumen los tableros,
 * uniendo por producto (articulo=sku) + crosswalk de sucursal. El gold luego
 * une con Kepler aplicando la regla de fuente autoritativa por sucursal.
 *
 * security_invoker=true => la RLS de las tablas base (wincaja.*, catalog.products)
 * aplica al rol que consulta (app_runtime ve solo su tenant). Requiere PG15+.
 *
 * Taxonomia de documento (DetallesMovAlmacen.tipo): V=venta (doc T=ticket/F=factura),
 * S=salida, E=entrada, C=compra. Venta => tipo='V'.
 *
 * Anti-doble-conteo actual vs concentrada: concentrada = historico consolidado;
 * actual = periodo corriente. Se toma concentrada completa + actual SOLO en fechas
 * posteriores al ultimo dia de concentrada de esa sucursal (o todo actual si la
 * sucursal no tiene concentrada: 00/40/44/54).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  // v_sales_lines: linea de venta normalizada (una por item vendido)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH cutoff AS (
      SELECT tenant_id, source_branch, MAX(fecha)::date AS conc_max
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
      GROUP BY tenant_id, source_branch
    )
    SELECT
      m.tenant_id,
      m.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,   -- true = 30/32/50 (fuente unica)
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
      m.cajero
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m
      ON  m.tenant_id     = d.tenant_id
      AND m.source_branch = d.source_branch
      AND m.source_dataset= d.source_dataset
      AND m.consecutivo   = d.consecutivo
    LEFT JOIN cutoff c
      ON c.tenant_id = m.tenant_id AND c.source_branch = m.source_branch
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = m.tenant_id AND p.sku = d.articulo AND p.deleted_at IS NULL
    WHERE d.tipo = 'V'
      AND COALESCE(m.cancelado, false) = false
      AND (
        m.source_dataset = 'concentrada'
        OR c.conc_max IS NULL
        OR m.fecha::date > c.conc_max
      )
  `);

  // v_sales_daily: rollup sku x sucursal x dia (para Command Center / sell-out / Thot)
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_daily WITH (security_invoker = true) AS
    SELECT
      tenant_id, source_branch, warehouse_code, wincaja_only, business_date, sku,
      SUM(qty)                          AS qty,
      SUM(importe)                      AS importe,
      SUM(costo)                        AS costo,
      SUM(importe) - SUM(costo)         AS margen,
      COUNT(DISTINCT consecutivo)       AS tickets
    FROM wincaja.v_sales_lines
    GROUP BY tenant_id, source_branch, warehouse_code, wincaja_only, business_date, sku
  `);

  // v_stock: existencia normalizada (solo dataset actual = vivo). Costo saneado.
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_stock WITH (security_invoker = true) AS
    SELECT
      e.tenant_id,
      e.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,
      e.almacen,
      e.articulo                       AS sku,
      (p.sku IS NOT NULL)              AS in_kepler_catalog,
      e.existencia,
      e.stock_minimo,
      e.stock_maximo,
      -- costo saneado: descarta corruptos (bronze) fuera de rango razonable
      CASE WHEN e.costo_promedio BETWEEN 0 AND 1000000 THEN e.costo_promedio END AS costo_promedio,
      CASE WHEN e.ultimo_costo   BETWEEN 0 AND 1000000 THEN e.ultimo_costo   END AS ultimo_costo,
      CASE WHEN e.costo_promedio BETWEEN 0 AND 1000000 AND e.existencia > 0
           THEN e.existencia * e.costo_promedio END AS valor_inventario,
      e.fecha_ult_venta,
      e.fecha_ult_compra
    FROM wincaja.existencias e
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = e.tenant_id AND b.source_branch = e.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = e.tenant_id AND p.sku = e.articulo AND p.deleted_at IS NULL
    WHERE e.source_dataset = 'actual'
  `);

  await knex.raw(`GRANT SELECT ON wincaja.v_sales_lines, wincaja.v_sales_daily, wincaja.v_stock TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS wincaja.v_sales_daily`);
  await knex.raw(`DROP VIEW IF EXISTS wincaja.v_sales_lines`);
  await knex.raw(`DROP VIEW IF EXISTS wincaja.v_stock`);
};
