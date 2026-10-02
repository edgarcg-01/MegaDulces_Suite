/**
 * `[COT.17]` La vista previa del precio de cotizaciones tardaba ~3 s por clic: la vista
 * `analytics.v_label_presentations` recalculaba TODO el ODS en cada consulta.
 *
 * ── Causa, medida contra prod (solo lectura, 2026-10-02) ──────────────────────────────────────
 * Los CTE `esc` y `uni` se referencian más de una vez dentro de la vista, y desde Postgres 12
 * un CTE con varias referencias se MATERIALIZA: el filtro `sucursal = … AND sku = …` de quien
 * consulta no entra, y cada lectura agrupa los 379k renglones de `kdpv_prod_util` y recorre los
 * 84k de `kdii` para devolver 1–3 filas.
 *
 * ── Qué cambia: SÓLO `NOT MATERIALIZED` en los 6 CTE ─────────────────────────────────────────
 * Ni una columna, ni un filtro, ni una regla de negocio. El cuerpo es el de
 * `20260924120000_v_label_presentations.js` byte por byte, con la palabra agregada; lo vigila
 * `v-label-presentations-not-materialized.spec.ts` (si alguien cambia una regla acá, se pone rojo).
 * Con eso el filtro baja a cada referencia y `kdii` entra por `ix_kdii_suc_sku`.
 *
 * Medido (48 SKUs × sucursales 01/03 = 96 lecturas, prod, solo lectura):
 *   antes   mediana 3,094 ms · p90 3,738 ms · máx 4,183 ms
 *   después mediana   144 ms · p90   179 ms · máx   203 ms
 *   resultados: 96 de 96 IDÉNTICOS (comparación fila por fila, todas las columnas).
 *
 * ⚠️ Lo que queda: `kdpv_prod_util` todavía va por seq scan paralelo (~30 ms), porque su índice
 * es sobre `c1` crudo y la vista filtra `btrim(c1)`. Un índice de expresión lo bajaría más; no
 * entra aquí: ya estamos bajo el gate de 1 s y crear índices sobre una tabla que escribe el CDC
 * se hace aparte.
 *
 * También acelera a los otros lectores de la vista (etiquetera, `/tienda/etiquetas`), que leen
 * por (sucursal, sku) igual.
 *
 * Idempotente: `CREATE OR REPLACE VIEW` con las mismas columnas en el mismo orden. El GRANT se
 * re-aplica (no se depende de que se herede). `down` regresa la definición anterior.
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
), esc AS NOT MATERIALIZED (
  -- El primer peldano alcanzable de cada presentacion (menor umbral, desempatado por menor precio).
  SELECT btrim(u.sucursal) AS sucursal, btrim(u.c1) AS sku, upper(btrim(u.c2::text)) AS unidad,
         (array_agg(u.c7::numeric ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1]      AS precio,
         (array_agg(floor(u.c4::numeric)::int ORDER BY floor(u.c4::numeric)::int, u.c7::numeric))[1] AS desde
    FROM kepler_ods.kdpv_prod_util u
   WHERE u.c7::numeric > 0 AND floor(u.c4::numeric)::int > 1
   GROUP BY 1, 2, 3
), uni AS NOT MATERIALIZED (
  -- Una fila por (plaza, sku, unidad). La base gana sobre la ranura si el ERP repite el rotulo.
  SELECT DISTINCT ON (sucursal, sku, unidad)
         sucursal, sku, unidad, factor, origen, precio_lista, g_base
    FROM pres
   ORDER BY sucursal, sku, unidad, (origen = 'base') DESC, factor
), todo AS NOT MATERIALIZED (
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
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN 0.5 AND 1
            THEN round(t.mayoreo_precio, 2)
       ELSE NULL END                                     AS mayoreo_precio,
  CASE WHEN t.mayoreo_precio IS NULL THEN NULL
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0 THEN t.mayoreo_desde
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN 0.5 AND 1
            THEN t.mayoreo_desde
       ELSE NULL END                                     AS mayoreo_desde,
  CASE WHEN t.mayoreo_precio IS NULL                          THEN 'sin_mayoreo'
       WHEN t.precio_lista IS NULL OR t.precio_lista <= 0     THEN 'sin_arbitro'
       WHEN t.mayoreo_precio / t.precio_lista BETWEEN 0.5 AND 1 THEN 'ok'
       ELSE 'incoherente' END                            AS mayoreo_veredicto
FROM todo t
WHERE t.unidad IS NOT NULL`;

exports.up = async function up(knex) {
  // GOTCHAS §38: CREATE OR REPLACE VIEW toma ACCESS EXCLUSIVE sobre la vista, y ésta la leen
  // en vivo la vista previa de la cotización y la etiquetera. El criterio es CALIENTE, no
  // grande: si el lock no está libre, fallar rápido es barato; bloquear la pantalla no.
  await knex.raw("SET LOCAL lock_timeout = '3s'");
  await knex.raw(VIEW);
  await knex.raw("GRANT SELECT ON analytics.v_label_presentations TO app_runtime");
};

exports.down = async function down(knex) {
  await knex.raw("SET LOCAL lock_timeout = '3s'");
  // La definición anterior es la de su migración original (sin NOT MATERIALIZED).
  await require("./20260924120000_v_label_presentations").up(knex);
};

exports.VIEW = VIEW;
