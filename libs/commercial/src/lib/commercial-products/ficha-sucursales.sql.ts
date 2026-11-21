/**
 * `[CAT-PRECIO.1]` La ficha de venta de cada producto en cada sucursal, sólo para los productos
 * donde ALGÚN campo no coincide entre plazas. Quién se sale y cuál es la referencia lo decide
 * `compararFicha()` (`ficha-sucursales.ts`), que se prueba sin base; esto sólo junta las fichas.
 *
 * Fuente: `kepler_ods.kdii` (la ficha «Productos POS» de Kepler, una por sucursal) + sus catálogos
 * de línea (`kdig`), tipo (`kdie`) y grupo (`kdif`) + el precio por volumen nivel 0
 * (`kdpv_prod_util`). Derivado en la consulta, sin copiar nada (regla principal). Columnas
 * verificadas el 2026-10-16 contra la ficha 02073 en pantalla de Kepler:
 *   c2 descripción · c3 línea · c4 tipo · c5 grupo · c18 IVA · c19 IEPS (negativo = incluido)
 *   c11/c80/c83 unidades · c81/c84 factor de la unidad 2 y 3 · c90/c91/c92 precio de cada unidad
 *   códigos: unidad 1 c7/c93/c102 · unidad 2 c82/c95/c96 · unidad 3 c85/c97/c98
 *
 * ⚠️ Sólo plazas que venden al público (`sells_to_public`): el CEDIS 00 no pone precio a nadie.
 * ⚠️ El filtro de `diferentes` usa `count(DISTINCT ...)` sobre las MISMAS claves que compara la
 *    regla, así un producto que aquí pasa siempre tiene al menos un campo distinto allá.
 *
 * (Sin acentos graves aquí adentro: cierran el template literal.)
 */
