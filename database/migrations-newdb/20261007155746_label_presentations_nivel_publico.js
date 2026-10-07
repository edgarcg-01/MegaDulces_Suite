/**
 * `[ETQ.NIV.1]` **La etiqueta de anaquel publicaba el precio de un NIVEL DE CLIENTE.**
 *
 * Reporte: el SKU 83652 (PANDITAS BOO 330 g) imprimia "MAYOREO 3+ PAQUETES $58.26" y
 * "MAYOREO 3+ CAJAS $649.97" -- una escalera invertida en el mismo papel ($649.97/10 = $64.99
 * por paquete, mas caro por unidad que comprar 3 paquetes sueltos).
 *
 * ── La causa, medida contra prod (solo lectura) ───────────────────────────────────────────────
 * `kepler_ods.kdpv_prod_util` tiene DOS ejes y la vista solo leia uno: `c2` es la presentacion
 * y **`c3` es el nivel de precio del cliente** (0 = mostrador, 1-3 = niveles negociados). El CTE
 * `esc` agrupaba por (sucursal, sku, unidad) **sin `c3`**, aplastando los cuatro niveles, y el
 * desempate `ORDER BY c4, c7` se quedaba con el mas barato de todos a igualdad de umbral.
 *
 * Para el 83652 el ERP declara, en todas las plazas:
 *   nivel 0  PAQ 3+ $71.15   CJA 3+ $705.06      <- mostrador
 *   nivel 1  PAQ 3+ $58.26   CJA 3+ $649.97      <- lo que se imprimia
 *   nivel 2  PAQ 6+ $56.58   nivel 3  PAQ 10+ $54.66
 *
 * ⭐ **Control dentro de la misma vista:** la sucursal 08 solo tiene filas de nivel 0, y es la
 * unica que imprimia $71.15 / $705.06, correcto. Mismo codigo, mismo papel: donde el nivel
 * profundo no existe el numero sale bien. Eso aisla la causa al aplastamiento, no al render.
 *
 * ⭐ **El arbitro es el dinero (ADR-059):** en `analytics.erp_sales_invoice_lines`, al 83652se le
 * cobro **$77.25 con menos de 3** (= `c90`) y **$71.15 con 3 o mas** (= nivel 0) en las plazas
 * 01, 06 y 08. **A nadie se le cobro nunca $58.26.** Ni un renglon.
 *
 * ── Que cambia ───────────────────────────────────────────────────────────────────────────────
 * 1. El peldano se elige DENTRO de un nivel (`esc_niv`, GROUP BY ... , c3) y el nivel que gana
 *    es el **mas superficial** que tenga peldano (`esc`, DISTINCT ON ... ORDER BY nivel).
 * 2. `piso_publico`: el precio de nivel 0 **sin exigirle umbral**, como piso. Cierra los 133
 *    grupos / 80 SKUs cuyo nivel 0 solo existe con umbral <= 1 (la sucursal 07 del 83652 es uno).
 *    Lo que cae por debajo del piso **no se publica**: veredicto `bajo_nivel_publico`.
 * 3. Columna nueva `mayoreo_nivel`: DECLARA de que nivel salio el numero (ADR-056).
 *
 * ⛔ **Lo que NO se hizo, y por que.** El arreglo obvio -- filtrar `c3 = 0`, que es lo que hizo
 * `[PV.1]` en `analytics.product_volume_tiers` -- **esta mal para este consumidor**: el nivel 0 es
 * el ESCASO (4,903 SKUs contra ~6,700 de cada otro nivel) y borraria el mayoreo de **5,641 SKUs**
 * que no tienen nivel 0 con umbral. Medido ademas que en esos SKUs lo cobrado queda **por debajo**
 * del nivel 1 (20105 cobra $123.56 contra nivel 1 $129.58; 88195 $150.96 contra $168.22), asi que
 * publicar el nivel 1 ahi no regala nada.
 *
 * ── Medido, grupo por grupo (169,852 en total) ────────────────────────────────────────────────
 *   igual ................................ 167,481  (98.6 %)
 *   SUBE, se regalaba .....................   2,344  / 323 SKUs  (+42.6 % promedio)
 *   baja (nivel 0 con umbral mas alto) ....      27  / 3 SKUs
 *   por debajo del nivel 0 ................   2,344 -> **0**
 *   frenados por el piso ..................      63  / 47 SKUs
 *
 * ⚠️ **Declarado, NO arreglado: 349 pares / 49 SKUs siguen con la escalera invertida entre
 * unidades** (el bulto sale mas caro por pieza que la presentacion chica). Antes eran 389 / 55,
 * o sea que el aplastamiento de niveles explicaba solo 40 de 389: **el resto es la escalera del
 * propio nivel 0 de Kepler**, y elegir cual de las dos lineas suprimir es decision de negocio,
 * no de esta migracion. El 83652 SI queda sano ($70.506/paq la caja contra $71.15 el paquete).
 *
 * ⚠️ El mismo numero lo lee `quote-pricing.service.ts` (cotizaciones), no solo la etiquetera.
 *
 * Idempotente: CREATE OR REPLACE VIEW. La columna nueva va AL FINAL (requisito de Postgres) y la
 * vista no tiene dependientes (verificado en prod via pg_depend). El GRANT se re-aplica.
 */

