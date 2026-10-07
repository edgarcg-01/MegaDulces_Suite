'use strict';
/**
 * `[NP.1]` **Productos nuevos** — la etiqueta "Nuevo" y su seguimiento a 30, 60 y 90 días.
 *
 * Compras pidió que cada código que se cataloga quede marcado como nuevo y se revise a los 30, 60
 * y 90 días: cuánto se invirtió, cuánto vendió y si se volvió a comprar. Esta matvista es la
 * etiqueta: no se captura, se DERIVA del ODS (regla principal, cero importers).
 *
 * ── Cuándo arranca el reloj ─────────────────────────────────────────────────────────────────
 * En la PRIMERA ACTIVIDAD del producto (su primera entrada o su primera venta, lo que pase
 * antes), NO en el alta. Un código que se da de alta y llega tres semanas después se vería como
 * fracaso a los 30 días sin haber estado nunca en el anaquel.
 *
 * ⛔ `catalog.products.created_at` NO sirve para decidir qué es nuevo. Es la fecha en que la Suite
 * lo vio, no la del alta en Kepler, y la carga inicial le puso la misma fecha a miles de
 * productos (medido en la base local: 7,963 "creados" en junio de 2026). Se publica como
 * `alta_suite`, rotulada, y sólo decide el caso sin ningún movimiento. La fecha de alta de Kepler
 * vive en alguna de las seis columnas de fecha de `kdii` (c50, c56, c60, c64, c65, c75), ninguna
 * decodificada todavía: es `[NP.0]` y se decide contra prod, no aquí.
 *
 * ── Qué cuenta como nuevo ───────────────────────────────────────────────────────────────────
 *   · su primera actividad cae en los últimos 180 días (90 de seguimiento + 90 más para poder
 *     comparar contra el siguiente mes), o
 *   · no tiene ningún movimiento, la Suite lo vio en los últimos 90 días, entró desde Kepler y
 *     NO en una carga masiva (dado de alta, sin recibir).
 * `no_medible`: la historia disponible no alcanza 90 días ANTES de su primera actividad, así que
 * no se puede afirmar que antes no se movía. Se declara, no se cuenta como nuevo.
 *
 * ⚠️ La historia se mide POR FUENTE (venta de tienda Kepler, ruta, Wincaja, entradas) y manda la
 * más corta de las fuentes donde el producto aparece. Las fuentes no arrancan juntas: en la base
 * local la venta de tienda empieza el 21-sep y la de ruta el 1-jul. Con un solo "desde" global
 * se afirmaría "antes no se vendía" en una fuente que no tiene historia para comprobarlo. Queda
 * un borde declarado: un producto que se movió SÓLO antes del inicio de una fuente y después
 * sólo en otra no se distingue.
 *
 * ⚠️ Las CARGAS MASIVAS no son altas. Medido en la base local: los días en que la Suite dio de
 * alta productos de a goteo tienen hasta 23; las cargas arrancan en 59 (7,524 el 30-jun, 996 el
 * 21-jul, 437 el 15-jul…). Sin este corte, 1,821 códigos muertos de esas cargas aparecían como
 * "dados de alta sin recibir" y tapaban a las altas de verdad. El umbral (50 por día) cae en el
 * hueco medido; en prod se vuelve a medir en `[NP.0]`.
 *
 * ── Las cifras ──────────────────────────────────────────────────────────────────────────────
 *   · Inversión = importe de los renglones de las entradas `XA2001`, vía
 *     `analytics.erp_goods_receipt_lines`. Sólo Kepler: el CEDIS operó en Wincaja hasta el
 *     30-sep, y las plazas 01, 02 y 06 antes de pasar a Kepler (1-jul-2026, 1-oct-2025 y
 *     15-ago-2026), así que lo que entró por ahí no está. Por eso es NULL (no medida), nunca 0.
 *   · Venta = `analytics.v_sellout_daily` (todas las plazas y canales). Esa vista ya toma cada
 *     plaza de Kepler o de Wincaja según su fecha de migración: no se repite esa regla aquí.
 *   · Se publican en PESOS, no en piezas: la entrada y la venta pueden venir en peldaños
 *     distintos (caja, paquete, pieza) y la cantidad no se compara sin resolver la unidad.
 *   · Sin margen: el costo del hecho de venta es álgebra sobre el markup (ADR-051), y publicarlo
 *     como retorno sería un número inventado.
 *   · Recompra = una entrada en una plaza que YA lo había recibido antes. La primera entrada en
 *     varias plazas es el surtido inicial, no una recompra.
 *   · Existencia = en cuántas plazas hay hoy. No se suman cantidades: cada ERP guarda en su
 *     unidad y el factor por defecto de `v_erp_stock_on_hand` es 1.
 *
 * ── Por qué MATERIALIZADA ───────────────────────────────────────────────────────────────────
 * La primera actividad exige recorrer TODA la historia de venta y de entradas por producto. Eso
 * no cabe en el gate de 1 s de la pantalla. Se materializa por COSTO y la refresca el lote
 * nocturno de `AnalyticsRefreshService` (06:20 MX), con latido y umbral en `CRON_JOBS`.
 * Nace `WITH NO DATA` a propósito: el primer poblado recorre la historia completa y va de noche,
 * no en horario hábil al desplegar. Mientras no se pueble, la pantalla lo declara.
 *
 * La clasificación de Compras (recodificación, promoción, no mercancía) NO vive aquí: es dato
 * propio en `catalog.new_product_reviews` y se une al consultar, para que se vea al momento.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_new_products';
const HOY = "(now() AT TIME ZONE 'America/Mexico_City')::date";
/** Un día con al menos tantas altas en la Suite es una carga masiva, no un lote de altas. */
const ALTAS_POR_DIA_CARGA_MASIVA = 50;