export const FICHA_SUCURSALES_SQL = `
WITH plazas AS (
  -- DISTINCT: dos almacenes con el mismo código (p. ej. uno retirado y su reemplazo) duplicarían
  -- cada ficha y fabricarían una «mayoría» que no existe.
  SELECT DISTINCT w.kepler_code AS suc
    FROM commercial.warehouses w
   WHERE w.deleted_at IS NULL AND w.sells_to_public IS TRUE AND w.kepler_code IS NOT NULL
), volumen AS (
  -- trim_scale: Kepler guarda el mismo «desde» como 3 en unas plazas y 3.00 en otras; sin él, la
  -- cadena difiere y el filtro de abajo cuenta como distinto lo que es igual (46 productos, 2026-11-18).
  SELECT p.sucursal AS suc, btrim(p.c1) AS sku,
         string_agg(upper(btrim(p.c2)) || ':' || trim_scale(p.c4::numeric)::text || ':' || round(p.c7::numeric, 2)::text,
                    ';' ORDER BY upper(btrim(p.c2)), p.c4::numeric) AS mayoreo
    FROM kepler_ods.kdpv_prod_util p
    JOIN plazas ON plazas.suc = p.sucursal
   WHERE p.c3 = 0
   GROUP BY 1, 2
), f AS (
  SELECT i.sucursal AS suc, btrim(i.c1) AS sku,
         btrim(i.c2) AS descripcion,
         btrim(i.c3) AS linea, btrim(i.c4) AS tipo, btrim(i.c5) AS grupo,
         btrim(lg.c2) AS linea_nombre, btrim(te.c2) AS tipo_nombre, btrim(gf.c2) AS grupo_nombre,
         i.c18::numeric AS iva, i.c19::numeric AS ieps,
         upper(btrim(i.c11)) AS u1, upper(btrim(i.c80)) AS u2, upper(btrim(i.c83)) AS u3,
         i.c81::numeric AS f2, i.c84::numeric AS f3,
         round(i.c90::numeric, 2) AS pv1, round(i.c91::numeric, 2) AS pv2, round(i.c92::numeric, 2) AS pv3,
         array[btrim(i.c7), btrim(i.c93), btrim(i.c102)] AS cb1,
         array[btrim(i.c82), btrim(i.c95), btrim(i.c96)] AS cb2,
         array[btrim(i.c85), btrim(i.c97), btrim(i.c98)] AS cb3,
         coalesce(v.mayoreo, '') AS mayoreo
    FROM kepler_ods.kdii i
    JOIN plazas ON plazas.suc = i.sucursal
    LEFT JOIN kepler_ods.kdig lg ON lg.sucursal = i.sucursal AND btrim(lg.c1) = btrim(i.c3)
    LEFT JOIN kepler_ods.kdie te ON te.sucursal = i.sucursal AND btrim(te.c1) = btrim(i.c4)
    LEFT JOIN kepler_ods.kdif gf ON gf.sucursal = i.sucursal AND btrim(gf.c1) = btrim(i.c5)
    LEFT JOIN volumen v ON v.suc = i.sucursal AND v.sku = btrim(i.c1)
   -- Fichas con SKU vacío existen en el espejo (basura de captura): no son un producto.
   WHERE btrim(i.c1) <> ''
), diferentes AS (
  SELECT sku
    FROM f
   GROUP BY sku
  HAVING count(*) >= 2 AND (
         count(DISTINCT descripcion) > 1 OR count(DISTINCT linea) > 1 OR count(DISTINCT tipo) > 1
      OR count(DISTINCT grupo) > 1 OR count(DISTINCT iva) > 1 OR count(DISTINCT ieps) > 1
      OR count(DISTINCT (u1, u2, u3, f2, f3)) > 1
      OR count(DISTINCT pv1) > 1 OR count(DISTINCT pv2) > 1 OR count(DISTINCT pv3) > 1
      OR count(DISTINCT mayoreo) > 1 OR count(DISTINCT (cb1, cb2, cb3)) > 1)
), ultimo AS (
  -- El último cambio REAL de precio (al centavo) por plaza: la misma condición del índice parcial
  -- ix_kdpv_bitacora_cambio_plaza_dia, por eso cuesta ~0.5 s sobre toda la bitácora.
  SELECT b.sucursal AS suc, btrim(b.c3) AS sku, max(b.c1)::date AS fecha
    FROM kepler_ods.kdpv_bitacora_precios b
   WHERE round(b.c6, 2) IS DISTINCT FROM round(b.c7, 2)
   GROUP BY 1, 2
), venta AS (
  SELECT a.sku, sum(a.venta_bruta)::numeric AS venta_30d
    FROM analytics.mv_kepler_standard_cost_activity a
   GROUP BY 1
)
SELECT d.sku,
       coalesce(venta.venta_30d, 0) AS venta_30d,
       jsonb_agg(jsonb_build_object(
         'sucursal', f.suc, 'descripcion', f.descripcion,
         'linea', f.linea, 'linea_nombre', f.linea_nombre,
         'tipo', f.tipo, 'tipo_nombre', f.tipo_nombre,
         'grupo', f.grupo, 'grupo_nombre', f.grupo_nombre,
         'iva', f.iva, 'ieps', f.ieps,
         'u1', f.u1, 'u2', f.u2, 'u3', f.u3, 'f2', f.f2, 'f3', f.f3,
         'pv1', f.pv1, 'pv2', f.pv2, 'pv3', f.pv3,
         'cb1', f.cb1, 'cb2', f.cb2, 'cb3', f.cb3,
         'mayoreo', f.mayoreo,
         'ultimo_cambio', u.fecha
       ) ORDER BY f.suc) AS celdas
  FROM diferentes d
  JOIN f ON f.sku = d.sku
  LEFT JOIN ultimo u ON u.suc = f.suc AND u.sku = f.sku
  LEFT JOIN venta ON venta.sku = d.sku
 GROUP BY d.sku, venta.venta_30d
`;

/**
 * `[CAT-PRECIO.5]` Mantenimiento › **Sin clasificar**: productos sin línea, tipo o grupo en NINGUNA de
 * las sucursales que venden al público. Vacío o `00001` («NO APLICA» en los catálogos de Kepler) cuentan
 * como sin asignar. Si alguna sucursal sí lo tiene, no es «sin clasificar»: es una diferencia entre
 * sucursales y la reporta `FICHA_SUCURSALES_SQL`.
 *
 * Medido el 2026-10-16: tipo y grupo están asignados sólo en ~43 % de las fichas de sucursal.
 */