const VIEW = `
CREATE OR REPLACE VIEW analytics.v_label_presentations AS
WITH cat AS NOT MATERIALIZED (
  SELECT btrim(k.sucursal)                   AS sucursal,
         btrim(k.c1)                         AS sku,
         btrim(k.c2)                         AS name,
         nullif(upper(btrim(k.c11)), '')     AS unidad_base,
         k.c90::numeric                      AS precio_base,
         nullif(upper(btrim(k.c80)), '')     AS u1, floor(k.c81::numeric)::int AS f1, k.c91::numeric AS p1,
         nullif(upper(btrim(k.c83)), '')     AS u2, floor(k.c84::numeric)::int AS f2, k.c92::numeric AS p2
    FROM kepler_ods.kdii k
   WHERE btrim(coalesce(k.c1, '')) <> '' AND k.c90 > 0.05
), gramos_base AS NOT MATERIALIZED (
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
), pres AS NOT MATERIALIZED (
  SELECT sucursal, sku, unidad_base AS unidad, 1::numeric AS factor, 'base'::text AS origen,
         precio_base AS precio_lista, g_base
    FROM gramos_base WHERE unidad_base IS NOT NULL
  UNION ALL
  SELECT sucursal, sku, u1, f1::numeric, 'ranura', nullif(p1, 0), g_base
    FROM gramos_base WHERE u1 IS NOT NULL AND f1 > 1
  UNION ALL
  SELECT sucursal, sku, u2, f2::numeric, 'ranura', nullif(p2, 0), g_base
    FROM gramos_base WHERE u2 IS NOT NULL AND f2 > 1
), esc_niv AS NOT MATERIALIZED (
  -- Un peldano por NIVEL DE PRECIO. kdpv_prod_util tiene DOS ejes: c2 = presentacion y
  -- c3 = nivel de precio del cliente (0 = mostrador, 1-3 = niveles negociados). Agrupar sin c3
  -- aplastaba los cuatro niveles, y el desempate por c7 se quedaba con el mas barato de todos.
  SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
         u.c3::int                                                                            AS nivel,
         (array_agg(u.c7::numeric ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1]      AS precio,
         (array_agg(floor(u.c4::numeric)::int ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1] AS desde
    FROM kepler_ods.kdpv_prod_util u
   WHERE u.c7::numeric > 0 AND floor(u.c4::numeric)::int > 1
   GROUP BY 1, 2, 3, 4
), piso_publico AS NOT MATERIALIZED (
  -- El precio del nivel 0 SIN exigirle umbral. Medido: 133 grupos / 80 SKUs tienen nivel 0
  -- unicamente con umbral <= 1, y el filtro de arriba lo descartaba dejando pasar el nivel de
  -- cliente. Entra como PISO, nunca como peldano: no aporta el "desde".
  SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
         max(u.c7::numeric)                                                                   AS precio
    FROM kepler_ods.kdpv_prod_util u
   WHERE u.c7::numeric > 0 AND u.c3::int = 0
   GROUP BY 1, 2, 3
), esc AS NOT MATERIALIZED (
  -- El nivel MAS SUPERFICIAL que tenga peldano. Dentro de un grupo no se mezclan niveles.
  SELECT DISTINCT ON (sucursal, sku, unidad)
         sucursal, sku, unidad, nivel, precio, desde
    FROM esc_niv
   ORDER BY sucursal, sku, unidad, nivel
), uni AS NOT MATERIALIZED (
  -- Una fila por (plaza, sku, unidad). La base gana sobre la ranura si el ERP repite el rotulo.
  SELECT DISTINCT ON (sucursal, sku, unidad)
         sucursal, sku, unidad, factor, origen, precio_lista, g_base
    FROM pres
   ORDER BY sucursal, sku, unidad, (origen = 'base') DESC, factor
), todo AS NOT MATERIALIZED (
  SELECT u.sucursal, u.sku, u.unidad, u.factor, u.origen, u.precio_lista, u.g_base,
         e.precio AS mayoreo_precio, e.desde AS mayoreo_desde, e.nivel AS mayoreo_nivel,
         pp.precio AS piso_publico
    FROM uni u
    LEFT JOIN esc e ON e.sucursal = u.sucursal AND e.sku = u.sku AND e.unidad = u.unidad
    LEFT JOIN piso_publico pp ON pp.sucursal = u.sucursal AND pp.sku = u.sku AND pp.unidad = u.unidad
  UNION ALL
  -- Las que SOLO viven en la escalera: el ERP les pone mayoreo y no les publica precio de lista.
  SELECT e.sucursal, e.sku, e.unidad, NULL::numeric, 'escalera'::text, NULL::numeric, NULL::numeric,
         e.precio, e.desde, e.nivel, pp.precio
    FROM esc e
    LEFT JOIN piso_publico pp ON pp.sucursal = e.sucursal AND pp.sku = e.sku AND pp.unidad = e.unidad
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
       WHEN t.piso_publico IS NOT NULL AND t.mayoreo_precio < t.piso_publico - 0.0001
            THEN NULL
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0 THEN round(t.mayoreo_precio, 2)
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN 0.5 AND 1
            THEN round(t.mayoreo_precio, 2)
       ELSE NULL END                                     AS mayoreo_precio,
  CASE WHEN t.mayoreo_precio IS NULL THEN NULL
       WHEN t.piso_publico IS NOT NULL AND t.mayoreo_precio < t.piso_publico - 0.0001
            THEN NULL
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0 THEN t.mayoreo_desde
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN 0.5 AND 1
            THEN t.mayoreo_desde
       ELSE NULL END                                     AS mayoreo_desde,
  CASE WHEN t.mayoreo_precio IS NULL                          THEN 'sin_mayoreo'
       WHEN t.piso_publico IS NOT NULL AND t.mayoreo_precio < t.piso_publico - 0.0001
            THEN 'bajo_nivel_publico'
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0     THEN 'sin_arbitro'
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN 0.5 AND 1 THEN 'ok'
       ELSE 'incoherente' END                            AS mayoreo_veredicto,
  -- DECLARA de que nivel salio el numero. Con nivel <> 0 el ERP no publica precio de mostrador
  -- para ese grupo (95,013 de 169,852; medido: ahi lo cobrado queda por DEBAJO del nivel 1, asi
  -- que publicarlo no regala) -- pero quien lea la vista tiene que poder saberlo.
  t.mayoreo_nivel                                        AS mayoreo_nivel
FROM todo t
WHERE t.unidad IS NOT NULL`;

exports.up = async function up(knex) {
  // GOTCHAS 38: CREATE OR REPLACE VIEW toma ACCESS EXCLUSIVE sobre la vista, y esta la leen en
  // vivo la etiquetera y la vista previa de la cotizacion. El criterio es CALIENTE, no grande:
  // si el lock no esta libre, fallar rapido es barato; bloquear la pantalla no.
  await knex.raw("SET LOCAL lock_timeout = '3s'");
  await knex.raw(VIEW);
  await knex.raw("GRANT SELECT ON analytics.v_label_presentations TO app_runtime");
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '3s'");
  // Regresa a la definicion anterior (la que aplasta los niveles). Se conserva para poder
  // revertir, no porque sea defendible.
  await require("./20261002120000_v_label_presentations_not_materialized").up(knex);
};

exports.VIEW = VIEW;
