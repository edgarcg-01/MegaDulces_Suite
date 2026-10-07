/**
 * RS.12b — Optimizar el path EN VIVO de sell-out (v_sales_lines) que tumbó el pool.
 *
 * Diagnóstico (EXPLAIN 2026-08-05): la vista filtra por `(fecha)::date`, y el cast INUTILIZA
 * el índice `ix_wcj_maestro_fecha (…, fecha)` → **Seq Scan de 1.44M filas** de
 * `maestro_mov_almacen` en CADA consulta (costo ~46k). Además el CTE `conc_dates` hace un
 * DISTINCT sobre TODA la maestra 'concentrada' en cada query (costo fijo ~48k, no escala).
 *
 * BLOQUEADOR (fix 2026-08-08): la versión previa creaba el índice sobre `((fecha)::date)`.
 * `fecha` es `timestamptz` (ver landing schema) y el cast timestamptz→date depende del
 * TimeZone de sesión ⇒ NO es IMMUTABLE ⇒ Postgres RECHAZA el índice
 * (`functions in index expression must be marked IMMUTABLE`), con o sin CONCURRENTLY.
 * Esto rompía `migrate:latest` en prod y frenaba TODO el pipeline de migraciones.
 *
 * Fix real = función IMMUTABLE `wincaja.fecha_mx_date(timestamptz)` que fija el offset MX
 * (`AT TIME ZONE 'America/Mexico_City'`). El contenedor ya corre en TZ MX, así que
 * `fecha::date` (sesión) == `fecha_mx_date(fecha)` fila por fila ⇒ business_date NO cambia.
 * Con la función se puede:
 *   1) crear el índice por EXPRESIÓN (ya es indexable), y
 *   2) repuntar `v_sales_lines` para que use la MISMA expresión que el índice → el planner
 *      lo usa (Index Scan) y el DISTINCT de conc_dates se vuelve index-only.
 *
 * CONCURRENTLY (sin lock de escritura) → la migración NO corre en transacción.
 * Junto con statement_timeout='45s' (RS.12) el path en vivo deja de poder tumbar el pool.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

exports.up = async function (knex) {
  // 1) Función IMMUTABLE (offset MX fijo). PARALLEL SAFE para no bloquear planes paralelos.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION wincaja.fecha_mx_date(ts timestamptz)
      RETURNS date
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
    AS $$ SELECT (ts AT TIME ZONE 'America/Mexico_City')::date $$`);

  // 2) Repuntar v_sales_lines: mismos columnas/tipos, solo `fecha::date` → fecha_mx_date(fecha)
  //    (idéntico a la def. de 20260716180000, con el único cambio de la expresión de fecha).
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH conc_dates AS (
      SELECT DISTINCT tenant_id, source_branch, wincaja.fecha_mx_date(fecha) AS d
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
    )
    SELECT
      m.tenant_id,
      m.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,
      m.source_dataset,
      wincaja.fecha_mx_date(m.fecha)   AS business_date,
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
      ON cd.tenant_id = m.tenant_id AND cd.source_branch = m.source_branch AND cd.d = wincaja.fecha_mx_date(m.fecha)
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
      AND d.valor_venta < 10000000
      AND d.valor_venta >= 0
      AND COALESCE(d.cantidad_regular, 0) < 10000000
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
        OR cd.d IS NULL
      )
  `);

  // 3) Índices por expresión (ahora indexable). Matchean exactamente lo que usa la vista.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_wcj_maestro_fecha_date
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, wincaja.fecha_mx_date(fecha))`);
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_wcj_maestro_concdates
      ON wincaja.maestro_mov_almacen (tenant_id, source_branch, wincaja.fecha_mx_date(fecha))
      WHERE source_dataset = 'concentrada'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.ix_wcj_maestro_fecha_date`);
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS wincaja.ix_wcj_maestro_concdates`);
  // Restaura la vista a la expresión previa `fecha::date` (def. 20260716180000).
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH conc_dates AS (
      SELECT DISTINCT tenant_id, source_branch, fecha::date AS d
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
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
    LEFT JOIN conc_dates cd
      ON cd.tenant_id=m.tenant_id AND cd.source_branch=m.source_branch AND cd.d=m.fecha::date
    LEFT JOIN wincaja.branches b ON b.tenant_id=m.tenant_id AND b.source_branch=m.source_branch
    LEFT JOIN catalog.products p ON p.tenant_id=m.tenant_id AND p.sku=d.articulo AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT k.channel, k.es_venta FROM wincaja.caja_channels k
      WHERE k.tenant_id=m.tenant_id AND k.caja=m.caja AND k.source_branch IN (m.source_branch, '*')
      ORDER BY (k.source_branch=m.source_branch) DESC LIMIT 1
    ) cc ON true
    WHERE d.tipo='V' AND d.valor_venta < 10000000 AND d.valor_venta >= 0
      AND COALESCE(d.cantidad_regular,0) < 10000000
      AND COALESCE(m.cancelado,false)=false AND COALESCE(cc.es_venta,true)=true
      AND NOT EXISTS (SELECT 1 FROM wincaja.clientes cli WHERE cli.tenant_id=m.tenant_id AND cli.source_branch=m.source_branch AND cli.source_dataset=m.source_dataset AND cli.cliente=m.tercero AND cli.nombre ILIKE 'ALMAC%')
      AND (m.source_dataset='concentrada' OR cd.d IS NULL)
  `);
  await knex.raw(`DROP FUNCTION IF EXISTS wincaja.fecha_mx_date(timestamptz)`);
};