export const SIN_CLASIFICAR_SQL = `
WITH plazas AS (
  SELECT DISTINCT w.kepler_code AS suc
    FROM commercial.warehouses w
   WHERE w.deleted_at IS NULL AND w.sells_to_public IS TRUE AND w.kepler_code IS NOT NULL
), f AS (
  SELECT btrim(i.c1) AS sku, btrim(i.c2) AS nombre,
         nullif(nullif(btrim(i.c3), ''), '00001') AS linea, btrim(lg.c2) AS linea_nombre,
         nullif(nullif(btrim(i.c4), ''), '00001') AS tipo,
         nullif(nullif(btrim(i.c5), ''), '00001') AS grupo
    FROM kepler_ods.kdii i
    JOIN plazas ON plazas.suc = i.sucursal
    LEFT JOIN kepler_ods.kdig lg ON lg.sucursal = i.sucursal AND btrim(lg.c1) = btrim(i.c3)
   -- Fichas con SKU vacío existen en el espejo (basura de captura): no son un producto.
   WHERE btrim(i.c1) <> ''
), venta AS (
  SELECT a.sku, sum(a.venta_bruta)::numeric AS venta_30d
    FROM analytics.mv_kepler_standard_cost_activity a
   GROUP BY 1
)
SELECT f.sku, max(f.nombre) AS nombre, count(*)::int AS plazas,
       -- El código y el nombre de la línea salen JUNTOS de la misma ficha: agregarlos por separado podía
       -- pegar el código de una plaza con el nombre de otra (revisión independiente, 2026-10-16).
       (array_agg(f.linea ORDER BY f.linea, f.linea_nombre) FILTER (WHERE f.linea IS NOT NULL))[1] AS linea,
       (array_agg(f.linea_nombre ORDER BY f.linea, f.linea_nombre) FILTER (WHERE f.linea IS NOT NULL))[1] AS linea_nombre,
       bool_and(f.linea IS NULL) AS sin_linea,
       bool_and(f.tipo IS NULL)  AS sin_tipo,
       bool_and(f.grupo IS NULL) AS sin_grupo,
       coalesce(max(venta.venta_30d), 0) AS venta_30d
  FROM f
  LEFT JOIN venta ON venta.sku = f.sku
 GROUP BY f.sku
HAVING bool_and(f.linea IS NULL) OR bool_and(f.tipo IS NULL) OR bool_and(f.grupo IS NULL)
`;

/** Cuántos productos se compararon (con ficha en 2 o más plazas): el denominador que se publica. */
export const FICHA_SUCURSALES_UNIVERSO_SQL = `
SELECT count(*)::int AS productos
  FROM (SELECT btrim(i.c1)
          FROM kepler_ods.kdii i
          JOIN commercial.warehouses w
            ON w.kepler_code = i.sucursal AND w.deleted_at IS NULL AND w.sells_to_public IS TRUE
         WHERE btrim(i.c1) <> ''
         GROUP BY 1
        HAVING count(*) >= 2) x
`;

/**
 * `[CAT-PRECIO.6]` Mantenimiento · **Costo o precio en cero.** Cada unidad EN USO de la ficha de Kepler (`kdii`) en cada
 * sucursal que vende al público, con su costo o su precio de venta en cero.
 *
 *  - Las tres unidades de la ficha (`ERP_KEPLER.md` §2.1.1, decodificadas al centavo contra la pantalla de Kepler):
 *    base `c11` · costo `c77` · PV `c90`; dos `c80` · factor `c81` · costo `c78` · PV `c91`; tres `c83` · `c84` · `c79` · `c92`.
 *  - «En uso» = la base siempre; la dos y la tres sólo rotuladas Y con factor > 0. Una unidad rotulada con factor 0 trae
 *    costo y precio 0 por construcción (la escalera corrida de §2.1): no es un error de la ficha.
 *  - `c77` es TEXTO en el espejo y trae vacíos: vacío = «vacio» (Kepler lo muestra en cero), 0 = «cero». Mismo regex que
 *    `LISTA_PRECIOS_SQL` (sin el cuantificador corto: knex vuelve parámetro cada signo de interrogación).
 *  - Medido en prod el 2026-11-20 (con RLS): 291 productos, 63 de ellos también con precio en cero, 120 con venta en 30 días.
 *  - UNA pasada sobre la ficha: la marca «tiene algo en cero» se calcula por renglón ANTES de abrirlo en sus tres
 *    unidades. Abrir las ~76 mil fichas en tres costaba 1.0–1.5 s; se abren sólo las que tienen algo.
 */
