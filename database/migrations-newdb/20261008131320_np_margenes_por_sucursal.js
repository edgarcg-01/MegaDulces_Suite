'use strict';
/**
 * `[NP.15]` — **Productos nuevos: los tres márgenes y dónde se mueve mejor.** Pedido del jefe de
 * Compras (2026-10-08): ver márgenes de los productos nuevos, y en qué sucursal se mueve mejor cada
 * uno. Se publican TRES, cada uno contesta otra pregunta:
 *
 *  1. **De lista** — ¿con qué margen lo pusimos a la venta? La meta de la ficha de Kepler
 *     (`analytics.v_kepler_margin_target`, ya convertida de markup a margen sobre venta) ponderada
 *     por la venta de cada peldaño que de verdad se vendió (pieza, paquete, caja): la caja lleva
 *     ~8 pp menos de margen que la pieza, y promediar el peldaño base mentiría (VERDAD §16.8).
 *  2. **Real** — ¿cuánto dejó? Venta sin impuesto menos el costo que Kepler escribió EN el renglón
 *     (`kdm2.c62`). Las mismas dos fórmulas de `analytics.mv_erp_margin_daily` (`[MR.8.2]`):
 *       · venta neta = `c13 / (1 + |c17|/100 + |c18|/100)` — el importe de VENTA trae IVA/IEPS.
 *       · costo      = `c62 × coalesce(c56, c9)` — `c62` cuesta UNA unidad del peldaño vendido.
 *  3. **Sobre lo pagado** — ¿la ficha tiene el costo correcto? Se arma en el servidor con lo que
 *     esta matvista deja listo: lo comprado por unidad base (`compra_base`) y lo vendido por unidad
 *     base (`margen_plaza.*.b`). Sólo se compara cuando la compra y la venta declaran la MISMA
 *     unidad base: Kepler a veces no lo hace (`FASE_CE` §2.5) y entonces se declara.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-08) ──────────────────────────────────────
 *  · El importe de COMPRA (`XA2001`) viene SIN impuesto: Σ renglones + IVA + IEPS del encabezado =
 *    total en 256 de 259 documentos de una semana. Por eso la compra NO se divide; la venta sí.
 *  · Muestra de 3 productos nuevos: la venta neta y el costo de esta regla coinciden con
 *    `mv_erp_margin_daily` al centavo en las plazas 01/02/03/07. En 06/08 aquélla cuenta además
 *    días anteriores a que la plaza pasara a Kepler, que esta pantalla excluye a propósito; en la
 *    05 quedan $230 sin explicar (pendiente, declarado).
 *  · `kdm2.c62` falta en mucha venta de mayoreo (`U-D-8`): en un producto, sólo el 6% de la venta
 *    de una plaza traía costo. Por eso el margen real lleva SU cobertura (`nc` contra `n`), y la
 *    venta sin costo NO entra al promedio como margen cero.
 *  · La meta trae peldaños repetidos con el mismo factor (la base y una Unidad Dos de factor 1):
 *    sin quitarlos la cobertura daba hasta 200%. Se toma un margen por (plaza, SKU, factor), y si
 *    hubiera dos DISTINTOS para el mismo factor (27 casos en todo el universo) no se adivina: queda
 *    fuera de la cobertura. Leer la meta de los ~1,200 productos cuesta ~0.7 s.
 *
 * ── Lo que cambia ───────────────────────────────────────────────────────────────────────────
 *  · La función `fn_new_products_movimientos` devuelve además `factor`, `importe_neto`, `costo`,
 *    `importe_neto_costeado`, `cantidad_base` y `unidad_base`. Cambiar las columnas de salida exige
 *    DROP + CREATE, y el DROP se lleva la matvista (es la única que depende de ella; verificado en
 *    prod con `pg_depend`). Sigue en `plpgsql` con `force_custom_plan` y `ROWS 10000` (`[NP.14]`).
 *  · La matvista es la de `[NP.14]` más dos columnas jsonb: `margen_plaza` y `compra_base`.
 *    ⚠️ Lo de HOY no entra en los márgenes: se calculan sobre la historia (hasta la víspera del
 *    corte) y la pantalla lo dice.
 *
 * ⚠️ Si un REFRESH de la matvista está corriendo, el DROP espera 5 s y la migración falla entera.
 * ⚠️ Nace `WITH NO DATA`; el ciclo la puebla en el siguiente tick (una vacía no espera cadencia).
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_new_products';
const FN = 'analytics.fn_new_products_movimientos';
const FIRMA = `${FN}(uuid, text[], date, date)`;
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";
/** Un día con al menos tantas altas en la Suite es una carga masiva, no un lote de altas. */
const ALTAS_POR_DIA_CARGA_MASIVA = 50;

