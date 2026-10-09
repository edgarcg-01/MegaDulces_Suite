/**
 * `[PF.1]` Flujo de venta de CUALQUIER producto: las consultas, en un archivo sin dependencias para que
 * la prueba de base de datos corra ESTE texto y no una copia.
 *
 * Fuentes, medidas en prod el 2026-10-09 (sólo lectura):
 *  - Historia cerrada: `analytics.mv_kepler_sales_daily` (refresco nocturno). `monto` (venta CON
 *    impuestos) y `units` (unidad base, `kdm2.c9`) coinciden al centavo con la venta del ODS en vivo
 *    (14 de 14 producto×sucursal). `monto_neto` NO: no quita el IEPS. Por eso se compara con impuestos.
 *  - Lo del corte a hoy: directo del ODS, ENTRANDO POR FECHA (`ix_kdm1_venta_fecha` → `ix_kdm2_venta_doc`).
 *    La función `fn_new_products_movimientos` entra por SKU y con los productos que más se venden
 *    recorre toda su historia: 200 productos, un día, 5–5.8 s; por fecha, 73–160 ms, mismas filas.
 *  - Corte: lo que la matvista ya tiene cerrado (como Productos nuevos): antes del corte es historia,
 *    del corte a hoy es en vivo. Así no se cuenta dos veces ni se pierde un día si el nocturno falló.
 * Parámetros con `?` (knex).
 */

/** Hoy en México y el corte de la historia. */
export const CORTE_SQL = `
  SELECT to_char(h.hoy, 'YYYY-MM-DD') AS hoy,
         to_char(least(h.hoy, coalesce((SELECT max(k.business_date) FROM analytics.mv_kepler_sales_daily k
                                         WHERE k.business_date <= h.hoy), h.hoy)), 'YYYY-MM-DD') AS corte
    FROM (SELECT (now() AT TIME ZONE 'America/Mexico_City')::date AS hoy) h`;

/** El corte de Kepler por sucursal, como lo aplican la venta en vivo y Productos nuevos. */
const CON_CORTE_ERP = `
  JOIN analytics.v_branch_erp_cutover x
    ON x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch AND k.business_date >= x.cutover_date`;

/**
 * Lista: por producto y sucursal, la historia cerrada partida en los periodos que se comparan.
 * Parámetros: ids, mesIni, prevIni, prevFin (exclusivo: los mismos días del mes anterior), desde30,
 * desdeHistoria, corte (exclusivo).
 */
export const RESUMEN_HISTORIA_SQL = `
  SELECT k.product_id::text AS product_id, k.source_branch AS plaza,
         coalesce(sum(k.monto) FILTER (WHERE k.business_date >= ?::date), 0) AS mes,
         coalesce(sum(k.monto) FILTER (WHERE k.business_date >= ?::date AND k.business_date < ?::date), 0) AS mes_anterior_mismo,
         coalesce(sum(k.monto) FILTER (WHERE k.business_date >= ?::date AND k.business_date < ?::date), 0) AS mes_anterior_total,
         coalesce(sum(k.monto) FILTER (WHERE k.business_date >= ?::date), 0) AS monto30,
         coalesce(sum(k.units) FILTER (WHERE k.business_date >= ?::date), 0) AS unidades30,
         to_char(max(k.business_date) FILTER (WHERE k.units > 0), 'YYYY-MM-DD') AS ultima
    FROM analytics.mv_kepler_sales_daily k ${CON_CORTE_ERP}
   WHERE k.tenant_id = public.current_tenant_id() AND k.product_id = ANY(?::uuid[])
     AND k.business_date >= ?::date AND k.business_date < ?::date
   GROUP BY 1, 2`;

/** Detalle: la historia cerrada de UN producto, por sucursal y día. Parámetros: id, desde, corte (exclusivo). */
export const HISTORIA_DIARIA_SQL = `
  SELECT k.source_branch AS plaza, to_char(k.business_date, 'YYYY-MM-DD') AS fecha,
         sum(k.monto) AS monto, sum(k.units) AS unidades
    FROM analytics.mv_kepler_sales_daily k ${CON_CORTE_ERP}
   WHERE k.tenant_id = public.current_tenant_id() AND k.product_id = ?::uuid
     AND k.business_date >= ?::date AND k.business_date < ?::date
   GROUP BY 1, 2`;

const N = (c: string) => `nullif(regexp_replace(${c}::text, '[^0-9.-]', '', 'g'), '')::numeric`;

/**
 * La venta en vivo del corte a hoy, por SKU, sucursal y día: las reglas de venta de
 * `fn_new_products_movimientos` (tienda Kepler, `U-D-8/10/12`, almacén principal, sin cancelados ni
 * servicios, desde el corte de Kepler de la sucursal), entrando por fecha. Parámetros: skus, desde, hasta.
 */
