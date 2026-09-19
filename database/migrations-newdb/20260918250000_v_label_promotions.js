/**
 * `[ETQ-PROMO.1]` El descuento por cantidad de Kepler, listo para la etiqueta de anaquel.
 *
 * Vista `derive-no-copy` sobre `kepler_ods.kdpv_descuxq` (pantalla `PV_descuxq.kpl`, "Descuento
 * por Volumen"). Sin importer y sin tabla: la frescura la da el carril del ODS.
 *
 * ── Decode, verificado contra la UI del ERP y contra ventas reales ──────────────────────────
 *   c1  = la TIENDA a la que aplica la promo        c2  = SKU
 *   c3  = la UNIDAD (PAQ/CJA/KG/PZA/BTO)            c4  = descripción
 *   c5  = "Cant a Partir"                           c6  = "% Descuento"
 *   c7 / c8 = vigencia                              c9 / c10 = "Cant Max en Suc" / "Saldo x Vender"
 *
 * ⭐ `c6` es un PORCENTAJE, no un precio. La doc del repo lo llamaba `precio_promo` y quedaba
 * como pregunta abierta en FASE_MR_DICCIONARIO_MARGEN. Medido contra lo que el mostrador cobró:
 * 113 de 296 SKUs casan con `c90 * (1 - c6/100)` y sólo 2 casarían si fuera un precio. La
 * pantalla de Kepler rotula esa columna, literal, "% Descuento".
 *
 * ⚠️ `sucursal` NO es la tienda: es de qué base se replicó la fila. Cada DB de sucursal guarda
 * copias de las promos de otras, así que la misma promo aparece hasta 9 veces. La tienda es
 * `c1`. Por eso se deduplica por (c1, sku, unidad) prefiriendo la fila de su propia base.
 * (`analytics.erp_promotions` confunde las dos: filtra `sucursal='03'` y publica `c1` como
 * warehouse_code — medido, hoy devuelve CERO filas.)
 *
 * ⛔ `aplica_a` se DECLARA, no se adivina. La promo apunta a UNA presentación y no siempre es la
 * base: medido sobre las 498 vigentes en prod, 285 (57%) apuntan a la base `c90`, 90 a `c91`,
 * 44 a `c92` y **79 (16%) a ninguna de las tres** (ej. BTO sobre un producto con base KG).
 * Aplicarle el porcentaje al precio grande sin mirar la unidad habría estado mal en el 43%.
 * Cuando no se puede ubicar, `aplica_a` viene NULL y la etiqueta NO imprime descuento.
 */
const VIEW = `
CREATE OR REPLACE VIEW analytics.v_label_promotions AS
WITH vig AS (
  SELECT DISTINCT ON (btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)))
         btrim(d.c1)                AS sucursal,
         btrim(d.c2)                AS sku,
         upper(btrim(d.c3))         AS unidad,
         d.c5::numeric              AS min_qty,
         d.c6::numeric              AS pct,
         d.c7::date                 AS valid_from,
         d.c8::date                 AS valid_to,
         d.c10::numeric             AS saldo
    FROM kepler_ods.kdpv_descuxq d
   WHERE d.c7 <= now() AND d.c8 >= now()
     AND d.c6::numeric > 0
     AND d.c10::numeric > 0
     AND btrim(coalesce(d.c1,'')) <> '' AND btrim(coalesce(d.c2,'')) <> ''
   ORDER BY btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)),
            (btrim(d.sucursal::text) = btrim(d.c1)) DESC, d.c8 DESC
)
SELECT v.sucursal, v.sku, v.unidad, v.min_qty, v.pct, v.valid_from, v.valid_to, v.saldo,
       CASE WHEN v.unidad = upper(btrim(coalesce(k.c11,''))) THEN 'base'
            WHEN v.unidad = upper(btrim(coalesce(k.c80,''))) THEN 'unidad2'
            WHEN v.unidad = upper(btrim(coalesce(k.c83,''))) THEN 'unidad3'
       END AS aplica_a
  FROM vig v
  LEFT JOIN kepler_ods.kdii k
         ON btrim(k.c1) = v.sku AND btrim(k.sucursal::text) = v.sucursal`;

exports.up = async function (knex) {
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_label_promotions TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_label_promotions IS
    'derive-no-copy sobre kepler_ods.kdpv_descuxq: descuento por cantidad VIGENTE y CON SALDO, por tienda (c1, no sucursal) y por presentacion. pct = % (verificado 113 vs 2 contra ventas). aplica_a NULL = la promo apunta a una unidad que el producto no tiene: no se imprime.'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_label_promotions');
};
