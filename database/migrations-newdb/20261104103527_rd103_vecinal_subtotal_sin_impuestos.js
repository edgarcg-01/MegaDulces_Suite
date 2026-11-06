'use strict';
/**
 * `[RD.103.0]` — `analytics.v_rd_route_daily`: el SUBTOTAL de las rutas VECINALES sale SIN
 * impuestos, como el de Ruta Directa. Hasta hoy era el importe de la línea de Kepler (`kdm2.c13`),
 * que trae IVA e IEPS.
 *
 * ── Por qué importa hoy ─────────────────────────────────────────────────────────────────────
 * Edgar (2026-11-04): las vecinales SÍ comisionan (`[RD.107]`), y por «la comisión sigue al
 * chofer» 2V001 va a darse de alta en «Quién cobra». El subtotal es la BASE de la comisión: con
 * la vista vieja el motor le pagaría sobre el monto con impuestos, ~9.5 % de más.
 *
 * ── Lo medido antes (sólo lectura, prod sid 7688376744939610156, 2026-11-04) ──────────────────
 * Árbitro independiente: el neto que el propio documento de Kepler declara
 * (`analytics.v_kepler_vecinal_sales_docs.neto`, `kdm1`). Q14–Q21 (2026-07-02 a 2026-10-21):
 *
 *     ruta     antes (vista viva)   después (esto)     vs neto de Kepler
 *     1V001    +9.36 %              −0.86 %  →  con la tasa de respaldo, ver abajo
 *     1V002   +11.00 %              −0.90 %
 *     1V003    +9.60 %              +0.03 %
 *     1V004   +11.14 %              −0.52 %
 *     2V001    +9.53 %              +0.17 %
 *     2V003   +10.45 %              +0.62 %   (el documento resta $4,890 de descuento; la línea no)
 *     2V005    +9.33 %              +0.54 %
 *     3V001   +12.65 %              −0.23 %
 *
 *  · La VENTA no cambia (con impuestos, igual que antes) en las 8 rutas.
 *  · Lo que queda abajo son líneas cuyo SKU no tiene tasa en `kdii`: 1V001 $13,713 de $1,494,419
 *    (0.92 %, justo su −0.86 %). De sus SKUs sólo `17178` existe en otra sucursal (`07`); los
 *    demás (17160, 17322, 96870, 65134, 17335) no están en el catálogo de ninguna. Por eso:
 *      - la tasa de la rama vecinal toma `00` y, si no está, la de otra sucursal (en todo `kdii`
 *        hay 1 SKU con tasas distintas entre sucursales);
 *      - un día con algún SKU sin tasa en ninguna sucursal sale
 *        `subtotal_origen = 'derivado_tasa_kepler_incompleto'`: declarado, no adivinado.
 *  · El COSTO vecinal no está en esta fuente (`v_route_sales_lines` lo trae NULL): su
 *    `costo_status` dejaba de decir `erp_reexpresado_cada_corrida` (falso) y dice
 *    `sin_dato_en_la_fuente`.
 *
 * ⛔ El push y Wincaja quedan EXACTAMENTE iguales: el respaldo de tasa es sólo de la rama vecinal.
 *    Deuda anotada aparte: 59 líneas del push ($8,744 en 200 días) tampoco tienen tasa en `00`.
 * ⚠️ Mismas columnas, mismo orden y mismos tipos: `CREATE OR REPLACE` no toca a los que dependen
 *    de esta vista (`mv_rd_route_daily_200d`, `v_rd_route_daily_rapido`, `v_rd_commission_sales`,
 *    `v_rd_commission_universe`, `v_rd_period_summary`, `v_caja_ingreso_ruta_candidatos`). La
 *    matview toma el cambio en su refresco de 30 min (`analytics-refresh.service`).
 * ⚠️ Consumidores que leen `subtotal` de una vecinal y hoy reciben el monto con impuestos rotulado
 *    como neto: el padrón de comisiones (`subtotal_30d`), `commercial-analytics` (`net_revenue`),
 *    el objetivo mensual (`volumen`) y el detalle de caja. Bajan ~9–13 % y quedan correctos.
 * ⚠️ Lo pagado NO se recalcula: ninguna vecinal tiene corrida pagada.
 *
 * Idempotente (CREATE OR REPLACE).
 *
 * @param { import("knex").Knex } knex
 */

