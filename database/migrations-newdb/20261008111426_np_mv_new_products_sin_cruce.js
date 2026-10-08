'use strict';
/**
 * `[NP.14]` — **El primer cálculo de `analytics.mv_new_products` en producción no terminaba.**
 *
 * La matvista de `[NP.13]` (mig `20261008091317`) entró a prod a las 10:22 del 2026-10-08. El
 * ciclo de 15 min arrancó su primer poblado a las 11:00 y a las 11:09 seguía corriendo, con la
 * matvista tomada en exclusiva: la pantalla seguía en "se están calculando" y, como el ciclo no
 * arranca una pasada mientras la anterior sigue viva, las demás matvistas de 15 min también se
 * quedaron sin refrescar. En local el mismo cálculo tardaba 70 ms.
 *
 * ── Lo medido (prod, sólo `EXPLAIN`, sin ejecutar) ──────────────────────────────────────────
 *  · **La rejilla de la serie por sucursal se unía con un ciclo anidado.** La serie se armaba
 *    cruzando "un renglón por día × sucursal" contra "la venta por sucursal y día". Postgres
 *    estimaba **1 fila** de cada lado y eligió un Nested Loop con un recorrido completo del lado
 *    de adentro por cada renglón de afuera. En realidad son decenas de miles de cada lado:
 *    el costo crece con el producto de los dos, o sea horas.
 *  · Esa estimación de 1 fila venía de la función `fn_new_products_movimientos` integrada a la
 *    consulta. Al ser SQL, Postgres la mete dentro del plan y sus fechas y su lista de SKUs llegan
 *    como valores desconocidos (salen de otra parte de la misma consulta). Con fechas desconocidas
 *    estima 1 fila. Y con una lista no constante, `= ANY(p_skus)` se recorre **elemento por
 *    elemento en cada renglón**, en vez de buscarse por hash.
 *  · En local nada de esto se ve: con pocos datos cualquier plan tarda milisegundos.
 *
 * ── Lo que cambia ───────────────────────────────────────────────────────────────────────────
 *  1. **La serie se arma sin unir tablas.** La venta de cada producto (y de cada sucursal) se
 *     junta en un mapa `fecha → pesos`, y la serie se arma recorriendo los días del lanzamiento a
 *     la víspera del corte y buscando cada uno en el mapa. Cuesta lo mismo que los días a llenar,
 *     y ningún plan lo puede volver cuadrático. El resultado es el mismo, renglón por renglón.
 *  2. **La función se planea con sus valores reales.** Pasa a `plpgsql` con
 *     `plan_cache_mode = force_custom_plan`: cada llamada se planea con las fechas y la lista de
 *     SKUs ya puestas como constantes, así que la lista se busca por hash y el plan sale de
 *     estimaciones reales. Esto vale también para la pantalla. La consulta de adentro es **la
 *     misma**: se lee de la función instalada (`pg_proc.prosrc`) y se envuelve tal cual, sin
 *     volver a escribirla. La regla no puede cambiar en el camino.
 *     `ROWS 10000` le da a quien la llama una estimación con la que no elige ciclos anidados.
 *  3. Las unidades, las entradas y la serie se agrupan por SKU, y se unen al universo al final,
 *     con pocas filas de cada lado.
 *
 * ⚠️ Si la matvista está tomada (un REFRESH viejo corriendo), el `DROP` espera 5 s y la migración
 *    falla entera, también el cambio de la función. Hay que cancelar ese REFRESH antes.
 * ⚠️ Nace `WITH NO DATA`: el ciclo la puebla en el siguiente tick, sin `CONCURRENTLY` la primera vez.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_new_products';
const FN = 'analytics.fn_new_products_movimientos';
const FIRMA = `${FN}(uuid, text[], date, date)`;
const ENCABEZADO = `${FN}(p_tenant uuid, p_skus text[], p_desde date, p_hasta date)
    RETURNS TABLE (sku text, tipo text, plaza text, fecha date, folio text,
                   unidad text, cantidad numeric, importe numeric)`;
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";
/** Un día con al menos tantas altas en la Suite es una carga masiva, no un lote de altas. */
const ALTAS_POR_DIA_CARGA_MASIVA = 50;
/** Marcas que delimitan la consulta original dentro del cuerpo plpgsql (las usa el `down`). */
const INICIO = '-- [NP.14] consulta (la misma de la funcion SQL de 20261007360000)';
const FIN = '-- [NP.14] fin de la consulta';

async function funcionInstalada(knex) {
  const { rows } = await knex.raw(
    `SELECT l.lanname, p.prosrc
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.oid = to_regprocedure(?)`,
    [FIRMA],
  );
  if (!rows.length) throw new Error(`[NP.14] no existe ${FIRMA}: falta la mig 20261007360000`);
  return rows[0];
}