/** Numérico de Kepler (texto con formato), preservando NULL: "no declarado" no es cero. */
const N = (col) => `nullif(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric`;
const IMPORTE = `round(coalesce(${N('l.c13')}, 0), 2)`;
/** El renglón declara su unidad de compra/venta y su identidad c9 = c56 × c58 se cumple. */
const DECLARA = `(nullif(btrim(l.c55::text), '') IS NOT NULL AND ${N('l.c56')} <> 0 AND ${N('l.c58')} > 0
                  AND abs(l.c9::numeric - ${N('l.c56')} * ${N('l.c58')}) <= 0.001)`;
const UNIDAD = `CASE WHEN ${DECLARA} THEN upper(btrim(l.c55::text))
                     ELSE upper(nullif(btrim(l.c11::text), '')) END`;
const CANTIDAD = `CASE WHEN ${DECLARA} THEN ${N('l.c56')} ELSE l.c9::numeric END`;
/** El peldaño vendido, en unidades base: el factor con el que se cruza la meta de la ficha. */
const FACTOR = `round(CASE WHEN ${DECLARA} THEN ${N('l.c58')} ELSE 1 END, 4)`;
const UNIDAD_BASE = `upper(nullif(btrim(l.c11::text), ''))`;
/** Venta neta: el importe de VENTA trae IVA (c17) e IEPS (c18). Misma fórmula que mv_erp_margin_daily. */
const NETO_VENTA = `${IMPORTE} / (1 + abs(coalesce(${N('l.c17')}, 0)) / 100 + abs(coalesce(${N('l.c18')}, 0)) / 100)`;
/** El costo que Kepler escribió en el renglón, por la cantidad del peldaño que cuesta. Igual que mv_erp_margin_daily. */
const COSTO_VENTA = `CASE WHEN ${N('l.c62')} > 0 THEN ${N('l.c62')} * coalesce(${N('l.c56')}, l.c9::numeric) END`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La función, con las columnas del margen ────────────────────────────────────────────
  // DROP + CREATE porque cambian las columnas de salida; se lleva la matvista (la única que la usa).
  await knex.raw(`DROP FUNCTION IF EXISTS ${FIRMA} CASCADE`);
  await knex.raw(`
    CREATE FUNCTION ${FN}(p_tenant uuid, p_skus text[], p_desde date, p_hasta date)
    RETURNS TABLE (sku text, tipo text, plaza text, fecha date, folio text,
                   unidad text, factor numeric, cantidad numeric, importe numeric,
                   importe_neto numeric, costo numeric, importe_neto_costeado numeric,
                   cantidad_base numeric, unidad_base text)
    LANGUAGE plpgsql STABLE
    ROWS 10000
    SET plan_cache_mode = force_custom_plan
    AS $np15$
#variable_conflict use_column
BEGIN
  RETURN QUERY
      SELECT x.sku, x.tipo, x.plaza, x.fecha, x.folio, x.unidad, x.factor,
             round(sum(x.cantidad), 4), sum(x.importe),
             round(sum(x.importe_neto), 4),
             round(sum(x.costo), 4),
             round(sum(x.importe_neto) FILTER (WHERE x.costo IS NOT NULL), 4),
             round(sum(x.cantidad_base), 4),
             x.unidad_base
        FROM (
          -- VENTA en tienda: la definicion de mv_kepler_sales_daily + el corte de v_sellout_daily.
          SELECT btrim(l.c8) AS sku, 'venta'::text AS tipo, btrim(h.sucursal) AS plaza,
                 h.c9::date AS fecha, NULL::text AS folio,
                 ${UNIDAD} AS unidad, ${FACTOR} AS factor, ${CANTIDAD} AS cantidad, ${IMPORTE} AS importe,
                 ${NETO_VENTA} AS importe_neto, ${COSTO_VENTA} AS costo,
                 l.c9::numeric AS cantidad_base, ${UNIDAD_BASE} AS unidad_base
            FROM kepler_ods.kdm1 h
            JOIN kepler_ods.kdm2 l
              ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
             AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
             AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
           WHERE l.c2 = 'U' AND l.c3 = 'D' AND btrim(l.c8) = ANY(p_skus)
             AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer IN (8, 10, 12)
             AND h.c9::date BETWEEN p_desde AND least(p_hasta, ${HOY})
             AND btrim(h.c1) = btrim(h.sucursal)
             AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
             AND coalesce(btrim(l.c11), '') <> 'SER'
             AND abs(coalesce(l.c9::numeric, 0)) > 0
             AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover c
                          WHERE c.tenant_id = p_tenant AND c.kepler_code = btrim(h.sucursal)
                            AND h.c9::date >= c.cutover_date)
          UNION ALL
          -- ENTRADAS: el filtro de erp_goods_receipt_lines, con la llave completa del renglon.
          -- El importe de COMPRA ya viene SIN impuesto (medido: 256 de 259 documentos): no se divide.
          SELECT nullif(btrim(l.c8::text), ''), 'entrada'::text, btrim(h.sucursal::text),
                 h.c9::date, btrim(h.c6::text),
                 ${UNIDAD}, ${FACTOR}, ${CANTIDAD}, ${IMPORTE},
                 ${IMPORTE}, NULL::numeric,
                 l.c9::numeric, ${UNIDAD_BASE}
            FROM kepler_ods.kdm1 h
            JOIN kepler_ods.kdm2 l
              ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
             AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
           WHERE nullif(btrim(l.c8::text), '') = ANY(p_skus)
             AND h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20'
             AND h.c9::date BETWEEN p_desde AND p_hasta
             AND btrim(h.c1::text) = h.sucursal::text
             AND btrim(coalesce(h.c43::text, '')) <> 'C'
        ) x
       GROUP BY x.sku, x.tipo, x.plaza, x.fecha, x.folio, x.unidad, x.factor, x.unidad_base;
END
$np15$`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION ${FIRMA} TO app_runtime`);
  await knex.raw(`
    COMMENT ON FUNCTION ${FIRMA} IS
      '[NP.15] Venta en tienda (reglas de mv_kepler_sales_daily + corte de v_branch_erp_cutover) y '
      'entradas XA2001 de una lista de SKUs, con la UNIDAD del renglon, el peldano vendido (factor), la '
      'venta neta de IVA/IEPS, el costo del renglon (c62 x c56) y la cantidad en unidad base. La usan '
      'mv_new_products (historia) y el servidor (lo de hoy). plpgsql + force_custom_plan [NP.14].'`);

  // ── 2. La matvista: la de [NP.14] más margen_plaza y compra_base ──────────────────────────
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
      -- Por SKU, sin unirse al universo: se agrupa primero y se une al final ([NP.14]).
      SELECT t.tenant_id, k.sku, k.tipo, k.plaza, k.fecha, k.folio, k.unidad, k.factor,
             k.cantidad, k.importe, k.importe_neto, k.costo, k.importe_neto_costeado,
             k.cantidad_base, k.unidad_base
        FROM (SELECT un.tenant_id, array_agg(un.sku) AS skus
                FROM universo un CROSS JOIN params p1
               WHERE un.lanzamiento IS NOT NULL AND un.lanzamiento < p1.corte
               GROUP BY 1) t
        CROSS JOIN params pa
        CROSS JOIN LATERAL ${FN}(t.tenant_id, t.skus, pa.corte - 180, pa.corte - 1) k
    ), codigos AS (
      -- Para la senal de recodificacion: el alta mas vieja de cada codigo de barras.
      SELECT tenant_id, btrim(barcode) AS barcode, min(created_at::date) AS primera_alta
        FROM catalog.products
       WHERE deleted_at IS NULL AND length(btrim(coalesce(barcode, ''))) >= 8
       GROUP BY 1, 2
    ), mapa_dia AS (
      -- La venta de cada dia como mapa fecha -> pesos. La serie se arma buscando cada dia en el
      -- mapa: no hay rejilla de dias unida contra la venta ([NP.14]).
      SELECT v.tenant_id, v.sku, jsonb_object_agg(v.fecha::text, v.monto) AS m
        FROM (SELECT tenant_id, sku, fecha, sum(importe) AS monto
                FROM kepler WHERE tipo = 'venta'
               GROUP BY 1, 2, 3) v
       GROUP BY 1, 2
    ), mapa_plaza_dia AS (
      SELECT v.tenant_id, v.sku, v.plaza, jsonb_object_agg(v.fecha::text, v.monto) AS m
        FROM (SELECT tenant_id, sku, plaza, fecha, sum(importe) AS monto
                FROM kepler WHERE tipo = 'venta'
               GROUP BY 1, 2, 3, 4) v
       GROUP BY 1, 2, 3
    ), por_plaza AS (
      -- Una serie por cada plaza donde se vendio, del lanzamiento del PRODUCTO a la vispera del corte.
      SELECT u.tenant_id, u.product_id,
             jsonb_object_agg(mp.plaza, ARRAY(
               SELECT round(coalesce((mp.m ->> d::date::text)::numeric, 0), 2)
                 FROM generate_series(u.lanzamiento, pa.corte - 1, interval '1 day') d
                ORDER BY d)) AS venta_por_plaza
        FROM mapa_plaza_dia mp
        JOIN universo u ON u.tenant_id = mp.tenant_id AND u.sku = mp.sku
        CROSS JOIN params pa
       WHERE u.lanzamiento < pa.corte
       GROUP BY 1, 2
    ), venta_unidades AS (
      -- Cuanto se vendio en cada unidad, por plaza, y cuantos pesos cubren esas unidades. Cada
      -- rotulo por su lado: cajas y piezas no se suman.
      SELECT p.tenant_id, p.sku,
             jsonb_object_agg(p.plaza, jsonb_build_object('u', p.u, 'i', round(p.i, 2))) AS venta_unidades
        FROM (SELECT q.tenant_id, q.sku, q.plaza,
                     jsonb_object_agg(coalesce(q.unidad, '\\?'), round(q.cantidad, 3)) AS u,
                     sum(q.importe) AS i
                FROM (SELECT tenant_id, sku, plaza, unidad,
                             sum(cantidad) AS cantidad, sum(importe) AS importe
                        FROM kepler WHERE tipo = 'venta'
                       GROUP BY 1, 2, 3, 4) q
               GROUP BY 1, 2, 3) p
       GROUP BY 1, 2
    ), entradas AS (
      SELECT e.tenant_id, e.sku,
             jsonb_agg(jsonb_build_object(
               'f', to_char(e.fecha, 'YYYY-MM-DD'), 'p', e.plaza, 'folio', e.folio,
               'i', round(e.importe, 2), 'u', e.u) ORDER BY e.fecha, e.plaza, e.folio) AS entradas
        FROM (SELECT tenant_id, sku, plaza, fecha, folio, sum(importe) AS importe,
                     jsonb_object_agg(coalesce(unidad, '\\?'), round(cantidad, 3)) AS u
                FROM kepler WHERE tipo = 'entrada'
               GROUP BY 1, 2, 3, 4, 5) e
       GROUP BY 1, 2
    ), meta AS (
      -- [NP.15] La meta de margen de la ficha, un valor por (plaza, SKU, peldano). La escalera trae
      -- peldanos repetidos con el mismo factor (la base y una Unidad Dos de factor 1): se toma uno.
      -- Si para el mismo factor hubiera DOS margenes distintos no se adivina: queda fuera.
      SELECT t.sucursal, t.sku, round(t.factor, 4) AS factor, min(t.margen_venta_pct) AS margen
        FROM analytics.v_kepler_margin_target t
       WHERE t.veredicto = 'capturado' AND t.factor IS NOT NULL
       GROUP BY 1, 2, 3
      HAVING count(DISTINCT t.margen_venta_pct) = 1
    ), plaza_venta AS (
      -- [NP.15] Por plaza: venta neta, la parte que trae costo, y ese costo.
      SELECT tenant_id, sku, plaza,
             sum(importe_neto) AS n, sum(importe_neto_costeado) AS nc, sum(costo) AS c
        FROM kepler WHERE tipo = 'venta'
       GROUP BY 1, 2, 3
    ), plaza_meta AS (
      -- [NP.15] La meta ponderada por la venta neta de cada peldano VENDIDO.
      SELECT k.tenant_id, k.sku, k.plaza,
             sum(k.n) FILTER (WHERE mt.margen IS NOT NULL) AS nm,
             sum(k.n * mt.margen / 100)                    AS m
        FROM (SELECT tenant_id, sku, plaza, factor, sum(importe_neto) AS n
                FROM kepler WHERE tipo = 'venta'
               GROUP BY 1, 2, 3, 4) k
        LEFT JOIN meta mt ON mt.sucursal = k.plaza AND mt.sku = k.sku AND mt.factor = k.factor
       GROUP BY 1, 2, 3
    ), plaza_base AS (
      -- [NP.15] Lo vendido en UNIDAD BASE (c9, rotulo c11), con su venta neta: el margen sobre lo
      -- pagado lo cruza con la compra en la MISMA unidad base.
      SELECT q.tenant_id, q.sku, q.plaza,
             jsonb_object_agg(coalesce(q.unidad_base, '\\?'),
                              jsonb_build_object('q', round(q.q, 4), 'n', round(q.n, 4))) AS b
        FROM (SELECT tenant_id, sku, plaza, unidad_base,
                     sum(cantidad_base) AS q, sum(importe_neto) AS n
                FROM kepler WHERE tipo = 'venta'
               GROUP BY 1, 2, 3, 4) q
       GROUP BY 1, 2, 3
    ), margen_plaza AS (
      SELECT v.tenant_id, v.sku,
             jsonb_object_agg(v.plaza, jsonb_build_object(
               'n',  round(v.n, 2),
               'nc', round(coalesce(v.nc, 0), 2),
               'c',  round(coalesce(v.c, 0), 2),
               'nm', round(coalesce(m.nm, 0), 2),
               'm',  round(coalesce(m.m, 0), 2),
               'b',  coalesce(b.b, '{}'::jsonb))) AS margen_plaza
        FROM plaza_venta v
        LEFT JOIN plaza_meta m ON m.tenant_id = v.tenant_id AND m.sku = v.sku AND m.plaza = v.plaza
        LEFT JOIN plaza_base b ON b.tenant_id = v.tenant_id AND b.sku = v.sku AND b.plaza = v.plaza
       GROUP BY 1, 2
    ), compra_base AS (
      -- [NP.15] Lo comprado (entradas XA2001) en UNIDAD BASE, con su importe SIN impuesto.
      SELECT q.tenant_id, q.sku,
             jsonb_object_agg(coalesce(q.unidad_base, '\\?'),
                              jsonb_build_object('q', round(q.q, 4), 'i', round(q.i, 2))) AS compra_base
        FROM (SELECT tenant_id, sku, unidad_base,
                     sum(cantidad_base) AS q, sum(importe_neto) AS i
                FROM kepler WHERE tipo = 'entrada'
               GROUP BY 1, 2, 3) q
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
      -- Del lanzamiento a la vispera del corte, en ceros si no vendio; vacia si se estrena desde el corte.
      CASE WHEN u.lanzamiento < pa.corte THEN ARRAY(
             SELECT round(coalesce((md.m ->> d::date::text)::numeric, 0), 2)
               FROM generate_series(u.lanzamiento, pa.corte - 1, interval '1 day') d
              ORDER BY d)
           ELSE ARRAY[]::numeric[] END                                    AS venta_dia,
      coalesce(pp.venta_por_plaza, '{}'::jsonb)                           AS venta_por_plaza,
      coalesce(vu.venta_unidades, '{}'::jsonb)                            AS venta_unidades,
      coalesce(e.entradas, '[]'::jsonb)                                   AS entradas,
      coalesce(mpz.margen_plaza, '{}'::jsonb)                             AS margen_plaza,
      coalesce(cbs.compra_base, '{}'::jsonb)                              AS compra_base,
      now()                                                               AS calculado_at
      FROM universo u
      CROSS JOIN params pa
      LEFT JOIN catalog.brands b     ON b.id = u.brand_id
      LEFT JOIN catalog.suppliers sp ON sp.id = u.supplier_id AND sp.tenant_id = u.tenant_id
      LEFT JOIN mapa_dia md          ON md.tenant_id = u.tenant_id AND md.sku = u.sku
      LEFT JOIN por_plaza pp         ON pp.tenant_id = u.tenant_id AND pp.product_id = u.product_id
      LEFT JOIN venta_unidades vu    ON vu.tenant_id = u.tenant_id AND vu.sku = u.sku
      LEFT JOIN entradas e           ON e.tenant_id = u.tenant_id AND e.sku = u.sku
      LEFT JOIN margen_plaza mpz     ON mpz.tenant_id = u.tenant_id AND mpz.sku = u.sku
      LEFT JOIN compra_base cbs      ON cbs.tenant_id = u.tenant_id AND cbs.sku = u.sku
      LEFT JOIN codigos cb           ON cb.tenant_id = u.tenant_id AND cb.barcode = btrim(u.barcode)
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
      '[NP.15] Productos nuevos, SOLO KEPLER: primera actividad (entrada XA2001 o venta en tienda) en los '
      'ultimos 180 dias, lanzamientos detectados en vivo desde el corte, o sin movimiento y vistos por la '
      'Suite en 90. Corte = lo que mv_kepler_sales_daily ya tiene cerrado. Historia por SUCURSAL segun '
      'v_branch_erp_cutover. Series, unidades y margenes de fn_new_products_movimientos. margen_plaza: por '
      'plaza, venta neta (n), la que trae costo (nc), su costo (c), la que tiene meta (nm), los pesos de '
      'margen meta (m) y lo vendido por unidad base (b). compra_base: lo comprado por unidad base.'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: vuelve a la función y la matvista de `[NP.14]`. Como la
 * función original cambia de columnas, se reconstruye la cadena: la función SQL de `20261007360000`,
 * la matvista de `[NP.13]` y el envoltorio `plpgsql` de `[NP.14]`.
 */
exports.down = async function down(knex) {
  await require('./20261007360000_np_mv_new_products.js').up(knex);
  await require('./20261008091317_np_mv_new_products_kepler_vivo.js').up(knex);
  await require('./20261008111426_np_mv_new_products_sin_cruce.js').up(knex);
};