exports.up = async function up(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);

  await knex.raw(`
    CREATE MATERIALIZED VIEW ${MV} AS
    WITH venta AS (
      -- Sell-out canonico por producto, dia, plaza y FUENTE: todas las piernas. La ruta va como
      -- fuente propia porque su historia arranca en otra fecha que la venta de tienda.
      SELECT s.tenant_id, s.product_id, s.business_date AS fecha, s.warehouse_code,
             CASE WHEN s.channel = 'ruta' THEN 'ruta' ELSE s.source END AS fuente,
             sum(s.monto) AS monto
        FROM analytics.v_sellout_daily s
       WHERE s.product_id IS NOT NULL
       GROUP BY 1, 2, 3, 4, 5
    ), cab AS (
      -- La fecha de cada entrada XA2001. El renglon no la trae; se toma del encabezado con el
      -- mismo filtro anti-replica de la vista de renglones (c1 = sucursal). DISTINCT ON porque
      -- el folio puede repetirse con otra serie y una fecha por (plaza, folio) basta.
      SELECT DISTINCT ON (h.sucursal, btrim(h.c6::text))
             h.sucursal::text AS sucursal, btrim(h.c6::text) AS folio, h.c9::date AS fecha
        FROM kepler_ods.kdm1 h
       WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20'
         AND btrim(h.c1::text) = h.sucursal::text
         AND btrim(coalesce(h.c43::text, '')) <> 'C'
       ORDER BY h.sucursal, btrim(h.c6::text), h.c9
    ), rec AS (
      SELECT l.tenant_id, p.id AS product_id, l.sucursal, l.folio, c.fecha,
             sum(l.importe) AS importe
        FROM analytics.erp_goods_receipt_lines l
        JOIN cab c ON c.sucursal = l.sucursal AND c.folio = l.folio
        JOIN catalog.products p
          ON p.tenant_id = l.tenant_id AND btrim(p.sku) = l.sku AND p.deleted_at IS NULL
       GROUP BY 1, 2, 3, 4, 5
    ), actividad AS (
      -- Primera fecha de cada producto en cada fuente.
      SELECT tenant_id, product_id, fuente, min(fecha) AS primera
        FROM (SELECT tenant_id, product_id, fuente, fecha FROM venta
              UNION ALL
              SELECT tenant_id, product_id, 'entradas' AS fuente, fecha FROM rec) x
       GROUP BY 1, 2, 3
    ), historia AS (
      -- Desde cuando hay historia en CADA fuente.
      SELECT tenant_id, fuente, min(primera) AS desde
        FROM actividad
       GROUP BY 1, 2
    ), primera AS (
      SELECT a.tenant_id, a.product_id,
             min(a.primera) FILTER (WHERE a.fuente = 'entradas')  AS primera_recepcion,
             min(a.primera) FILTER (WHERE a.fuente <> 'entradas') AS primera_venta,
             -- Manda la fuente con la historia MAS CORTA de las que lo vieron: sin 90 dias de
             -- historia antes de su primera actividad en todas, no se puede afirmar que es nuevo.
             max(h.desde)                                          AS historia_desde,
             array_agg(DISTINCT a.fuente ORDER BY a.fuente)        AS fuentes
        FROM actividad a
        JOIN historia h ON h.tenant_id = a.tenant_id AND h.fuente = a.fuente
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
             pr.primera_recepcion, pr.primera_venta,
             -- LEAST ignora los NULL: un producto sin entradas arranca en su primera venta.
             least(pr.primera_recepcion, pr.primera_venta) AS lanzamiento,
             pr.historia_desde, pr.fuentes
        FROM catalog.products p
        LEFT JOIN primera pr ON pr.tenant_id = p.tenant_id AND pr.product_id = p.id
        LEFT JOIN lotes lo ON lo.tenant_id = p.tenant_id AND lo.dia = p.created_at::date
       WHERE p.deleted_at IS NULL
         AND (least(pr.primera_recepcion, pr.primera_venta) >= ${HOY} - 180
              OR (pr.product_id IS NULL
                  AND p.created_at::date >= ${HOY} - 90
                  AND p.source = 'kepler'
                  AND lo.dia IS NULL))
    ), codigos AS (
      -- Para la senal de recodificacion: el alta mas vieja de cada codigo de barras. Va como
      -- agregado y no como EXISTS por renglon: en la lista de salida el EXISTS no se puede
      -- convertir en semi-join y recorria el catalogo una vez por producto (8.9 s en local).
      SELECT tenant_id, btrim(barcode) AS barcode, min(created_at::date) AS primera_alta
        FROM catalog.products
       WHERE deleted_at IS NULL AND length(btrim(coalesce(barcode, ''))) >= 8
       GROUP BY 1, 2
    ), venta_u AS (
      SELECT u.tenant_id, u.product_id,
             sum(v.monto) FILTER (WHERE v.fecha < u.lanzamiento + 30) AS venta_30,
             sum(v.monto) FILTER (WHERE v.fecha < u.lanzamiento + 60) AS venta_60,
             sum(v.monto) FILTER (WHERE v.fecha < u.lanzamiento + 90) AS venta_90,
             sum(v.monto) AS venta_total,
             -- Dias distintos con venta en su primer mes: una venta sostenida, no un pico.
             count(DISTINCT v.fecha) FILTER (WHERE v.fecha < u.lanzamiento + 30) AS dias_con_venta_30,
             count(DISTINCT v.warehouse_code) AS plazas_venta,
             max(v.fecha) AS ultima_venta
        FROM universo u
        JOIN venta v ON v.tenant_id = u.tenant_id AND v.product_id = u.product_id
       GROUP BY 1, 2
    ), rec_u AS (
      SELECT u.tenant_id, u.product_id,
             sum(r.importe) FILTER (WHERE r.fecha < u.lanzamiento + 30) AS inversion_30,
             sum(r.importe) FILTER (WHERE r.fecha < u.lanzamiento + 60) AS inversion_60,
             sum(r.importe) FILTER (WHERE r.fecha < u.lanzamiento + 90) AS inversion_90,
             sum(r.importe) AS inversion_total,
             count(DISTINCT r.sucursal || '|' || r.folio) AS entradas,
             count(DISTINCT r.sucursal) AS plazas_recibido
        FROM universo u
        JOIN rec r ON r.tenant_id = u.tenant_id AND r.product_id = u.product_id
       GROUP BY 1, 2
    ), rec_plaza AS (
      -- Recompra = segunda fecha de entrada en una plaza que YA lo habia recibido.
      SELECT r.tenant_id, r.product_id, r.fecha,
             dense_rank() OVER (PARTITION BY r.tenant_id, r.product_id, r.sucursal ORDER BY r.fecha) AS n
        FROM rec r
        JOIN universo u ON u.tenant_id = r.tenant_id AND u.product_id = r.product_id
    ), recompra AS (
      SELECT tenant_id, product_id, min(fecha) AS primera_recompra
        FROM rec_plaza WHERE n = 2
       GROUP BY 1, 2
    ), stock_u AS (
      SELECT s.tenant_id, s.product_id,
             count(DISTINCT s.warehouse_id) FILTER (WHERE s.qty_stock_units > 0) AS plazas_con_existencia
        FROM analytics.v_erp_stock_on_hand s
        JOIN universo u ON u.tenant_id = s.tenant_id AND u.product_id = s.product_id
       GROUP BY 1, 2
    )
    SELECT
      u.tenant_id, u.product_id, u.sku, u.nombre, u.brand_id, b.nombre AS marca,
      u.supplier_id, sp.name AS proveedor,
      u.alta_suite, u.alta_en_lote, u.primera_recepcion, u.primera_venta, u.lanzamiento,
      u.historia_desde, coalesce(u.fuentes, ARRAY[]::text[])            AS fuentes,
      (u.lanzamiento IS NULL) AS sin_movimiento,
      (u.lanzamiento IS NOT NULL AND (u.historia_desde IS NULL OR u.historia_desde > u.lanzamiento - 90))
                                                                          AS no_medible,
      -- Lo que no es un lanzamiento de mercancia. El patron de DESC es el que CV.12 ya probo
      -- contra la base real (sin falsos positivos con nombres como SEMIDESCREMADA).
      CASE
        WHEN u.is_promo                                  THEN 'promocion'
        WHEN btrim(u.nombre) ~* '^\\*{0,3}\\s*DESC'      THEN 'descuento'
        WHEN u.nombre ILIKE '%DESCONTINUADO%'            THEN 'descontinuado'
      END                                                                 AS exclusion_auto,
      -- Senal, no veredicto: otro producto dado de alta ANTES con el mismo codigo de barras.
      coalesce(cb.primera_alta < u.alta_suite, false)                     AS posible_recodificacion,
      r.inversion_30, r.inversion_60, r.inversion_90, r.inversion_total,
      coalesce(r.entradas, 0)::int                                        AS entradas,
      coalesce(r.plazas_recibido, 0)::int                                 AS plazas_recibido,
      rc.primera_recompra,
      v.venta_30, v.venta_60, v.venta_90, v.venta_total,
      coalesce(v.dias_con_venta_30, 0)::int                               AS dias_con_venta_30,
      coalesce(v.plazas_venta, 0)::int                                    AS plazas_venta,
      v.ultima_venta,
      coalesce(s.plazas_con_existencia, 0)::int                           AS plazas_con_existencia,
      now()                                                               AS calculado_at
      FROM universo u
      LEFT JOIN catalog.brands b     ON b.id = u.brand_id
      LEFT JOIN catalog.suppliers sp ON sp.id = u.supplier_id AND sp.tenant_id = u.tenant_id
      LEFT JOIN venta_u v  ON v.tenant_id = u.tenant_id AND v.product_id = u.product_id
      LEFT JOIN rec_u r    ON r.tenant_id = u.tenant_id AND r.product_id = u.product_id
      LEFT JOIN recompra rc ON rc.tenant_id = u.tenant_id AND rc.product_id = u.product_id
      LEFT JOIN stock_u s  ON s.tenant_id = u.tenant_id AND s.product_id = u.product_id
      LEFT JOIN codigos cb ON cb.tenant_id = u.tenant_id AND cb.barcode = btrim(u.barcode)
    WITH NO DATA
  `);

  // UNIQUE sin WHERE: lo exige REFRESH ... CONCURRENTLY, que es como la refresca el lote nocturno.
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_new_products ON ${MV} (tenant_id, product_id)`);
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
      '[NP.1] Productos nuevos: primera actividad (entrada XA2001 o venta) en los ultimos 180 dias, '
      'o sin movimiento y vistos por la Suite en 90. Inversion = importe de entradas Kepler (NULL si no '
      'hay: el CEDIS fue Wincaja hasta el 30-sep). Venta = v_sellout_daily. En pesos, sin margen '
      '(ADR-051). Materializada por COSTO; la refresca el lote nocturno de AnalyticsRefreshService.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