/** Una serie diaria densa del lanzamiento a la víspera del corte, buscando cada día en un mapa. */
const SERIE = (mapa) => `ARRAY(
               SELECT round(coalesce((${mapa} ->> d::date::text)::numeric, 0), 2)
                 FROM generate_series(u.lanzamiento, pa.corte - 1, interval '1 day') d
                ORDER BY d)`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // 1. La función: la MISMA consulta, planeada con sus valores reales.
  const { lanname, prosrc } = await funcionInstalada(knex);
  if (lanname === 'sql') {
    const consulta = prosrc.trim().replace(/;+\s*$/, '');
    if (consulta.includes('$np14$')) throw new Error('[NP.14] el cuerpo ya trae la marca $np14$');
    await knex.raw(`
    CREATE OR REPLACE FUNCTION ${ENCABEZADO}
    LANGUAGE plpgsql STABLE
    ROWS 10000
    SET plan_cache_mode = force_custom_plan
    AS $np14$
#variable_conflict use_column
BEGIN
  RETURN QUERY
${INICIO}
${consulta}
${FIN}
  ;
END
$np14$`);
  } else if (lanname !== 'plpgsql') {
    throw new Error(`[NP.14] ${FIRMA} está en ${lanname}: no sé convertirla`);
  }

  // 2. La matvista: la misma de [NP.13] salvo cómo arma las series (ver la cabecera).
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
      -- [NP.14] Por SKU, sin unirse al universo: se agrupa primero y se une al final.
      SELECT t.tenant_id, k.sku, k.tipo, k.plaza, k.fecha, k.folio, k.unidad, k.cantidad, k.importe
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
      -- [NP.14] La venta de cada dia como mapa fecha -> pesos. La serie se arma buscando cada dia
      -- en el mapa: no hay rejilla de dias unida contra la venta, y no hay plan que la vuelva cuadratica.
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
             jsonb_object_agg(mp.plaza, ${SERIE('mp.m')}) AS venta_por_plaza
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
                     jsonb_object_agg(coalesce(q.unidad, '?'), round(q.cantidad, 3)) AS u,
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
      -- Del lanzamiento a la vispera del corte, en ceros si no vendio; vacia si se estrena desde el corte.
      CASE WHEN u.lanzamiento < pa.corte THEN ${SERIE('md.m')}
           ELSE ARRAY[]::numeric[] END                                    AS venta_dia,
      coalesce(pp.venta_por_plaza, '{}'::jsonb)                           AS venta_por_plaza,
      coalesce(vu.venta_unidades, '{}'::jsonb)                            AS venta_unidades,
      coalesce(e.entradas, '[]'::jsonb)                                   AS entradas,
      now()                                                               AS calculado_at
      FROM universo u
      CROSS JOIN params pa
      LEFT JOIN catalog.brands b     ON b.id = u.brand_id
      LEFT JOIN catalog.suppliers sp ON sp.id = u.supplier_id AND sp.tenant_id = u.tenant_id
      LEFT JOIN mapa_dia md          ON md.tenant_id = u.tenant_id AND md.sku = u.sku
      LEFT JOIN por_plaza pp         ON pp.tenant_id = u.tenant_id AND pp.product_id = u.product_id
      LEFT JOIN venta_unidades vu    ON vu.tenant_id = u.tenant_id AND vu.sku = u.sku
      LEFT JOIN entradas e           ON e.tenant_id = u.tenant_id AND e.sku = u.sku
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
      '[NP.14] Productos nuevos, SOLO KEPLER: primera actividad (entrada XA2001 o venta en tienda) en los '
      'ultimos 180 dias, lanzamientos detectados en vivo desde el corte, o sin movimiento y vistos por la '
      'Suite en 90. Corte = lo que mv_kepler_sales_daily ya tiene cerrado. Historia por SUCURSAL segun '
      'v_branch_erp_cutover. Series y unidades de fn_new_products_movimientos (la misma que trae lo de hoy); '
      'las series se arman buscando cada dia en un mapa, sin unir tablas. Se refresca cada 30 min y de noche.'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: la matvista de `[NP.13]` y la función otra vez en SQL,
 * con la consulta que quedó entre las marcas.
 */
exports.down = async function down(knex) {
  await require('./20261008091317_np_mv_new_products_kepler_vivo.js').up(knex);
  const { lanname, prosrc } = await funcionInstalada(knex);
  if (lanname !== 'plpgsql') return;
  const a = prosrc.indexOf(INICIO);
  const b = prosrc.indexOf(FIN);
  if (a < 0 || b < a) throw new Error('[NP.14] no encuentro la consulta original en la funcion');
  const consulta = prosrc.slice(a + INICIO.length, b).trim();
  if (consulta.includes('$fn$')) throw new Error('[NP.14] la consulta trae la marca $fn$');
  // CREATE OR REPLACE sin ROWS ni SET los devuelve a su valor por omisión, como estaban.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${ENCABEZADO}
    LANGUAGE sql STABLE AS $fn$
${consulta}
$fn$`);
};