export const VENTA_VIVO_SQL = `
  SELECT btrim(l.c8) AS sku, btrim(h.sucursal) AS plaza, to_char(h.c9::date, 'YYYY-MM-DD') AS fecha,
         sum(round(coalesce(${N('l.c13')}, 0), 2)) AS monto, sum(l.c9::numeric) AS unidades
    FROM kepler_ods.kdm1 h
    JOIN kepler_ods.kdm2 l
      ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
     AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
     AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
   WHERE h.c2 = 'U' AND h.c3 = 'D' AND l.c2 = 'U' AND l.c3 = 'D'
     AND btrim(l.c8) = ANY(?::text[])
     AND h.c9::date BETWEEN ?::date AND ?::date
     AND h.c4::integer IN (8, 10, 12)
     AND btrim(h.c1) = btrim(h.sucursal)
     AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
     AND coalesce(btrim(l.c11), '') <> 'SER'
     AND abs(coalesce(l.c9::numeric, 0)) > 0
     AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover c
                  WHERE c.tenant_id = public.current_tenant_id() AND c.kepler_code = btrim(h.sucursal)
                    AND h.c9::date >= c.cutover_date)
   GROUP BY 1, 2, 3`;

/**
 * El kardex (`kdij`) del almacén principal, por sucursal, SKU y rótulo del renglón: el neto y su última
 * fecha, el último ajuste de inventario, la primera y la última compra física (`X-A-40`) y lo comprado
 * desde una fecha. Entra por la llave (`sucursal, c1, c2, c3`). Parámetros: desdeCompras, skus.
 */
export const KARDEX_SQL = `
  SELECT j.sucursal AS plaza, j.c3 AS sku, coalesce(nullif(btrim(j.c12), ''), '\\?') AS unidad,
         sum(CASE WHEN j.c30 = 'E' THEN j.c11 ELSE -j.c11 END)::numeric AS q,
         to_char(max(j.c10), 'YYYY-MM-DD') AS ult,
         to_char(max(j.c10) FILTER (WHERE j.c4 = 'N' AND j.c6 = 30), 'YYYY-MM-DD') AS aj,
         to_char(min(j.c10) FILTER (WHERE j.c4 = 'X' AND j.c5 = 'A' AND j.c6 = 40), 'YYYY-MM-DD') AS primera_compra,
         to_char(max(j.c10) FILTER (WHERE j.c4 = 'X' AND j.c5 = 'A' AND j.c6 = 40), 'YYYY-MM-DD') AS ultima_compra,
         coalesce(sum(j.c11) FILTER (WHERE j.c4 = 'X' AND j.c5 = 'A' AND j.c6 = 40 AND j.c10::date >= ?::date), 0)::numeric AS comprado
    FROM kepler_ods.kdij j
   WHERE j.sucursal = ANY(ARRAY['00', '01', '02', '03', '04', '05', '06', '07', '08'])
     AND j.c1 = j.sucursal AND j.c2 = 1 AND j.c3 = ANY(?::text[]) AND j.c10 IS NOT NULL
   GROUP BY 1, 2, 3`;

/** La existencia de Kepler SIN el piso en cero y el costo estándar de la base (`kdii.c77`). Parámetro: skus. */
export const KDIL_CRUDO_SQL = `
  SELECT d.sucursal AS plaza, d.c3 AS sku, sum(d.c4 + d.c8 - d.c9)::numeric AS kdil,
         (SELECT max(i.c77) FROM kepler_ods.kdii i WHERE i.sucursal = d.sucursal AND i.c1 = d.c3)::numeric AS costo
    FROM kepler_ods.kdil d
   WHERE d.sucursal = d.c1 AND d.c3 = ANY(?::text[])
   GROUP BY 1, 2`;

/** La ficha de Kepler por sucursal (para la escalera de unidades). Parámetro: skus. */
export const FICHAS_SQL = `
  SELECT l.sucursal AS plaza, l.sku, l.u1_label AS u1, l.u2_label AS u2, l.u3_label AS u3,
         l.f2_costo AS f2, l.f3_costo AS f3, l.factor_caja AS uxc
    FROM analytics.v_kepler_unit_ladder l
   WHERE l.sku = ANY(?::text[])`;

/**
 * Salidas `U-D-41` de UN SKU desde una fecha, con su destino (`kdm1.c10`) y su canal (`c27`): a otra
 * sucursal (`TI###`), a camión (`RUTA nn` / `RD nnn`) o remisión de telemarketing (que se factura
 * después como venta). Entra por `ix_kdm2_sku_venta`. Parámetros: sku, desde.
 */
