/**
 * `[CAT-PRECIO.2]`–`[CAT-PRECIO.4]` Compras › Catálogo › **Precios**: el catálogo de precios de UNA
 * sucursal, su cambio automático (precio por volumen) y la historia de cada precio.
 *
 * Fuente: la ficha «Productos POS» de Kepler de esa sucursal (`kepler_ods.kdii`) con sus catálogos de
 * línea (`kdig`), tipo (`kdie`) y grupo (`kdif`), el precio por volumen nivel 0 (`kdpv_prod_util`) y la
 * bitácora nativa de precios (`analytics.v_label_price_changes`). Todo derivado en la consulta, sin
 * copiar (regla principal). Columnas verificadas el 2026-10-16 contra la ficha 02073 en Kepler:
 *   c2 descripción · c3 línea · c4 tipo · c5 grupo · c18 IVA · c19 IEPS (negativo = el precio lo incluye)
 *   c11/c80/c83 unidades · c81/c84 factor de la unidad 2 y 3 · c90/c91/c92 precio · c77 costo estándar
 *   códigos: unidad 1 c7/c93/c102 · unidad 2 c82/c95/c96 · unidad 3 c85/c97/c98
 *
 * ⚠️ El costo NO sale de aquí hacia la pantalla: se usa para calcular el margen en el servidor y se
 *    descarta (decisión de Compras: el margen se ve, el costo no).
 * (Sin acentos graves aquí adentro: cierran el template literal.)
 */
export const LISTA_PRECIOS_SQL = `
WITH volumen AS (
  SELECT btrim(p.c1) AS sku, upper(btrim(p.c2)) AS unidad,
         jsonb_agg(jsonb_build_object('desde', p.c4::numeric, 'precio', round(p.c7::numeric, 2))
                   ORDER BY p.c4::numeric) AS tramos
    FROM kepler_ods.kdpv_prod_util p
   WHERE p.sucursal = :suc AND p.c3 = 0 AND p.c7::numeric > 0
   GROUP BY 1, 2
)
SELECT btrim(i.c1) AS sku, btrim(i.c2) AS nombre,
       btrim(i.c3) AS linea, btrim(lg.c2) AS linea_nombre,
       btrim(i.c4) AS tipo,  btrim(te.c2) AS tipo_nombre,
       btrim(i.c5) AS grupo, btrim(gf.c2) AS grupo_nombre,
       -- c77 es TEXTO en el espejo (las demás son numeric) y trae vacíos: se convierte con cuidado.
       -- ⛔ Sin signos de interrogación en este SQL: knex convierte CADA uno en un parámetro ($n) y la
       --    consulta revienta con 500. Por eso el regex usa {0,1} y no el cuantificador corto.
       i.c18::numeric AS iva, i.c19::numeric AS ieps,
       CASE WHEN btrim(i.c77) ~ '^[-]{0,1}[0-9]+([.][0-9]+){0,1}$' THEN btrim(i.c77)::numeric END AS costo,
       upper(btrim(i.c11)) AS u1, upper(btrim(i.c80)) AS u2, upper(btrim(i.c83)) AS u3,
       i.c81::numeric AS f2, i.c84::numeric AS f3,
       round(i.c90::numeric, 2) AS pv1, round(i.c91::numeric, 2) AS pv2, round(i.c92::numeric, 2) AS pv3,
       array[btrim(i.c7), btrim(i.c93), btrim(i.c102)] AS cb1,
       array[btrim(i.c82), btrim(i.c95), btrim(i.c96)] AS cb2,
       array[btrim(i.c85), btrim(i.c97), btrim(i.c98)] AS cb3,
       v1.tramos AS vol1, v2.tramos AS vol2, v3.tramos AS vol3
  FROM kepler_ods.kdii i
  LEFT JOIN kepler_ods.kdig lg ON lg.sucursal = i.sucursal AND btrim(lg.c1) = btrim(i.c3)
  LEFT JOIN kepler_ods.kdie te ON te.sucursal = i.sucursal AND btrim(te.c1) = btrim(i.c4)
  LEFT JOIN kepler_ods.kdif gf ON gf.sucursal = i.sucursal AND btrim(gf.c1) = btrim(i.c5)
  LEFT JOIN volumen v1 ON v1.sku = btrim(i.c1) AND v1.unidad = upper(btrim(i.c11))
  LEFT JOIN volumen v2 ON v2.sku = btrim(i.c1) AND v2.unidad = upper(btrim(i.c80)) AND btrim(i.c80) <> ''
  LEFT JOIN volumen v3 ON v3.sku = btrim(i.c1) AND v3.unidad = upper(btrim(i.c83)) AND btrim(i.c83) <> ''
 WHERE i.sucursal = :suc AND btrim(i.c1) <> ''
`;

/**
 * Los cambios de precio de UN día en UNA sucursal, con el anterior. Misma fuente y mismo piso que
 * Etiquetas › Cambios (`[ETQ-CAMBIOS.4]`): se ocultan los de exactamente un centavo, que son el
 * 41.9 % de la semana y no mueven la etiqueta; cuántos se ocultaron se publica aparte.
 * El filtro va sobre las columnas que entran por el índice (sucursal, fecha): 4 bloques medidos.
 */
export const CAMBIOS_DIA_SQL = `
SELECT sku, upper(coalesce(unidad, '')) AS unidad, precio_anterior, precio_nuevo, delta, es_baja, hora
  FROM analytics.v_label_price_changes
 WHERE sucursal = :suc AND fecha = :fecha::date
`;

/** La historia de UN precio (producto × unidad × sucursal): cada cambio real, del más nuevo al más viejo. */
export const HISTORIA_PRECIO_SQL = `
SELECT fecha::text AS fecha, hora, precio_anterior, precio_nuevo, delta, es_baja
  FROM analytics.v_label_price_changes
 WHERE sucursal = :suc AND sku = :sku AND upper(coalesce(unidad, '')) = :unidad
 ORDER BY fecha DESC, hora DESC NULLS LAST
`;

/**
 * Los meses SIN una sola fila en la bitácora de esa sucursal (entre la primera y la última). Medido
 * el 2026-10-16: abril de 2025 está vacío y julio–agosto de 2025 casi vacíos. Un mes sin filas no es
 * «el precio no cambió»: es que no hay registro, y la gráfica lo tiene que decir.
 */
export const BITACORA_MESES_SQL = `
WITH m AS (
  SELECT date_trunc('month', c1)::date AS mes, count(*) AS filas
    FROM kepler_ods.kdpv_bitacora_precios
   WHERE sucursal = :suc
   GROUP BY 1
), rango AS (
  SELECT generate_series(min(mes), max(mes), interval '1 month')::date AS mes FROM m
)
SELECT to_char(r.mes, 'YYYY-MM') AS mes, coalesce(m.filas, 0)::int AS filas
  FROM rango r LEFT JOIN m ON m.mes = r.mes
 ORDER BY r.mes
`;

/** Hasta qué día llegó la bitácora en esa sucursal: sin esto, «no cambió nada hoy» y «no llegó hoy» se ven igual. */
export const BITACORA_HASTA_SQL = `
SELECT max(c1)::date::text AS hasta FROM kepler_ods.kdpv_bitacora_precios WHERE sucursal = :suc
`;
