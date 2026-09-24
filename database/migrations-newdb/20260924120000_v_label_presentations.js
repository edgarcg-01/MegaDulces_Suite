/**
 * `[ETQ-PRES.1]` La etiqueta deja de tener tres cajones y pasa a leer una LISTA de presentaciones.
 *
 * Contrato y medición completa en `libs/contracts/src/http/price-presentation.contract.ts`.
 * Acá va sólo el SQL y las decisiones que son del SQL.
 *
 * ── Qué reemplaza ───────────────────────────────────────────────────────────────────────────
 * `analytics.v_label_prices` mapea el catálogo a `piece_*` / `pack_*` / `box_*` comparando el
 * nombre de la unidad contra los literales `'PAQ'` y `'CJA'`. Ese mapeo es la causa ÚNICA de los
 * cinco defectos medidos el 2026-09-24 (202 SKUs con unidades que desaparecen, 6,826 sin el
 * peldaño de caja, 61 con el mayoreo en otra escala, 111 con el contenido 50× equivocado).
 *
 * ⚠️ `v_label_prices` NO se toca: la leen también cotizaciones (`quote-pricing.service.ts`) y
 * faltantes (`floor-stockouts.service.ts`). Migrar esos dos consumidores es trabajo aparte y
 * queda DECLARADO, no arrastrado.
 *
 * ── La lista es una UNIÓN, y está medido por qué ─────────────────────────────────────────────
 * Rama 01, 2026-09-24: 17,102 presentaciones están en `kdii` y en la escalera · **1,493 sólo en
 * `kdii`** (precio de lista sin peldaño) · **1,662 sólo en la escalera** (peldaño sin precio de
 * lista). Ninguno de los dos lados es superset: quedarse con uno pierde datos en los dos sentidos,
 * que es exactamente lo que hace el modelo de tres cajones.
 *
 * ── El contenido se DERIVA del factor, nunca del nombre ──────────────────────────────────────
 * El defecto más caro era `content` sacado de un regex sobre `kdii.c2` — el nombre del producto,
 * que describe el BULTO ("CAJETA ENVINADA 25KGS") mientras el precio es de la unidad base (500 g).
 * Resultado: "25 kg · $57.88", 50× abajo, en 111 SKUs × 9 plazas.
 *
 * Acá el contenido de la base sale, por orden de autoridad:
 *   1. La unidad base NUMÉRICA = gramos. ⭐ Verificado contra un testigo independiente: de los 51
 *      SKUs con base numérica que además tienen ranura `KG`, en **51 de 51** se cumple
 *      `base × factor_KG = 1000`. Cero excepciones. No es una interpretación, es aritmética.
 *   2. Base `KG` = 1 kg.
 *   3. Si no, el peso del NOMBRE — pero asignado a la BASE, y las demás presentaciones se derivan
 *      multiplicando por su factor. Así `95717` ("PISTACHOS 1KG", base PAQ, caja ×10) publica
 *      base 1 kg y caja 10 kg, las dos correctas; y `18022` ignora el "25KGS" del nombre porque
 *      su base numérica ya dice 500 g — y entonces la cubeta (×50) publica 25 kg, que es de quien
 *      era ese peso desde el principio.
 *
 * ── El mayoreo se lee del peldaño de LA MISMA unidad ─────────────────────────────────────────
 * No hay bucket intermedio: el join es por `(sucursal, sku, unidad)`. Conmensurable por
 * construcción — la pregunta "¿estos dos números hablan de lo mismo?" deja de existir.
 *
 * El veredicto es TERNARIO y `sin_arbitro` no es `ok` (ADR-056): medido, **6,358 presentaciones
 * no tienen precio de lista de su propia unidad**, así que no hay contra qué comparar. Llamarlas
 * sanas sería el `cfg ? classify : 'ok'` que la Fase VP ya midió.
 */

