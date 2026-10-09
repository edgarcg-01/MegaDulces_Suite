'use strict';
/**
 * `[NP.16]` — **Productos nuevos: cuándo llegó a la empresa, cómo se repartió, y las unidades
 * vendidas en cada corte.** Pedido de Compras (2026-10-09), sobre la pantalla de `[NP.15]`:
 *  · en el comportamiento global, el día que la mercancía LLEGÓ a la empresa, buscado en la base;
 *  · en la tabla de 30·60·90 días y en "¿Dónde se mueve mejor?", las cajas y piezas vendidas;
 *  · arriba de "Por sucursal", lo que nos llegó en total y cuánto le tocó a cada sucursal.
 * Todo en las unidades que registró Kepler en cada documento, sin convertir.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-09) ──────────────────────────────────────
 *  · **La llegada se busca en el kardex (`kepler_ods.kdij`).** Es la historia de movimientos de
 *    inventario por almacén: `c1` = almacén, `c2` = 1 siempre, `c3` = SKU, `c4-c5-c6` = tipo de
 *    documento, `c10` = fecha, `c30` = 'E'/'S'. Barrido sobre los 1,207 productos nuevos con
 *    movimiento (0.8 s por su llave): la primera entrada es una COMPRA (`X-A-40`, la orden de
 *    entrada, donde entra el inventario) en 837; un ajuste de inventario (`N-A-30`) en 97; un
 *    traspaso recibido (`U-A-50`) en 71; otros 20. 182 no tienen kardex en almacén principal.
 *  · **La pantalla fechaba la compra con la APLICACIÓN contable (`X-A-20`)**, que llega días
 *    después de la entrada física: en 33 productos el kardex trae una entrada anterior (uno, 3 meses).
 *  · **El reparto entre sucursales son dos documentos que cuadran:** la sucursal que compra manda
 *    con `U-D-41` cuyo destino (`kdm1.c10`) es `TI###`, y la que recibe registra `U-A-50`. Producto
 *    de muestra: 26 cajas mandadas = 26 cajas recibidas.
 *  · **`U-D-41` NO es sólo traspaso.** En un mes: 804 a sucursal (`TI###`), 265 a camión de ruta
 *    (`RUTA nn` / `RD nnn`) y 1,207 remisiones a clientes de telemarketing (`c27 = TELEMARK`). Ésas
 *    se facturan después como `U-D-8` a los mismos clientes (verificado: 300 piezas de cada lado),
 *    o sea que YA son venta: aquí no entran, contarlas sería contarlas dos veces.
 *
 * ── Lo que cambia ───────────────────────────────────────────────────────────────────────────
 *  · La función trae tres tipos más: `traspaso` (U-A-50 recibido en el almacén principal),
 *    `salida_sucursal` (U-D-41 a `TI###`) y `salida_ruta` (U-D-41 a `RUTA`/`RD`). Mismas columnas
 *    de salida que `[NP.15]`. Los lanzamientos en vivo siguen contando sólo venta y compra.
 *    La salida va en la MISMA pasada que la venta (los dos son encabezados `U-D`): en su propia rama
 *    volvía a recorrer los 180 días de encabezados de venta, que es lo más caro del cálculo. El
 *    traspaso entra por el índice de abonos por SKU: medido en prod, 118 ms para los ~1,200
 *    productos (3,289 renglones).
 *  · La matvista agrega `llegada` (el barrido del kardex: primera compra física y en qué sucursales,
 *    y la primera entrada de cualquier tipo), `venta_unidades_hito` (unidades vendidas en los
 *    primeros 30/60/90 días) y `reparto` (por sucursal: recibido de otra, mandado a otras y a rutas).
 *
 * ⚠️ Si un REFRESH de la matvista está corriendo, el DROP espera 5 s y la migración falla entera.
 * ⚠️ Nace `WITH NO DATA`; el ciclo la puebla en el siguiente tick.
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

  // ── 1. La función, con traspasos y salidas ────────────────────────────────────────────
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
    AS $np16$
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
          -- [NP.16] En la MISMA pasada, la SALIDA U-D-41 a otra sucursal (destino TI###) o a camion de
          -- ruta (RUTA nn / RD nnn). La remision a cliente de telemarketing NO entra: se factura como
          -- U-D-8 y ya es venta. Una pasada y no dos: recorrer otra vez los 180 dias de encabezados U-D
          -- duplicaba el trabajo mas caro de la matvista.
          SELECT btrim(l.c8) AS sku,
                 CASE WHEN h.c4::integer <> 41 THEN 'venta'
                      WHEN btrim(h.c10) ~ '^TI[0-9]+$' THEN 'salida_sucursal'
                      ELSE 'salida_ruta' END AS tipo,
                 btrim(h.sucursal) AS plaza,
                 h.c9::date AS fecha, CASE WHEN h.c4::integer = 41 THEN btrim(h.c6) END AS folio,
                 ${UNIDAD} AS unidad, ${FACTOR} AS factor, ${CANTIDAD} AS cantidad, ${IMPORTE} AS importe,
                 CASE WHEN h.c4::integer <> 41 THEN ${NETO_VENTA} ELSE ${IMPORTE} END AS importe_neto,
                 CASE WHEN h.c4::integer <> 41 THEN ${COSTO_VENTA} END AS costo,
                 l.c9::numeric AS cantidad_base, ${UNIDAD_BASE} AS unidad_base
            FROM kepler_ods.kdm1 h
            JOIN kepler_ods.kdm2 l
              ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
             AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
             AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
           WHERE l.c2 = 'U' AND l.c3 = 'D' AND btrim(l.c8) = ANY(p_skus)
             AND h.c2 = 'U' AND h.c3 = 'D' AND h.c4::integer IN (8, 10, 12, 41)
             AND (h.c4::integer <> 41 OR btrim(h.c10) ~ '^TI[0-9]+$' OR btrim(h.c10) ~* '^(RUTA|RD) ')
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
          UNION ALL
          -- [NP.16] TRASPASO RECIBIDO de otra sucursal (U-A-50), en el almacén principal.
          SELECT btrim(l.c8), 'traspaso'::text, btrim(h.sucursal), h.c9::date, btrim(h.c6),
                 ${UNIDAD}, ${FACTOR}, ${CANTIDAD}, ${IMPORTE},
                 ${IMPORTE}, NULL::numeric,
                 l.c9::numeric, ${UNIDAD_BASE}
            FROM kepler_ods.kdm1 h
            JOIN kepler_ods.kdm2 l
              ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
             AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
             AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
           WHERE l.c2 = 'U' AND l.c3 = 'A' AND l.c4::integer = 50 AND btrim(l.c8) = ANY(p_skus)
             AND h.c2 = 'U' AND h.c3 = 'A' AND h.c4::integer = 50
             AND h.c9::date BETWEEN p_desde AND least(p_hasta, ${HOY})
             AND btrim(h.c1) = btrim(h.sucursal)
             AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
             AND abs(coalesce(l.c9::numeric, 0)) > 0
             AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover c
                          WHERE c.tenant_id = p_tenant AND c.kepler_code = btrim(h.sucursal)
                            AND h.c9::date >= c.cutover_date)
        ) x
       GROUP BY x.sku, x.tipo, x.plaza, x.fecha, x.folio, x.unidad, x.factor, x.unidad_base;
END
$np16$`);
  await knex.raw(`GRANT EXECUTE ON FUNCTION ${FIRMA} TO app_runtime`);
  await knex.raw(`
    COMMENT ON FUNCTION ${FIRMA} IS
      '[NP.16] Venta en tienda (reglas de mv_kepler_sales_daily + corte de v_branch_erp_cutover), '
      'entradas XA2001, traspasos recibidos (U-A-50) y salidas a sucursal o ruta (U-D-41 a TI/RUTA/RD) '
      'de una lista de SKUs, con la UNIDAD del renglon, el peldano vendido (factor), la venta neta de '
      'IVA/IEPS, el costo del renglon (c62 x c56) y la cantidad en unidad base. La usan mv_new_products '
      '(historia) y el servidor (lo de hoy). plpgsql + force_custom_plan [NP.14].'`);

  // ── 2. La matvista: la de [NP.15] más llegada, unidades por corte y reparto ──────────────────────────
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
       -- [NP.16] La funcion tambien trae traspasos y salidas: un lanzamiento es venta o compra.
       WHERE m.tipo IN ('venta', 'entrada')
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
    ), kardex AS (
      -- [NP.16] El BARRIDO del kardex (kdij): toda la historia de inventario de cada producto en el
      -- almacen principal de cada sucursal (c1 = sucursal, c2 = 1, c3 = SKU), entradas (c30 = 'E')
      -- y salidas. La compra fisica es la orden de entrada X-A-40: ahi entra el inventario, dias
      -- antes de que se aplique la compra (X-A-20, la que lee primera_recepcion). c11/c12 = cantidad
      -- y rotulo QUE ESCRIBIO EL RENGLON: si la ficha cambia de unidad base, los renglones viejos
      -- siguen en el rotulo viejo y Kepler los suma sin convertir (medido 2026-10-09).
      SELECT u.tenant_id, u.sku, j.sucursal::text AS plaza, j.c10::date AS fecha,
             (j.c30 = 'E') AS es_entrada,
             (j.c4 = 'X' AND j.c5 = 'A' AND j.c6 = 40) AS es_compra,
             -- Ajuste de inventario (N-A-30 / N-D-30): un conteo fisico que fija la existencia.
             (j.c4 = 'N' AND j.c6 = 30) AS es_ajuste,
             j.c4 || '-' || j.c5 || '-' || j.c6::text AS doc,
             nullif(btrim(j.c12), '') AS unidad,
             CASE WHEN j.c30 = 'E' THEN j.c11 ELSE -j.c11 END::numeric AS q
        FROM universo u
        JOIN kepler_ods.kdij j ON j.c3 = u.sku
       WHERE j.c1 = j.sucursal AND j.c2 = 1 AND j.c10 IS NOT NULL
    ), llegada AS (
      -- Una sola pasada: la primera compra, la primera entrada de cualquier tipo (y su documento,
      -- prefiriendo la compra si caen el mismo dia), y las compras con su sucursal para saber donde
      -- entro el primer dia. Sin subconsultas correlacionadas contra el CTE.
      SELECT k.tenant_id, k.sku,
             min(k.fecha) FILTER (WHERE k.es_compra) AS compra,
             min(k.fecha) AS entrada,
             (array_agg(k.doc ORDER BY k.fecha, k.es_compra DESC, k.doc))[1] AS entrada_doc,
             array_agg(k.fecha::text || '|' || k.plaza ORDER BY k.fecha, k.plaza)
               FILTER (WHERE k.es_compra) AS compras
        FROM kardex k
       WHERE k.es_entrada
       GROUP BY 1, 2
    ), kdx_u AS (
      -- [NP.16] Por sucursal y ROTULO del renglon: el neto (entradas - salidas) y la ultima fecha.
      SELECT k.tenant_id, k.sku, k.plaza, coalesce(k.unidad, '\\?') AS unidad,
             sum(k.q) AS q, max(k.fecha) AS ult
        FROM kardex k
       GROUP BY 1, 2, 3, 4
    ), kdx_aj AS (
      SELECT k.tenant_id, k.sku, k.plaza, max(k.fecha) AS aj
        FROM kardex k WHERE k.es_ajuste
       GROUP BY 1, 2, 3
    ), kdil_plaza AS (
      -- La existencia de Kepler al momento del calculo, SIN el piso en cero de v_erp_stock_on_hand:
      -- se compara contra la suma cruda del kardex para saber si Kepler sumo rotulos distintos.
      SELECT u.tenant_id, u.sku, k.sucursal::text AS plaza, sum(k.c4 + k.c8 - k.c9)::numeric AS kdil
        FROM universo u
        JOIN kepler_ods.kdil k ON btrim(k.c3) = btrim(u.sku) AND k.sucursal = k.c1
       GROUP BY 1, 2, 3
    ), kardex_plaza AS (
      -- { plaza: { u: { rotulo: { q, ult } }, crudo, aj, kdil } }. La conversion de rotulos y el
      -- juicio de si la existencia esta en duda viven en TS (factorDeRotulo, una sola regla).
      SELECT x.tenant_id, x.sku, jsonb_object_agg(x.plaza, x.j) AS kardex_plaza
        FROM (SELECT a.tenant_id, a.sku, a.plaza,
                     jsonb_strip_nulls(jsonb_build_object(
                       'u', jsonb_object_agg(a.unidad, jsonb_build_object(
                              'q', round(a.q, 3), 'ult', to_char(a.ult, 'YYYY-MM-DD'))),
                       'crudo', round(sum(a.q), 3),
                       'aj', to_char(max(aj.aj), 'YYYY-MM-DD'),
                       'kdil', round(max(kl.kdil), 3))) AS j
                FROM kdx_u a
                LEFT JOIN kdx_aj aj
                  ON aj.tenant_id = a.tenant_id AND aj.sku = a.sku AND aj.plaza = a.plaza
                LEFT JOIN kdil_plaza kl
                  ON kl.tenant_id = a.tenant_id AND kl.sku = a.sku AND kl.plaza = a.plaza
               GROUP BY 1, 2, 3) x
       GROUP BY 1, 2
    ), escalera_plaza AS (
      -- [NP.16] La ficha de Kepler de cada sucursal (kdii): rotulos de sus tres peldanos, el factor
      -- de cada uno derivado del costo, y el factor de la caja. La escalera la arma TS
      -- (escaleraUnidades, la misma regla que /compras/pedido).
      SELECT u.tenant_id, u.sku,
             jsonb_object_agg(l.sucursal, jsonb_strip_nulls(jsonb_build_object(
               'u1', l.u1_label, 'u2', l.u2_label, 'u3', l.u3_label,
               'f2', l.f2_costo, 'f3', l.f3_costo, 'uxc', l.factor_caja))) AS escalera_plaza
        FROM universo u
        JOIN analytics.v_kepler_unit_ladder l ON l.sku = btrim(u.sku)
       GROUP BY 1, 2
    ), hito_u AS (
      -- [NP.16] Unidades vendidas en los primeros 30, 60 y 90 dias desde el lanzamiento, por rotulo.
      SELECT k.tenant_id, k.sku, h.n, coalesce(k.unidad, '\\?') AS unidad, sum(k.cantidad) AS q
        FROM kepler k
        JOIN universo u ON u.tenant_id = k.tenant_id AND u.sku = k.sku
        CROSS JOIN (VALUES (30), (60), (90)) h(n)
       WHERE k.tipo = 'venta' AND k.fecha < u.lanzamiento + h.n
       GROUP BY 1, 2, 3, 4
    ), venta_unidades_hito AS (
      SELECT x.tenant_id, x.sku, jsonb_object_agg(x.n::text, x.u) AS hitos
        FROM (SELECT tenant_id, sku, n, jsonb_object_agg(unidad, round(q, 3)) AS u
                FROM hito_u GROUP BY 1, 2, 3) x
       GROUP BY 1, 2
    ), reparto AS (
      -- [NP.16] Por sucursal: lo recibido de otra (traspaso), lo mandado a otras sucursales y a rutas,
      -- y 'desde' = el primer dia que le llego por traspaso (para contar sus dias en la sucursal).
      SELECT r.tenant_id, r.sku, jsonb_object_agg(r.plaza, r.mov) AS reparto
        FROM (SELECT b.tenant_id, b.sku, b.plaza,
                     jsonb_object_agg(b.tipo, b.u)
                       || jsonb_strip_nulls(jsonb_build_object('desde', to_char(min(b.desde), 'YYYY-MM-DD'))) AS mov
                FROM (SELECT a.tenant_id, a.sku, a.plaza, a.tipo,
                             jsonb_object_agg(coalesce(a.unidad, '\\?'), round(a.q, 3)) AS u,
                             min(a.desde) FILTER (WHERE a.tipo = 'traspaso') AS desde
                        FROM (SELECT tenant_id, sku, plaza, tipo, unidad, sum(cantidad) AS q, min(fecha) AS desde
                                FROM kepler
                               WHERE tipo IN ('traspaso', 'salida_sucursal', 'salida_ruta')
                               GROUP BY 1, 2, 3, 4, 5) a
                       GROUP BY 1, 2, 3, 4) b
               GROUP BY 1, 2, 3) r
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
      -- [NP.16] La llegada a la empresa, del barrido del kardex. {} = sin kardex en almacen principal.
      CASE WHEN ll.sku IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
        'compra', to_char(ll.compra, 'YYYY-MM-DD'),
        'compra_plazas', to_jsonb(ARRAY(
          SELECT DISTINCT split_part(c, '|', 2) FROM unnest(ll.compras) c
           WHERE split_part(c, '|', 1) = ll.compra::text ORDER BY 1)),
        'entrada', to_char(ll.entrada, 'YYYY-MM-DD'),
        'entrada_doc', ll.entrada_doc) END                                AS llegada,
      coalesce(vuh.hitos, '{}'::jsonb)                                    AS venta_unidades_hito,
      coalesce(rp.reparto, '{}'::jsonb)                                   AS reparto,
      coalesce(kp.kardex_plaza, '{}'::jsonb)                              AS kardex_plaza,
      coalesce(ep.escalera_plaza, '{}'::jsonb)                            AS escalera_plaza,
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
      LEFT JOIN llegada ll           ON ll.tenant_id = u.tenant_id AND ll.sku = u.sku
      LEFT JOIN venta_unidades_hito vuh ON vuh.tenant_id = u.tenant_id AND vuh.sku = u.sku
      LEFT JOIN reparto rp           ON rp.tenant_id = u.tenant_id AND rp.sku = u.sku
      LEFT JOIN kardex_plaza kp      ON kp.tenant_id = u.tenant_id AND kp.sku = u.sku
      LEFT JOIN escalera_plaza ep    ON ep.tenant_id = u.tenant_id AND ep.sku = u.sku
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
      '[NP.16] Productos nuevos, SOLO KEPLER: primera actividad (entrada XA2001 o venta en tienda) en los '
      'ultimos 180 dias, lanzamientos detectados en vivo desde el corte, o sin movimiento y vistos por la '
      'Suite en 90. Corte = lo que mv_kepler_sales_daily ya tiene cerrado. Historia por SUCURSAL segun '
      'v_branch_erp_cutover. Series, unidades y margenes de fn_new_products_movimientos. margen_plaza: por '
      'plaza, venta neta (n), la que trae costo (nc), su costo (c), la que tiene meta (nm), los pesos de '
      'margen meta (m) y lo vendido por unidad base (b). compra_base: lo comprado por unidad base. llegada: '
      'barrido del kardex (primera compra X-A-40 y donde, primera entrada de cualquier tipo). '
      'venta_unidades_hito: unidades vendidas a 30/60/90 dias. reparto: traspaso recibido y salidas. '
      'kardex_plaza: neto del kardex por rotulo, ultimo ajuste y existencia de Kepler al calcular. '
      'escalera_plaza: la ficha de cada sucursal (rotulos, factores del costo y de la caja).'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: vuelve a la función y la matvista de `[NP.15]`.
 */
exports.down = async function down(knex) {
  await require('./20261008131320_np_margenes_por_sucursal.js').up(knex);
};
