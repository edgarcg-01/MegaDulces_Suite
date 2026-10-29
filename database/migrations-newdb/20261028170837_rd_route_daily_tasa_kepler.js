'use strict';
/**
 * `[RD.95]` — `analytics.v_rd_route_daily`: el SUBTOTAL del push sale con la tasa de KEPLER, no
 * con la de Wincaja. El subtotal es la BASE de la comisión de Ruta Directa.
 *
 * ── Lo medido antes (sólo lectura, 2026-10-28) ──────────────────────────────────────────────
 * Testigo independiente: la hoja CONCENTRADO del libro de comisiones, que desde Q20 trae el
 * subtotal REAL de cada día (hasta Q19 lo prorrateaba: subtotal/venta idéntico todos los días
 * de la ruta — 0.9183 la 21, 0.9186 la 27, 0.9127 la 503 — así que antes de Q20 no arbitra).
 * Ruta × día con la venta idéntica al libro, subtotal dentro de ±$1, mismo instrumento:
 *
 *                      tasa Wincaja (antes)   tasa Kepler (esto)
 *     Q20 ................ 42 / 117 ............ 103 / 117
 *     Q21 ................ 53 / 121 ............ 102 / 121
 *     consulta, 1 quincena   ~700 ms ............... ~200 ms
 *
 * El cálculo nuevo se hizo DOS veces —en JS y con este mismo SQL— y dan lo mismo.
 * Efecto en Q21 sobre los 7 choferes que cobran: +$382.82 de comisión (subtotal × % aplicado,
 * con venta y escalón sin cambio). El motor les pagaba de menos.
 *
 * ── Los tres defectos de la versión anterior ────────────────────────────────────────────────
 *  1. La tasa salía de `wincaja.articulos`, pero la venta del push la factura KEPLER (la van).
 *  2. Un SKU sin ficha en Wincaja daba subtotal NULL y `sum()` lo IGNORABA: en Q21, 188 líneas
 *     de 11 SKUs, $14,683.90 de venta, fuera de la base de la comisión sin aviso.
 *  3. La fórmula era aditiva (1 + IVA + IEPS). Hoy no mueve nada —ningún SKU vendido lleva las
 *     dos— pero Kepler grava IEPS sobre la base e IVA sobre (base + IEPS) (ERP_KEPLER.md, `[E.25]`,
 *     79 de 79 al centavo). Se escribe como Kepler.
 *
 * ── La regla nueva ──────────────────────────────────────────────────────────────────────────
 *  · Tasa = `kepler_ods.kdii.c18` (IVA) / `c19` (IEPS), negativas = incluidas en el precio, de
 *    la sucursal `00`. Medido: para los 2,864 SKUs vendidos desde el 24-sep la tasa es IDÉNTICA
 *    en `00`, `01` y `06` (0 difieren), así que no hace falta mapear ruta → sucursal.
 *  · Un SKU sin tasa sigue sin subtotal, pero ya NO en silencio: el día sale
 *    `subtotal_origen = 'derivado_tasa_kepler_incompleto'` (0 casos en Q20 y Q21).
 *  · El tramo Wincaja (`source <> 'push'`) queda EXACTAMENTE igual.
 *
 * ⚠️ El COMMENT vivo antes de esto decía que RD.11 (2026-09-10) la había hecho leer «las dos
 *    fuentes DIRECTO en vez de v_route_sales_lines», con un candado
 *    `test-newdb-rd-route-daily-perf`. **Ninguna de las dos cosas existe**: la definición viva SÍ
 *    lee `v_route_sales_lines`, y ni ese test ni esa migración están en el repo ni en su historia
 *    (`git log -S`). Se reemplaza por uno que dice lo que la vista hace; el `down` lo restaura
 *    textual para que deshacer sea exacto.
 * ⚠️ Mismas columnas, mismo orden y mismos tipos: `CREATE OR REPLACE` no toca a los seis que
 *    dependen de esta vista (`mv_rd_route_daily_200d`, `v_rd_route_daily_rapido`,
 *    `v_rd_commission_sales`, `v_rd_commission_universe`, `v_rd_period_summary`,
 *    `v_caja_ingreso_ruta_candidatos`). La matview toma el cambio en su refresco de 30 min
 *    (`analytics-refresh.service`); no hace falta un REFRESH a mano.
 * ⚠️ Lo pagado NO se recalcula: las corridas `pagado` están congeladas. Cambia la vista previa,
 *    el contraste y lo que se calcule de aquí en adelante.
 *
 * Idempotente (CREATE OR REPLACE).
 *
 * @param { import("knex").Knex } knex
 */