export const EN_CEROS_SQL = `
WITH plazas AS (
  SELECT w.kepler_code AS suc, min(w.name) AS nombre
    FROM commercial.warehouses w
   WHERE w.deleted_at IS NULL AND w.sells_to_public IS TRUE AND w.kepler_code IS NOT NULL
   GROUP BY 1
), k AS (
  SELECT i.sucursal AS suc, btrim(i.c1) AS sku, i.c2, i.c3, i.c11, i.c80, i.c81, i.c83, i.c84, i.c78, i.c79, i.c90, i.c91, i.c92,
         CASE WHEN btrim(i.c77) ~ '^[-]{0,1}[0-9]+([.][0-9]+){0,1}$' THEN btrim(i.c77)::numeric END AS c77n
    FROM kepler_ods.kdii i
    JOIN plazas ON plazas.suc = i.sucursal
   -- Fichas con SKU vacío existen en el espejo (basura de captura): no son un producto.
   WHERE btrim(i.c1) <> ''
), marcadas AS (
  SELECT k.*,
         (COALESCE(k.c77n, 0) = 0 OR COALESCE(k.c90, 0) = 0
          OR (btrim(k.c80) <> '' AND k.c81 > 0 AND (COALESCE(k.c78, 0) = 0 OR COALESCE(k.c91, 0) = 0))
          OR (btrim(k.c83) <> '' AND k.c84 > 0 AND (COALESCE(k.c79, 0) = 0 OR COALESCE(k.c92, 0) = 0))) AS algo_en_cero
    FROM k
), fichas AS (
  SELECT sku, count(DISTINCT suc)::int AS plazas FROM marcadas GROUP BY sku HAVING bool_or(algo_en_cero)
), u AS (
  SELECT m.suc, m.sku, btrim(m.c2) AS nombre,
         nullif(nullif(btrim(m.c3), ''), '00001') AS linea, btrim(lg.c2) AS linea_nombre,
         n.n,
         upper(CASE n.n WHEN 1 THEN btrim(m.c11) WHEN 2 THEN btrim(m.c80) ELSE btrim(m.c83) END) AS unidad,
         (CASE n.n WHEN 1 THEN 1 WHEN 2 THEN m.c81 ELSE m.c84 END)::numeric AS factor,
         (CASE n.n WHEN 1 THEN m.c77n WHEN 2 THEN m.c78 ELSE m.c79 END)::numeric AS costo,
         (CASE n.n WHEN 1 THEN m.c90 WHEN 2 THEN m.c91 ELSE m.c92 END)::numeric AS pv
    FROM marcadas m
    LEFT JOIN kepler_ods.kdig lg ON lg.sucursal = m.suc AND btrim(lg.c1) = btrim(m.c3)
    CROSS JOIN (VALUES (1), (2), (3)) AS n(n)
   WHERE m.algo_en_cero
), ceros AS (
  SELECT u.*,
         CASE WHEN u.costo IS NULL THEN 'vacio' WHEN u.costo = 0 THEN 'cero' END AS costo_mal,
         COALESCE(u.pv, 0) = 0 AS precio_cero
    FROM u
   WHERE u.unidad <> '' AND (u.n = 1 OR u.factor > 0)
     AND (u.costo IS NULL OR u.costo = 0 OR COALESCE(u.pv, 0) = 0)
), venta AS (
  SELECT a.sku, sum(a.venta_bruta)::numeric AS venta_30d
    FROM analytics.mv_kepler_standard_cost_activity a
   WHERE a.sku IN (SELECT sku FROM fichas)
   GROUP BY 1
)
SELECT c.sku, max(c.nombre) AS nombre, max(fichas.plazas) AS plazas,
       (array_agg(c.linea ORDER BY c.linea, c.linea_nombre) FILTER (WHERE c.linea IS NOT NULL))[1] AS linea,
       (array_agg(c.linea_nombre ORDER BY c.linea, c.linea_nombre) FILTER (WHERE c.linea IS NOT NULL))[1] AS linea_nombre,
       bool_or(c.costo_mal IS NOT NULL) AS costo_en_cero,
       bool_or(c.precio_cero) AS precio_en_cero,
       jsonb_agg(jsonb_build_object('sucursal', c.suc, 'sucursal_nombre', p.nombre, 'unidad', c.unidad,
                                    'costo', c.costo_mal, 'precio_cero', c.precio_cero)
                 ORDER BY c.suc, c.n) AS ceros,
       coalesce(max(venta.venta_30d), 0) AS venta_30d
  FROM ceros c
  JOIN plazas p ON p.suc = c.suc
  JOIN fichas ON fichas.sku = c.sku
  LEFT JOIN venta ON venta.sku = c.sku
 GROUP BY c.sku
`;
