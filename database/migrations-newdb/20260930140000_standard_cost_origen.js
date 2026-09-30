'use strict';
/**
 * `[CE.11]` — **La pantalla decía que reponer cuesta más y no decía por qué.**
 *
 * Pedido de Edgar: *"mencionas que la reposición es más alta en algunos lugares pero no explicas
 * por qué… al dar clic debemos explicar cosas que supones"*. Tenía razón: la fila afirmaba un
 * hecho y dejaba la causa a la imaginación. Y al ir a buscarla, **mi suposición era falsa**.
 *
 * ── ⛔ Lo que yo suponía, y lo que dice la medición ────────────────────────────────────
 *
 * Suponía *"esa plaza compró más caro"*. El caso que Edgar tenía en pantalla lo desmiente:
 *
 * ```text
 * 20119 K'PIÑATON MIX — plaza 01 repone a $189.07, las otras a $138.44
 *   la UNICA compra del SKU en 6 meses .... X-A-40, sucursal 00 (CEDIS), $138.441337
 *   lo que movio el costo de la plaza 01 .. N-A-30 del 11-sep, $189.07
 *                                           = "Entrada Inventario fisico" (nombre de Kepler)
 *   la plaza 06 no tuvo ese ajuste ........ se quedo en $138.44
 * ```
 *
 * La plaza **no compró: recibió**, y lo que le fijó el costo fue **un conteo físico**.
 *
 * ⭐⭐ **Y no es un caso raro. Medido sobre los 33,286 pares (sucursal × SKU) con costo:**
 *
 * ```text
 * pares cuyo costo se puede atribuir a un movimiento .... 25,071 = 75.3 %
 *   por INVENTARIO FISICO (N-A-30 / N-A-44 / N-A-45 / N-D-30) ... 17,882 = 71.3 %
 *   por la cadena de COMPRA (X-A-20 / 35 / 37 / 40) .............  6,901 = 27.5 %
 *   otros movimientos N ........................................     288 =  1.1 %
 * pares sin movimiento que lo explique .................. 8,215 = 24.7 %  <-- se DECLARA
 * ```
 *
 * **Siete de cada diez costos de reposición los fijó un conteo de inventario, no una compra.**
 * Eso cambia la conversación: «la ficha está vieja» presupone que alguien compró más caro, y en
 * la mayoría de los casos lo que pasó es que un ajuste de inventario entró con otro costo.
 *
 * ── Cómo se atribuye, y por qué así ────────────────────────────────────────────────────
 *
 * Se busca el movimiento **NO de venta** más reciente (180 d) cuyo precio unitario coincida con
 * `kdik.c16` **dentro del 1 %**. No es una cadena causal reconstruida: es *"el último documento
 * que dejó este número"*, que es exactamente lo que la pantalla necesita para poder señalarlo.
 *
 * ⚠️ **El rótulo NO se inventa: sale de `kepler_ods.kdmm`**, el catálogo de doctypes del propio
 * ERP (regla dura del proyecto — nunca adivinar `c2`/`c3`/`c4`). ⚠️ `kdmm` tiene **varias filas
 * por clave** (`N-D-5` trae cinco nombres distintos: Carta porte, Salida de almacén, Salida por
 * ajuste…): se toma uno de forma determinista y `origen_nombre_ambiguo` lo declara, para que la
 * pantalla no presente como único un rótulo que no lo es.
 *
 * ⚠️ **Se materializa** porque el barrido de `kdm2` para documentos que NO son venta no tiene
 * índice (los dos que hay son parciales sobre `c2='U'`). Medido: **2.1 s** — rápido para una
 * pasada nocturna, caro para una pantalla con gate de 1 s.
 *
 * ⛔ Y el primer intento tardaba **más de 4 minutos y moría**: era un `LEFT JOIN` con `DISTINCT
 * ON` que el planificador resolvía por bucles anidados. Con `JOIN` y los pares del costo como
 * lado externo son 2.1 s. *La diferencia no era el volumen, era la forma de la consulta.*
 */

exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(`
    SELECT (to_regclass('kepler_ods.kdm2') IS NOT NULL
        AND to_regclass('kepler_ods.kdik') IS NOT NULL
        AND to_regclass('kepler_ods.kdmm') IS NOT NULL) AS ok`)).rows;
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log('  faltan kdm2 / kdik / kdmm - [CE.11] omitido');
    return;
  }

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_cost_origin`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_kepler_cost_origin AS
    WITH costo AS (
      -- el MISMO anti-replica que la vista y que v_kepler_unit_cost: sucursal = btrim(c1)
      SELECT k.sucursal, btrim(k.c2) AS sku, NULLIF(max(k.c16)::numeric, 0) AS c16
        FROM kepler_ods.kdik k
       WHERE k.sucursal = btrim(k.c1)
         AND k.c16 = k.c16 AND k.c16 > '-Infinity'::float8 AND k.c16 < 'Infinity'::float8
       GROUP BY k.sucursal, btrim(k.c2)
    ), mov AS (
      SELECT m.sucursal, btrim(m.c8) AS sku,
             btrim(m.c2) AS gen, btrim(m.c3) AS nat, m.c4::int AS tipo,
             m.c32::date AS fecha, btrim(m.c6) AS folio,
             round(nullif(regexp_replace(m.c12::text, '[^0-9.-]', '', 'g'), '')::numeric, 4) AS precio,
             round(m.c9::numeric, 4) AS cantidad,
             NULLIF(btrim(m.c11), '') AS unidad
        FROM kepler_ods.kdm2 m
       WHERE m.c2 <> 'U' AND m.c32 >= CURRENT_DATE - 180
         AND nullif(regexp_replace(m.c12::text, '[^0-9.-]', '', 'g'), '')::numeric > 0
         AND btrim(m.c8) <> ''
    ), elegido AS (
      SELECT DISTINCT ON (c.sucursal, c.sku)
             c.sucursal, c.sku, mv.gen, mv.nat, mv.tipo, mv.fecha, mv.folio,
             mv.precio, mv.cantidad, mv.unidad
        FROM costo c
        JOIN mov mv ON mv.sucursal = c.sucursal AND mv.sku = c.sku
                   AND abs(mv.precio / c.c16 - 1) <= 0.01
       WHERE c.c16 > 0
       ORDER BY c.sucursal, c.sku, mv.fecha DESC, mv.folio DESC
    ), rotulo AS (
      -- El nombre sale del catalogo del ERP, nunca de una lista nuestra. kdmm repite claves
      -- (N-D-5 trae cinco nombres): se toma el menor y se DECLARA que habia mas de uno.
      SELECT c1 AS gen, c2 AS nat, c3::int AS tipo,
             min(btrim(c5)) AS nombre,
             count(DISTINCT btrim(c5)) > 1 AS ambiguo
        FROM kepler_ods.kdmm
       WHERE btrim(coalesce(c5, '')) <> ''
       GROUP BY c1, c2, c3::int
    )
    SELECT e.sucursal,
           e.sku,
           (e.gen || '-' || e.nat || '-' || e.tipo::text)          AS origen_doctype,
           r.nombre                                                AS origen_nombre,
           COALESCE(r.ambiguo, false)                              AS origen_nombre_ambiguo,
           -- la familia en castellano llano, que es lo que la pantalla necesita decir
           CASE WHEN e.gen = 'X' THEN 'compra'
                WHEN e.gen = 'N' AND e.tipo IN (30, 44, 45) THEN 'inventario_fisico'
                WHEN e.gen = 'N' THEN 'traspaso_u_otro'
                ELSE 'otro' END                                    AS origen_familia,
           e.fecha                                                 AS origen_fecha,
           to_char(e.fecha, 'YYYY-MM-DD')                          AS origen_fecha_txt,
           e.folio                                                 AS origen_folio,
           e.precio                                                AS origen_precio,
           e.cantidad                                              AS origen_cantidad,
           e.unidad                                                AS origen_unidad,
           (CURRENT_DATE - 180)                                    AS ventana_desde,
           CURRENT_DATE                                            AS ventana_hasta
      FROM elegido e
      LEFT JOIN rotulo r ON r.gen = e.gen AND r.nat = e.nat AND r.tipo = e.tipo`);

  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_kepler_cost_origin ON analytics.mv_kepler_cost_origin (sucursal, sku)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_kepler_cost_origin TO app_runtime`);
  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_cost_origin IS
    $$[CE.11] Que movimiento dejo el costo del ERP (kdik.c16) en su valor: el documento NO de venta
    mas reciente (180 d) cuyo precio unitario casa dentro del 1%. Medido: explica 25,071 de 33,286
    pares (75.3%), y de esos el 71.3% es INVENTARIO FISICO, no una compra. El rotulo sale de
    kepler_ods.kdmm (catalogo del ERP) y origen_nombre_ambiguo declara las claves con varios
    nombres. Refresco: AnalyticsRefreshService (nightly). Lo que no se explica NO aparece: el
    consumidor lo ve como ausencia, no como cero.$$`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_cost_origin`);
};