const VISTA_KEPLER = `
CREATE OR REPLACE VIEW analytics.v_rd_route_daily AS
 WITH tasa AS (
         SELECT btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          WHERE k.sucursal = '00'
        )
 SELECT sl.tenant_id,
    sl.source_branch AS route_code,
    sl.business_date,
    sl.source,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe / ((1::numeric + t.ieps_pct / 100.0) * (1::numeric + t.iva_pct / 100.0))
            ELSE sl.importe
        END), 2) AS subtotal,
        CASE
            WHEN sl.source = 'push'::text THEN
              CASE WHEN bool_and(t.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            ELSE 'erp'::text
        END AS subtotal_origen,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe
            ELSE sl.importe * (1::numeric + COALESCE(sl.iva, 0::numeric) / 100.0 + COALESCE(sl.ieps, 0::numeric) / 100.0)
        END), 2) AS venta,
        CASE
            WHEN sl.source = 'push'::text THEN 'erp'::text
            ELSE 'derivado_tasa_linea'::text
        END AS venta_origen,
        CASE
            WHEN sl.source = 'push'::text THEN NULL::numeric
            ELSE round(sum(sl.costo), 2)
        END AS costo,
        CASE
            WHEN sl.source = 'push'::text THEN 'sin_dato_en_la_fuente'::text
            ELSE 'erp_reexpresado_cada_corrida'::text
        END AS costo_status,
    count(*)::integer AS lineas,
    count(DISTINCT sl.consecutivo)::integer AS tickets
   FROM analytics.v_route_sales_lines sl
     LEFT JOIN tasa t ON t.articulo = btrim(sl.sku)
  GROUP BY sl.tenant_id, sl.source_branch, sl.business_date, sl.source`;

/** La definición viva en prod al 2026-10-28 (`pg_get_viewdef`), tal cual: es lo que restaura el down. */
const VISTA_WINCAJA = `
CREATE OR REPLACE VIEW analytics.v_rd_route_daily AS
 WITH tasa AS (
         SELECT DISTINCT ON (a.tenant_id, a.articulo) a.tenant_id,
            a.articulo,
            COALESCE(a.iva_venta, 0::numeric) AS iva_pct,
            COALESCE(a.ieps_venta, 0::numeric) AS ieps_pct
           FROM wincaja.articulos a
          ORDER BY a.tenant_id, a.articulo, a.source_dataset DESC
        )
 SELECT sl.tenant_id,
    sl.source_branch AS route_code,
    sl.business_date,
    sl.source,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe / (1::numeric + t.iva_pct / 100.0 + t.ieps_pct / 100.0)
            ELSE sl.importe
        END), 2) AS subtotal,
        CASE
            WHEN sl.source = 'push'::text THEN 'derivado_tasa_wincaja'::text
            ELSE 'erp'::text
        END AS subtotal_origen,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe
            ELSE sl.importe * (1::numeric + COALESCE(sl.iva, 0::numeric) / 100.0 + COALESCE(sl.ieps, 0::numeric) / 100.0)
        END), 2) AS venta,
        CASE
            WHEN sl.source = 'push'::text THEN 'erp'::text
            ELSE 'derivado_tasa_linea'::text
        END AS venta_origen,
        CASE
            WHEN sl.source = 'push'::text THEN NULL::numeric
            ELSE round(sum(sl.costo), 2)
        END AS costo,
        CASE
            WHEN sl.source = 'push'::text THEN 'sin_dato_en_la_fuente'::text
            ELSE 'erp_reexpresado_cada_corrida'::text
        END AS costo_status,
    count(*)::integer AS lineas,
    count(DISTINCT sl.consecutivo)::integer AS tickets
   FROM analytics.v_route_sales_lines sl
     LEFT JOIN tasa t ON t.tenant_id = sl.tenant_id AND t.articulo = sl.sku
  GROUP BY sl.tenant_id, sl.source_branch, sl.business_date, sl.source`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VISTA_KEPLER);
  // ⚠️ `[RD.98]` Un CREATE OR REPLACE sin WITH reemplaza las opciones: sin esta línea la vista
  // pierde `security_invoker` (así quedó en prod el 2026-10-28 y lo devolvió `20261029121941`).
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_route_daily IS
    'RD.2 / RD.95 - venta de Ruta Directa por ruta y dia. Push: subtotal derivado con la tasa de KEPLER (kdii.c18/c19 de 00; IEPS sobre la base, IVA sobre base+IEPS); un dia con algun SKU sin tasa sale subtotal_origen = derivado_tasa_kepler_incompleto. Medido 2026-10-28 contra el libro: Q21 102/121 dias al peso (antes, con tasa Wincaja, 53/121).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve la definición de Wincaja tal como estaba. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VISTA_WINCAJA);
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_route_daily IS
    'RD.2 - venta por ruta x dia declarando su procedencia. RD.11 (2026-09-10): lee las dos fuentes DIRECTO en vez de v_route_sales_lines, que es la vista de drill-down por linea y hace dos LATERAL por fila (articulos + pagos_dia/formas_pago) cuyas columnas este GROUP BY descarta. Medido: 9,671 -> ~2,300 ms por quincena, con la aritmetica identica (candado test-newdb-rd-route-daily-perf compara fila por fila contra la definicion vieja).'`);
};