const VISTA_VECINAL_NETO = `
CREATE OR REPLACE VIEW analytics.v_rd_route_daily AS
 WITH tasa AS (
         SELECT btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          WHERE k.sucursal = '00'
        ), tasa_cualquiera AS (
         SELECT DISTINCT ON (btrim(k.c1)) btrim(k.c1) AS articulo,
            abs(COALESCE(k.c18, 0::numeric)) AS iva_pct,
            abs(COALESCE(k.c19, 0::numeric)) AS ieps_pct
           FROM kepler_ods.kdii k
          ORDER BY btrim(k.c1), (k.sucursal = '00') DESC, k.sucursal
        )
 SELECT sl.tenant_id,
    sl.source_branch AS route_code,
    sl.business_date,
    sl.source,
    round(sum(
        CASE
            WHEN sl.source = 'push'::text THEN sl.importe / ((1::numeric + t.ieps_pct / 100.0) * (1::numeric + t.iva_pct / 100.0))
            WHEN sl.source = 'kepler_vecinal'::text THEN sl.importe / ((1::numeric + tv.ieps_pct / 100.0) * (1::numeric + tv.iva_pct / 100.0))
            ELSE sl.importe
        END), 2) AS subtotal,
        CASE
            WHEN sl.source = 'push'::text THEN
              CASE WHEN bool_and(t.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            WHEN sl.source = 'kepler_vecinal'::text THEN
              CASE WHEN bool_and(tv.articulo IS NOT NULL) THEN 'derivado_tasa_kepler'::text
                   ELSE 'derivado_tasa_kepler_incompleto'::text END
            ELSE 'erp'::text
        END AS subtotal_origen,
    round(sum(
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN sl.importe
            ELSE sl.importe * (1::numeric + COALESCE(sl.iva, 0::numeric) / 100.0 + COALESCE(sl.ieps, 0::numeric) / 100.0)
        END), 2) AS venta,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN 'erp'::text
            ELSE 'derivado_tasa_linea'::text
        END AS venta_origen,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN NULL::numeric
            ELSE round(sum(sl.costo), 2)
        END AS costo,
        CASE
            WHEN sl.source = ANY (ARRAY['push'::text, 'kepler_vecinal'::text]) THEN 'sin_dato_en_la_fuente'::text
            ELSE 'erp_reexpresado_cada_corrida'::text
        END AS costo_status,
    count(*)::integer AS lineas,
    count(DISTINCT sl.consecutivo)::integer AS tickets
   FROM analytics.v_route_sales_lines sl
     LEFT JOIN tasa t ON t.articulo = btrim(sl.sku)
     LEFT JOIN tasa_cualquiera tv ON sl.source = 'kepler_vecinal'::text AND tv.articulo = btrim(sl.sku)
  GROUP BY sl.tenant_id, sl.source_branch, sl.business_date, sl.source`;

/** La definición viva en prod al 2026-11-04 (`[RD.95]`, `20261028170837`), tal cual: la restaura el down. */
const VISTA_RD95 = `
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

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VISTA_VECINAL_NETO);
  // `[RD.98]` Un CREATE OR REPLACE sin WITH reemplaza las opciones: sin esto pierde security_invoker.
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_route_daily IS
    'RD.2 / RD.95 / RD.103.0 - venta por ruta y dia. Push y vecinal (kepler_vecinal): subtotal derivado con la tasa de KEPLER (kdii.c18/c19; IEPS sobre la base, IVA sobre base+IEPS); la vecinal toma 00 y si falta, otra sucursal. Un dia con algun SKU sin tasa sale subtotal_origen = derivado_tasa_kepler_incompleto. Vecinal medido 2026-11-04 contra el neto del documento de Kepler, Q14-Q21: antes +9 a +13 %, despues dentro de +-0.9 %.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: vuelve la definición de `[RD.95]`. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(VISTA_RD95);
  await knex.raw(`ALTER VIEW analytics.v_rd_route_daily SET (security_invoker = true)`);
  await knex.raw(`COMMENT ON VIEW analytics.v_rd_route_daily IS
    'RD.2 / RD.95 - venta de Ruta Directa por ruta y dia. Push: subtotal derivado con la tasa de KEPLER (kdii.c18/c19 de 00; IEPS sobre la base, IVA sobre base+IEPS); un dia con algun SKU sin tasa sale subtotal_origen = derivado_tasa_kepler_incompleto. Medido 2026-10-28 contra el libro: Q21 102/121 dias al peso (antes, con tasa Wincaja, 53/121).'`);
};