const VIEW = `
CREATE OR REPLACE VIEW analytics.v_label_presentations AS
WITH cat AS (
  SELECT btrim(k.sucursal)                   AS sucursal,
         btrim(k.c1)                         AS sku,
         btrim(k.c2)                         AS name,
         nullif(upper(btrim(k.c11)), '')     AS unidad_base,
         k.c90::numeric                      AS precio_base,
         nullif(upper(btrim(k.c80)), '')     AS u1, floor(k.c81::numeric)::int AS f1, k.c91::numeric AS p1,
         nullif(upper(btrim(k.c83)), '')     AS u2, floor(k.c84::numeric)::int AS f2, k.c92::numeric AS p2
    FROM kepler_ods.kdii k
   WHERE btrim(coalesce(k.c1, '')) <> '' AND k.c90 > 0.05
), gramos_base AS (
  SELECT c.*,
         CASE
           -- 1) base numerica = GRAMOS. Verificado 51/51 contra el factor de la ranura KG.
           WHEN c.unidad_base ~ '^[0-9]+$' THEN c.unidad_base::numeric
           WHEN c.unidad_base = 'KG'       THEN 1000::numeric
           -- 3) ultimo recurso: el peso del NOMBRE, asignado a la BASE (no al bulto).
           ELSE (
             SELECT CASE
                      WHEN lower(m[3]) LIKE 'k%'  THEN replace(m[1], ',', '.')::numeric * 1000
                      WHEN lower(m[3]) LIKE 'g%'  THEN replace(m[1], ',', '.')::numeric
                    END
               FROM regexp_match(c.name,
                 '([0-9]+([.,][0-9]+){0,1})[[:space:]]*(kilogramos{0,1}|kgs{0,1}|kilos{0,1}|gramos{0,1}|grs{0,1}|kg|gr|k|g)([^a-z0-9]|$)',
                 'i') AS m
           )
         END AS g_base
    FROM cat c
), pres AS (
  SELECT sucursal, sku, unidad_base AS unidad, 1::numeric AS factor, 'base'::text AS origen,
         precio_base AS precio_lista, g_base
    FROM gramos_base WHERE unidad_base IS NOT NULL
  UNION ALL
  SELECT sucursal, sku, u1, f1::numeric, 'ranura', nullif(p1, 0), g_base
    FROM gramos_base WHERE u1 IS NOT NULL AND f1 > 1
  UNION ALL
  SELECT sucursal, sku, u2, f2::numeric, 'ranura', nullif(p2, 0), g_base
    FROM gramos_base WHERE u2 IS NOT NULL AND f2 > 1
), esc AS (
  -- El primer peldano alcanzable de cada presentacion (menor umbral, desempatado por menor precio).
  SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
         (array_agg(u.c7::numeric ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1]      AS precio,
         (array_agg(floor(u.c4::numeric)::int ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1] AS desde
    FROM kepler_ods.kdpv_prod_util u
   WHERE u.c7::numeric > 0 AND floor(u.c4::numeric)::int > 1
   GROUP BY 1, 2, 3
), uni AS (
  -- Una fila por (plaza, sku, unidad). La base gana sobre la ranura si el ERP repite el rotulo.
  SELECT DISTINCT ON (sucursal, sku, unidad)
         sucursal, sku, unidad, factor, origen, precio_lista, g_base
    FROM pres
   ORDER BY sucursal, sku, unidad, (origen = 'base') DESC, factor
), todo AS (
  SELECT u.sucursal, u.sku, u.unidad, u.factor, u.origen, u.precio_lista, u.g_base,
         e.precio AS mayoreo_precio, e.desde AS mayoreo_desde
    FROM uni u
    LEFT JOIN esc e ON e.sucursal = u.sucursal AND e.sku = u.sku AND e.unidad = u.unidad
  UNION ALL
  -- Las que SOLO viven en la escalera: el ERP les pone mayoreo y no les publica precio de lista.
  SELECT e.sucursal, e.sku, e.unidad, NULL::numeric, 'escalera'::text, NULL::numeric, NULL::numeric,
         e.precio, e.desde
    FROM esc e
   WHERE NOT EXISTS (SELECT 1 FROM uni u
                      WHERE u.sucursal = e.sucursal AND u.sku = e.sku AND u.unidad = e.unidad)
     AND EXISTS (SELECT 1 FROM uni u2 WHERE u2.sucursal = e.sucursal AND u2.sku = e.sku)
)
SELECT
  t.sucursal, t.sku, t.unidad, t.factor, t.origen,
  -- Contenido DERIVADO: gramos de la base x factor. Nunca el nombre del producto.
  CASE
    WHEN t.g_base IS NULL OR t.factor IS NULL THEN NULL
    -- rtrim del punto: 'FM…0.999' deja el separador colgando cuando no hay decimales ("1. kg").
    WHEN t.g_base * t.factor >= 1000
      THEN rtrim(trim(to_char(round(t.g_base * t.factor / 1000.0, 3), 'FM999999990.999')), '.') || ' kg'
    ELSE trim(to_char(round(t.g_base * t.factor, 0), 'FM999999990')) || ' g'
  END                                                    AS contenido,
  round(t.precio_lista, 2)                               AS precio_lista,
  -- El precio del mayoreo SOLO sale si su veredicto es 'ok'. Un numero incoherente no se publica;
  -- lo que se publica es el veredicto, para que la pantalla lo pueda DECIR.
  CASE WHEN t.mayoreo_precio IS NULL THEN NULL
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0 THEN round(t.mayoreo_precio, 2)
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN ${0.5} AND ${1.0}
            THEN round(t.mayoreo_precio, 2)
       ELSE NULL END                                     AS mayoreo_precio,
  CASE WHEN t.mayoreo_precio IS NULL THEN NULL
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0 THEN t.mayoreo_desde
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN ${0.5} AND ${1.0}
            THEN t.mayoreo_desde
       ELSE NULL END                                     AS mayoreo_desde,
  CASE WHEN t.mayoreo_precio IS NULL                          THEN 'sin_mayoreo'
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0     THEN 'sin_arbitro'
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN ${0.5} AND ${1.0} THEN 'ok'
       ELSE 'incoherente' END                            AS mayoreo_veredicto
FROM todo t
WHERE t.unidad IS NOT NULL`;

exports.up = async function up(knex) {
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_label_presentations TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_label_presentations IS
    'ETQ-PRES.1 — una fila por (plaza, sku, unidad) con su factor, contenido DERIVADO del factor, precio de lista y peldano de mayoreo de LA MISMA unidad. Reemplaza el mapeo a piece/pack/box de v_label_prices, que perdia 1,980 ranuras (unidades distintas de PAQ/CJA), ignoraba el mayoreo de caja en 6,826 SKUs y sacaba el contenido del NOMBRE del producto (111 SKUs con el contenido 50x equivocado). mayoreo_veredicto es TERNARIO: sin_arbitro NO es ok.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_label_presentations');
};