export const SALIDAS_SQL = `
  SELECT btrim(h.sucursal) AS plaza,
         CASE WHEN btrim(h.c10) ~ '^TI[0-9]+$' THEN 'sucursal'
              WHEN btrim(h.c10) ~* '^(RUTA|RD) ' THEN 'ruta'
              ELSE 'otro' END AS destino,
         coalesce(nullif(upper(btrim(l.c11)), ''), '\\?') AS unidad, sum(l.c9::numeric) AS q
    FROM kepler_ods.kdm2 l
    JOIN kepler_ods.kdm1 h
      ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
     AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
     AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
   WHERE l.c2 = 'U' AND l.c3 = 'D' AND btrim(l.c8) = ? AND l.c4::integer = 41
     AND h.c9::date >= ?::date AND btrim(h.c1) = btrim(h.sucursal)
     AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
   GROUP BY 1, 2, 3`;

/** Traspasos recibidos (`U-A-50`) de UN SKU desde una fecha. Entra por `ix_kdm2_sku_abono`. Parámetros: sku, desde. */
export const TRASPASOS_SQL = `
  SELECT btrim(h.sucursal) AS plaza, coalesce(nullif(upper(btrim(l.c11)), ''), '\\?') AS unidad,
         sum(l.c9::numeric) AS q
    FROM kepler_ods.kdm2 l
    JOIN kepler_ods.kdm1 h
      ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
     AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
     AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
   WHERE l.c2 = 'U' AND l.c3 = 'A' AND btrim(l.c8) = ? AND l.c4::integer = 50
     AND h.c9::date >= ?::date AND btrim(h.c1) = btrim(h.sucursal)
     AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
   GROUP BY 1, 2`;

/**
 * `[PF.2]` Líderes: los productos que juntos hacen la primera mitad de la venta de la red en 90 días.
 * Fuente: `analytics.product_sales_stats` (el carril `live` la recalcula cada 30 min). Medido en prod el
 * 2026-10-09: 244 productos hacen el 50% (la clase A, el 80%, son 952: demasiados para "cuidado especial").
 * Es el ranking de NUESTRA venta, no participación de mercado: no hay datos del mercado.
 * Parámetros: corte (fracción acumulada ANTES del producto, p. ej. 0.5), ids (NULL = todos los líderes).
 */
export const LIDERES_SQL = `
  WITH s AS (
    SELECT product_id, revenue_90d, computed_at,
           row_number() OVER (ORDER BY revenue_90d DESC, product_id) AS rank,
           coalesce(sum(revenue_90d) OVER (ORDER BY revenue_90d DESC, product_id
                                          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
             / nullif(sum(revenue_90d) OVER (), 0) AS acum_antes,
           revenue_90d / nullif(sum(revenue_90d) OVER (), 0) AS participacion
      FROM analytics.product_sales_stats
     WHERE tenant_id = public.current_tenant_id() AND revenue_90d > 0
  )
  SELECT s.product_id::text AS product_id, s.rank::int AS rank, s.participacion::float AS participacion,
         s.revenue_90d::float AS venta_90d, s.computed_at
    FROM s
   WHERE s.acum_antes < ?::numeric
     AND (?::uuid[] IS NULL OR s.product_id = ANY(?::uuid[]))`;

/**
 * `[PF.3]` Lotes con fecha de caducidad registrada (andén, revisión de caducidades), por sucursal de Kepler.
 * Fuente: `commercial.stock_lots`. ⚠️ La cantidad es la REGISTRADA: Kepler no descuenta por lote al vender,
 * así que se topa con la existencia de hoy en la lógica. Parámetros: ids (NULL = todos los productos con lote).
 */
export const LOTES_CADUCIDAD_SQL = `
  SELECT l.product_id::text AS product_id, p.sku, p.nombre, w.kepler_code AS plaza, l.lot_code AS lote,
         to_char(l.expiry_date, 'YYYY-MM-DD') AS caduca, l.quantity::float AS cantidad,
         to_char(l.received_at, 'YYYY-MM-DD') AS registrado
    FROM commercial.stock_lots l
    JOIN commercial.warehouses w ON w.id = l.warehouse_id
    JOIN catalog.products p ON p.id = l.product_id
   WHERE l.tenant_id = public.current_tenant_id()
     AND l.expiry_date IS NOT NULL AND l.quantity > 0 AND w.kepler_code IS NOT NULL AND p.sku IS NOT NULL
     AND (?::uuid[] IS NULL OR l.product_id = ANY(?::uuid[]))`;
