'use strict';
/**
 * `[NP.13]` **Productos nuevos: sólo Kepler y en vivo las 24 h.** Rehace `analytics.mv_new_products`.
 *
 * Pedido del usuario (2026-10-08): *"quiero los datos activos 24/7, en vivo"* y *"no los quiero de
 * Wincaja, solo de Kepler"*. La versión anterior (mig `20261007360000`) no aguantaba ni lo uno ni
 * lo otro: mezclaba las cuatro piernas de `v_sellout_daily` y, para saber cuándo vendió cada producto
 * por primera vez, recorría TODA la venta diaria de años.
 *
 * ── Lo medido antes, en producción (sólo lectura, 2026-10-08) ───────────────────────────────
 *  · El cálculo de la matvista anterior pasó de **150 s** (se cortó ahí); en local tardaba 1.4 s.
 *  · Su parte cara: agrupar `v_sellout_daily` por producto y día, **> 60 s** — aun acotado a 7 meses,
 *    porque la vista arrastra el precio de etiqueta de la pierna de ruta.
 *  · Lo de HOY por la función en vivo: **21 ms**. Las unidades de 180 días de ~736 productos: 11 s.
 *  Con esos números no cabía ni en el lote nocturno con holgura, mucho menos en un refresco seguido.
 *
 * ── Lo que cambia ───────────────────────────────────────────────────────────────────────────
 *  1. **Sólo Kepler.** La venta es la venta en tienda de `kepler_ods` (la regla de
 *     `mv_kepler_sales_daily`, con el corte Kepler/Wincaja de cada sucursal) y las entradas `XA2001`.
 *     Sin Wincaja y sin el carril de ruta por push.
 *  2. **La primera venta sale de `mv_kepler_sales_daily`** (la matvista que ya existe, por producto
 *     y día), no de recorrer `v_sellout_daily`. Las SERIES y las unidades salen de la misma función
 *     en vivo (`fn_new_products_movimientos`) sobre 180 días: historia y hoy con UNA regla.
 *  3. **El corte es lo que `mv_kepler_sales_daily` ya tiene cerrado**, no "hoy": la última fecha con
 *     venta que no sea futura. Esa matvista se refresca de noche; si la historia de ésta se cortara
 *     en "hoy" mientras aquélla sigue en ayer, un producto que se estrenó ayer en la tarde no
 *     aparecería. Lo que va del corte a ahora lo trae en vivo la función, en cada consulta.
 *  4. **Lanzamientos en vivo.** Un producto sin NINGUNA actividad Kepler antes del corte que ya se
 *     movió desde el corte entra al universo en el siguiente refresco (cada 30 min), como día 0.
 *  5. **La historia se mide POR SUCURSAL.** Con sólo Kepler, una sucursal que pasó de Wincaja a
 *     Kepler hace poco no tiene cómo afirmar que un producto "no se vendía antes". Por eso la historia
 *     de un producto arranca en el corte (`v_branch_erp_cutover`) de la sucursal CON MÁS historia
 *     entre las que lo movieron: si se vendió en la 03 (Kepler siempre), se sabe; si sólo se movió
 *     en la 08 (Kepler desde 2026-09-18), no hay 90 días para afirmarlo y se declara no medible.
 *     Una sucursal fuera del resolvedor (el CEDIS `00`) no aporta historia.
 *
 * Se refresca cada 30 min en el ciclo de 15 min de `AnalyticsRefreshService` (y además en el lote
 * nocturno, justo después de `mv_kepler_sales_daily`). Nace `WITH NO DATA`: el ciclo la detecta por
 * `relispopulated` y hace el primer poblado sin `CONCURRENTLY`, minutos después de desplegar.
 *
 * ⚠️ La función `analytics.fn_new_products_movimientos` NO cambia (vive en `20261007360000`).
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_new_products';
const FN = 'analytics.fn_new_products_movimientos';
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";
/** Un día con al menos tantas altas en la Suite es una carga masiva, no un lote de altas. */
const ALTAS_POR_DIA_CARGA_MASIVA = 50;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV} CASCADE`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    WITH params AS (
      -- El corte = lo que mv_kepler_sales_daily ya tiene cerrado. Las fechas futuras no cuentan
      -- (kdm1.c9 puede venir adelantada). Antes del corte es historia; del corte a ahora, en vivo.
      SELECT least(${HOY},
                   coalesce((SELECT max(k.business_date) FROM analytics.mv_kepler_sales_daily k
                              WHERE k.business_date <= ${HOY}), ${HOY})) AS corte
    ), plaza_inicio AS (
      -- Desde cuando Kepler manda en cada sucursal. -infinity = siempre (03/04/05).
      SELECT x.tenant_id, x.kepler_code AS plaza, x.cutover_date AS desde
        FROM analytics.v_branch_erp_cutover x
    ), venta_k AS (
      -- Primera venta en tienda Kepler por producto y plaza, de la matvista que ya existe. Todas las
      -- ventas de la tienda, igual que la funcion en vivo (tambien las de vendedores de ruta).
      SELECT k.tenant_id, k.product_id, k.source_branch AS plaza, min(k.business_date) AS primera
        FROM analytics.mv_kepler_sales_daily k
        CROSS JOIN params pa
       WHERE k.product_id IS NOT NULL AND k.product_deleted = false AND k.business_date < pa.corte
         AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                      WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch
                        AND k.business_date >= x.cutover_date)
       GROUP BY 1, 2, 3
    ), cab AS (
      -- La fecha de cada entrada XA2001, del encabezado, con el anti-replica (c1 = sucursal).
      SELECT DISTINCT ON (h.sucursal, btrim(h.c6::text))
             h.sucursal::text AS sucursal, btrim(h.c6::text) AS folio, h.c9::date AS fecha
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20'
         AND btrim(h.c1::text) = h.sucursal::text
         AND btrim(coalesce(h.c43::text, '')) <> 'C'
       ORDER BY h.sucursal, btrim(h.c6::text), h.c9
    ), rec AS (
      SELECT l.tenant_id, p.id AS product_id, btrim(l.sucursal) AS plaza, min(c.fecha) AS primera
        FROM analytics.erp_goods_receipt_lines l
        JOIN cab c ON c.sucursal = l.sucursal AND c.folio = l.folio
        JOIN catalog.products p
          ON p.tenant_id = l.tenant_id AND btrim(p.sku) = l.sku AND p.deleted_at IS NULL
        JOIN params pa ON c.fecha < pa.corte
       GROUP BY 1, 2, 3
    ), primera AS (
      -- Primera actividad de cada producto, y desde cuando hay historia Kepler para afirmarla: la
      -- plaza CON MAS historia entre las que lo movieron (min ignora las que no estan en el resolvedor).
      SELECT a.tenant_id, a.product_id,
             min(a.primera) FILTER (WHERE a.tipo = 'entrada') AS primera_recepcion,
             min(a.primera) FILTER (WHERE a.tipo = 'venta')   AS primera_venta,
             min(pi.desde)                                     AS historia_desde,
             array_agg(DISTINCT CASE a.tipo WHEN 'venta' THEN 'kepler' ELSE 'entradas' END) AS fuentes
        FROM (SELECT tenant_id, product_id, plaza, primera, 'venta'::text AS tipo FROM venta_k
              UNION ALL
              SELECT tenant_id, product_id, plaza, primera, 'entrada'::text FROM rec) a
        LEFT JOIN plaza_inicio pi ON pi.tenant_id = a.tenant_id AND pi.plaza = a.plaza
       GROUP BY 1, 2
    ), sin_historia AS (
      -- Productos SIN ninguna actividad Kepler antes del corte: los unicos que pueden estrenarse hoy.
      SELECT p.tenant_id, btrim(p.sku) AS sku
        FROM catalog.products p
        LEFT JOIN primera pr ON pr.tenant_id = p.tenant_id AND pr.product_id = p.id
       WHERE p.deleted_at IS NULL AND pr.product_id IS NULL
    ), vivo AS (
      -- Lanzamientos EN VIVO: de esos, los que ya se movieron desde el corte (misma funcion que la
      -- pantalla). Entran como dia 0 en el refresco siguiente, sin esperar a la noche.
      SELECT p.tenant_id, p.id AS product_id,
             min(m.fecha)                                   AS primera_viva,
             min(m.fecha) FILTER (WHERE m.tipo = 'entrada') AS recepcion_viva,
             min(m.fecha) FILTER (WHERE m.tipo = 'venta')   AS venta_viva,
             min(pi.desde)                                  AS historia_desde,
             array_agg(DISTINCT CASE m.tipo WHEN 'venta' THEN 'kepler' ELSE 'entradas' END) AS fuentes
        FROM (SELECT tenant_id, array_agg(sku) AS skus FROM sin_historia GROUP BY 1) t
        CROSS JOIN params pa
        CROSS JOIN LATERAL ${FN}(t.tenant_id, t.skus, pa.corte, ${HOY}) m
        JOIN catalog.products p
          ON p.tenant_id = t.tenant_id AND btrim(p.sku) = m.sku AND p.deleted_at IS NULL
        LEFT JOIN plaza_inicio pi ON pi.tenant_id = t.tenant_id AND pi.plaza = m.plaza
       GROUP BY 1, 2
    ), lotes AS (
      -- Dias de CARGA MASIVA en la Suite: su fecha de alta no dice nada del producto.
      SELECT tenant_id, created_at::date AS dia
        FROM catalog.products
       GROUP BY 1, 2
      HAVING count(*) >= ${ALTAS_POR_DIA_CARGA_MASIVA}
    ), universo AS (
      SELECT p.tenant_id, p.id AS product_id, btrim(p.sku) AS sku, p.nombre, p.barcode,
             p.brand_id, p.supplier_id, p.is_promo, p.created_at::date AS alta_suite,
             (lo.dia IS NOT NULL) AS alta_en_lote,
             coalesce(pr.primera_recepcion, v.recepcion_viva) AS primera_recepcion,
             coalesce(pr.primera_venta, v.venta_viva)          AS primera_venta,
             -- LEAST ignora los NULL: un producto sin entradas arranca en su primera venta.
             coalesce(least(pr.primera_recepcion, pr.primera_venta), v.primera_viva) AS lanzamiento,
             coalesce(pr.historia_desde, v.historia_desde)     AS historia_desde,
             coalesce(pr.fuentes, v.fuentes)                   AS fuentes
        FROM catalog.products p
        CROSS JOIN params pa
        LEFT JOIN primera pr ON pr.tenant_id = p.tenant_id AND pr.product_id = p.id
        LEFT JOIN vivo v     ON v.tenant_id = p.tenant_id AND v.product_id = p.id
        LEFT JOIN lotes lo   ON lo.tenant_id = p.tenant_id AND lo.dia = p.created_at::date
       WHERE p.deleted_at IS NULL
         AND (least(pr.primera_recepcion, pr.primera_venta) >= pa.corte - 180
              OR v.product_id IS NOT NULL
              OR (pr.product_id IS NULL
                  AND p.created_at::date >= pa.corte - 90
                  AND p.source = 'kepler'
                  AND lo.dia IS NULL))
    ), kepler AS (
      -- Venta y entradas Kepler de los productos con historia, CON SU UNIDAD: la misma funcion que
      -- trae lo de hoy. 180 dias alcanzan: todo lanzamiento del universo cae dentro de esa ventana.
      SELECT u.tenant_id, u.product_id, k.tipo, k.plaza, k.fecha, k.folio,
             k.unidad, k.cantidad, k.importe
        FROM (SELECT un.tenant_id, array_agg(un.sku) AS skus
                FROM universo un CROSS JOIN params p1
               WHERE un.lanzamiento IS NOT NULL AND un.lanzamiento < p1.corte
               GROUP BY 1) t
        CROSS JOIN params pa
        CROSS JOIN LATERAL ${FN}(t.tenant_id, t.skus, pa.corte - 180, pa.corte - 1) k
        JOIN universo u ON u.tenant_id = t.tenant_id AND u.sku = k.sku
    ), codigos AS (
      -- Para la senal de recodificacion: el alta mas vieja de cada codigo de barras.
      SELECT tenant_id, btrim(barcode) AS barcode, min(created_at::date) AS primera_alta
        FROM catalog.products
       WHERE deleted_at IS NULL AND length(btrim(coalesce(barcode, ''))) >= 8
       GROUP BY 1, 2
    ), dias AS (
      -- Un renglon por dia, del lanzamiento a la vispera del corte: la rejilla de la serie.
      SELECT u.tenant_id, u.product_id, d::date AS fecha
        FROM universo u
        CROSS JOIN params pa
        CROSS JOIN LATERAL generate_series(u.lanzamiento, pa.corte - 1, interval '1 day') d
       WHERE u.lanzamiento IS NOT NULL AND u.lanzamiento < pa.corte
    ), venta_prod_dia AS (
      SELECT tenant_id, product_id, fecha, sum(importe) AS monto
        FROM kepler WHERE tipo = 'venta'
       GROUP BY 1, 2, 3
    ), serie AS (
      SELECT d.tenant_id, d.product_id,
             array_agg(round(coalesce(v.monto, 0), 2) ORDER BY d.fecha) AS venta_dia
        FROM dias d
        LEFT JOIN venta_prod_dia v
          ON v.tenant_id = d.tenant_id AND v.product_id = d.product_id AND v.fecha = d.fecha
       GROUP BY 1, 2
    ), venta_plaza_dia AS (
      SELECT tenant_id, product_id, plaza, fecha, sum(importe) AS monto
        FROM kepler WHERE tipo = 'venta'
       GROUP BY 1, 2, 3, 4
    ), serie_plaza AS (
      SELECT d.tenant_id, d.product_id, pl.plaza,
             array_agg(round(coalesce(v.monto, 0), 2) ORDER BY d.fecha) AS serie
        FROM dias d
        JOIN (SELECT DISTINCT tenant_id, product_id, plaza FROM venta_plaza_dia) pl
          ON pl.tenant_id = d.tenant_id AND pl.product_id = d.product_id
        LEFT JOIN venta_plaza_dia v
          ON v.tenant_id = d.tenant_id AND v.product_id = d.product_id
         AND v.plaza = pl.plaza AND v.fecha = d.fecha
       GROUP BY 1, 2, 3
    ), por_plaza AS (
      SELECT tenant_id, product_id, jsonb_object_agg(plaza, serie) AS venta_por_plaza
        FROM serie_plaza
       GROUP BY 1, 2
    ), venta_unidades AS (
      -- Cuanto se vendio en cada unidad, por plaza, y cuantos pesos cubren esas unidades. Cada
      -- rotulo por su lado: cajas y piezas no se suman.
      SELECT p.tenant_id, p.product_id,
             jsonb_object_agg(p.plaza, jsonb_build_object('u', p.u, 'i', round(p.i, 2))) AS venta_unidades
        FROM (SELECT q.tenant_id, q.product_id, q.plaza,
                     jsonb_object_agg(coalesce(q.unidad, '?'), round(q.cantidad, 3)) AS u,
                     sum(q.importe) AS i
                FROM (SELECT tenant_id, product_id, plaza, unidad,
                             sum(cantidad) AS cantidad, sum(importe) AS importe
                        FROM kepler WHERE tipo = 'venta'
                       GROUP BY 1, 2, 3, 4) q
               GROUP BY 1, 2, 3) p
       GROUP BY 1, 2
    ), entradas AS (
      SELECT e.tenant_id, e.product_id,
             jsonb_agg(jsonb_build_object(
               'f', to_char(e.fecha, 'YYYY-MM-DD'), 'p', e.plaza, 'folio', e.folio,
               'i', round(e.importe, 2), 'u', e.u) ORDER BY e.fecha, e.plaza, e.folio) AS entradas
        FROM (SELECT tenant_id, product_id, plaza, fecha, folio, sum(importe) AS importe,
                     jsonb_object_agg(coalesce(unidad, '?'), round(cantidad, 3)) AS u
                FROM kepler WHERE tipo = 'entrada'
               GROUP BY 1, 2, 3, 4, 5) e
       GROUP BY 1, 2
    )
    SELECT
      u.tenant_id, u.product_id, u.sku, u.nombre, u.brand_id, b.nombre AS marca,
      u.supplier_id, sp.name AS proveedor,
      u.alta_suite, u.alta_en_lote, u.primera_recepcion, u.primera_venta, u.lanzamiento,
      u.historia_desde, coalesce(u.fuentes, ARRAY[]::text[])            AS fuentes,
      (u.lanzamiento IS NULL)                                             AS sin_movimiento,
      -- Sin 90 dias de historia Kepler (en la plaza con mas historia) antes del lanzamiento, no se
      -- puede afirmar que antes no se movia: se declara, no se cuenta como nuevo.
      (u.lanzamiento IS NOT NULL AND (u.historia_desde IS NULL OR u.historia_desde > u.lanzamiento - 90))
                                                                          AS no_medible,
      CASE
        WHEN u.is_promo                                  THEN 'promocion'
        WHEN btrim(u.nombre) ~* '^\\*{0,3}\\s*DESC'      THEN 'descuento'
        WHEN u.nombre ILIKE '%DESCONTINUADO%'            THEN 'descontinuado'
      END                                                                 AS exclusion_auto,
      coalesce(cb.primera_alta < u.alta_suite, false)                     AS posible_recodificacion,
      pa.corte,
      coalesce(s.venta_dia, ARRAY[]::numeric[])                           AS venta_dia,
      coalesce(pp.venta_por_plaza, '{}'::jsonb)                           AS venta_por_plaza,
      coalesce(vu.venta_unidades, '{}'::jsonb)                            AS venta_unidades,
      coalesce(e.entradas, '[]'::jsonb)                                   AS entradas,
      now()                                                               AS calculado_at
      FROM universo u
      CROSS JOIN params pa
      LEFT JOIN catalog.brands b     ON b.id = u.brand_id
      LEFT JOIN catalog.suppliers sp ON sp.id = u.supplier_id AND sp.tenant_id = u.tenant_id
      LEFT JOIN serie s      ON s.tenant_id = u.tenant_id AND s.product_id = u.product_id
      LEFT JOIN por_plaza pp ON pp.tenant_id = u.tenant_id AND pp.product_id = u.product_id
      LEFT JOIN venta_unidades vu ON vu.tenant_id = u.tenant_id AND vu.product_id = u.product_id
      LEFT JOIN entradas e   ON e.tenant_id = u.tenant_id AND e.product_id = u.product_id
      LEFT JOIN codigos cb   ON cb.tenant_id = u.tenant_id AND cb.barcode = btrim(u.barcode)
    WITH NO DATA
  `);

  // UNIQUE sin WHERE: lo exige REFRESH ... CONCURRENTLY, que es como la refresca el ciclo.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_new_products ON ${MV} (tenant_id, product_id)`);
  await knex.raw(`CREATE INDEX ix_mv_new_products_sku ON ${MV} (sku)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  // `GRANT ... ON ALL TABLES` no cubre matvistas: las cuentas de lectura de los devs van aparte.
  await knex.raw(`
    DO $do$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        EXECUTE 'GRANT SELECT ON ${MV} TO dev_ro';
      END IF;
    END $do$`);

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW ${MV} IS
      '[NP.13] Productos nuevos, SOLO KEPLER: primera actividad (entrada XA2001 o venta en tienda) en los '
      'ultimos 180 dias, lanzamientos detectados en vivo desde el corte, o sin movimiento y vistos por la '
      'Suite en 90. Corte = lo que mv_kepler_sales_daily ya tiene cerrado. Historia por SUCURSAL segun '
      'v_branch_erp_cutover. Series y unidades de fn_new_products_movimientos (la misma que trae lo de hoy). '
      'Sin Wincaja ni ruta por push. Se refresca cada 30 min y en el lote nocturno.'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: vuelve a la matvista de `20261007360000` (que también
 * recrea la función, idéntica).
 */
exports.down = async function down(knex) {
  await require('./20261007360000_np_mv_new_products.js').up(knex);
};
