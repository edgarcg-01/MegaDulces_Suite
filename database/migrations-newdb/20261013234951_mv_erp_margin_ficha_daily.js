'use strict';
/**
 * `[MR.9.1]` — **El margen contra el COSTO ESTÁNDAR, también en mayoreo.**
 *
 * Pedido de Francisco (2026-10-13): «necesito una verdad sobre la rentabilidad de cada producto: el
 * costo estándar contra el precio de venta». Hoy `/comercial/rentabilidad` costea la pierna Kepler con
 * `monto / (1 + markup_pct)` — álgebra del catálogo, no un costo: el 70002 sale a **9.00 %** en TODAS
 * las sucursales, se haya vendido a $35 o a $30.
 *
 * El árbitro `analytics.mv_erp_margin_daily` (`[MR.8.2]`) ya resolvió el mostrador con el costo que
 * Kepler CONGELA en el renglón (`kdm2.c62`). Lo que no resuelve es el **mayoreo (`U-D-8`)**: ahí `c62`
 * viene vacío en el ~99 % (límite de la fuente, `FASE_MR8` §3) — **$10.86 M de venta neta en 30 días
 * sin costo**, la cuarta parte de la venta Kepler. Esta migración llena ese hueco con el **costo
 * estándar de la ficha** de la misma sucursal, y junta las dos piernas en una sola vista.
 *
 * ── Qué es el costo de la ficha, y por qué SÍ se puede usar ─────────────────────────────────
 * `kepler_ods.kdii.c77` = costo estándar de la unidad BASE del producto en esa sucursal (`FASE_CE` §1:
 * es el que fija el precio, cuadra al centavo en 97.75 %). El renglón declara su peldaño: `c58` =
 * piezas base por unidad vendida, `c56` = cantidad en ese peldaño (`c9 = c56 × c58`). Entonces
 *
 *     costo del renglón = c77 × c58 × c56        (mismo peldaño que c62 × c56 del árbitro)
 *
 * **Medido en prod, sólo lectura (2026-10-13), sobre renglones que traen LOS DOS costos:**
 * ```
 *                      Σ c62 × c56      Σ c77 × c58 × c56     diferencia
 *   U-D-10   0–30 d    $27,797,387      $27,825,458           +0.10 %
 *   U-D-10  30–60 d    $16,735,289      $16,737,356           +0.01 %
 *   U-D-10  60–90 d    $11,367,557      $11,316,344           −0.45 %
 *   U-D-8    0–30 d       $131,838         $132,274           +0.33 %  (146 renglones)
 * ```
 * Renglón por renglón coinciden al centavo en el 90.6 % (los demás: la ficha cambió después de vender).
 * ⚠️ **Es el costo de HOY, no el del día de la venta.** Dentro de 90 días la deriva en pesos es < 0.5 %;
 * más atrás no hay con qué comprobarlo (el mayoreo anterior a junio-2026 no trae ni un `c62`). Por eso
 * el método se DECLARA por fila (`ficha_actual`), nunca se presenta como el costo del ticket.
 *
 * ── Las decisiones ──────────────────────────────────────────────────────────────────────────
 *  1. **Sólo `U-D-8`.** Los renglones de `U-D-10`/`U-D-12` sin `c62` son $1,495 en 30 d; leerlos exige
 *     barrer todo el mostrador (400 d > 300 s, medido en `[MR.8.2]`). Mayoreo solo: **3.8 s a 400 d**.
 *     Ese residuo queda como `sin_costo` en la vista, declarado.
 *  2. **Sólo renglones SIN `c62`.** Los que lo traen ya los costea el árbitro: las dos piernas son
 *     DISJUNTAS por construcción y se pueden sumar sin contar dos veces.
 *  3. **Mismos filtros, mismas expresiones que el árbitro** (cancelado, `SER`, cantidad 0, venta neta
 *     de IVA/IEPS por renglón, mapa de rutas): si divergen, la vista combinada suma universos distintos.
 *  4. ⛔ **Réplica cruzada: el almacén tiene que ser de su propia sucursal** (`left(c1,2) = sucursal`).
 *     Medido: la réplica de la `03` trae copia de los documentos de la `02` de oct-2025 a ene-2026
 *     (en `U-D-8`, 906 documentos / $525,938; en todo `U-D-8/10/12`, **~$8.3 M**). El árbitro NO tiene
 *     este filtro → en esos meses publica la venta de la 02 también en la 03. **Hallazgo declarado, no
 *     corregido acá** (rehacer el árbitro arrastra a sus dependientes); en mayoreo esta vista no lo copia.
 *
 * ── `WITH NO DATA` ──────────────────────────────────────────────────────────────────────────
 * El poblado lo hace el refresco nocturno (`AnalyticsRefreshService`, justo después del árbitro), que
 * detecta `relispopulated = false` y llena sin `CONCURRENTLY` la primera vez. Medido: 3.8 s a 400 d.
 *
 * Aditiva e idempotente. **No toca ningún objeto existente.**
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces

/** Numérico tolerante — la MISMA expresión que `mv_erp_margin_daily` (decisión 3). */
const N = (x, d) => `round(NULLIF(regexp_replace(${x}::text, '[^0-9.-]', '', 'g'), '')::numeric, ${d})`;

/**
 * El cuerpo. Se usa para la matview y para la sonda de las compuertas (un solo origen: si divergen,
 * la compuerta deja de medir lo que se crea).
 */
const cuerpo = (filtroFecha) => `
  WITH lin AS (
    SELECT btrim(h.sucursal)                                   AS sucursal,
           btrim(l.c1)                                         AS almacen_erp,
           h.c4::int                                           AS doctype,
           h.c9::date                                          AS sale_date,
           btrim(l.c8)                                         AS sku,
           ${N('l.c9', 4)}                                     AS q_base,
           ${N('l.c56', 4)}                                    AS q_vend,
           ${N('l.c58', 4)}                                    AS factor,
           ${N('l.c13', 2)}                                    AS importe,
           COALESCE(${N('l.c17', 4)}, 0)                       AS tasa_iva,
           COALESCE(${N('l.c18', 4)}, 0)                       AS tasa_ieps
      FROM kepler_ods.kdm1 h
      JOIN kepler_ods.kdm2 l
        ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
       AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
     WHERE h.c2 = 'U' AND h.c3 = 'D'
       AND btrim(h.c4::text) = '8'
       AND ${filtroFecha}
       -- Decisión 4: el documento es de SU sucursal (corta la réplica cruzada 03 <- 02).
       AND left(btrim(h.c1), 2) = btrim(h.sucursal)
       AND COALESCE(NULLIF(btrim(h.c43), ''), '') <> 'C'
       AND COALESCE(btrim(l.c11), '') <> 'SER'
       AND abs(COALESCE(${N('l.c9', 4)}, 0)) > 0
       -- Decisión 2: sólo lo que el árbitro NO costea.
       AND NOT COALESCE(${N('l.c62', 6)} > 0, false)
  ), calc AS (
    SELECT lin.*,
           importe / (1 + abs(tasa_iva) / 100 + abs(tasa_ieps) / 100)              AS neto,
           -- c77 es la unidad BASE; c58 la lleva al peldaño vendido; c56 son los vendidos en ese
           -- peldaño. Respaldo q_base (= c56 × c58) si el renglón no declara el peldaño.
           CASE WHEN ${N('k.c77', 6)} > 0
                THEN CASE WHEN factor > 0 AND q_vend IS NOT NULL
                          THEN ${N('k.c77', 6)} * factor * q_vend
                          ELSE ${N('k.c77', 6)} * q_base END END                    AS cogs
      FROM lin
      LEFT JOIN kepler_ods.kdii k
        ON k.sucursal = lin.sucursal AND btrim(k.c1) = lin.sku
  )
  -- ⛔ SIN JOIN a catalog.products ni commercial.warehouses, a propósito (medido 2026-10-13): con
  -- ellos el planner estima 4 renglones de mayoreo en 400 d y cruza cada uno contra los 9,710
  -- productos por un btrim() — no terminó en 59 s. Se guarda la llave de KEPLER (almacén + sku) y la
  -- vista combinada se une al árbitro por sus columnas warehouse_code + sku, que valen lo mismo
  -- (w.code = COALESCE(map, sucursal), p.sku = btrim(c8)). De paso, sin tablas con RLS forzada, el
  -- refresco no puede materializarse VACÍO por un app.tenant_id ausente (riesgo de [MR.8.2]).
  SELECT '${TENANT}'::uuid                                                 AS tenant_id,
         COALESCE(m.warehouse_code, c.sucursal)                            AS warehouse_code,
         c.sku,
         c.sale_date,
         c.doctype,
         COUNT(*)::int                                                     AS lineas,
         COUNT(*) FILTER (WHERE c.cogs IS NOT NULL)::int                   AS lineas_con_ficha,
         COUNT(*) FILTER (WHERE c.cogs > c.neto)::int                      AS lineas_costo_gt_venta,
         ROUND(SUM(c.neto), 2)                                             AS venta_neta,
         ROUND(SUM(c.neto) FILTER (WHERE c.cogs IS NOT NULL), 2)           AS venta_neta_ficha,
         ROUND(SUM(c.cogs), 2)                                             AS cogs_ficha
    FROM calc c
    LEFT JOIN analytics.erp_warehouse_map m
           ON m.tenant_id = '${TENANT}'::uuid
          AND m.sucursal = c.sucursal
          AND m.almacen_erp = c.almacen_erp
   GROUP BY COALESCE(m.warehouse_code, c.sucursal), c.sku, c.sale_date, c.doctype`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Compuertas, sobre una sonda EN VIVO de 30 días (la matview nace vacía) ─────────────
  const { rows: g } = await knex.raw(`
    WITH celda AS (${cuerpo(`h.c9::date BETWEEN CURRENT_DATE - 30 AND CURRENT_DATE`)})
    SELECT COUNT(*)::int                                                         AS celdas,
           COALESCE(SUM(lineas), 0)::int                                         AS lineas,
           ROUND(100.0 * SUM(venta_neta_ficha) / NULLIF(SUM(venta_neta), 0), 2)  AS pct_cubierto,
           ROUND(100 * (1 - SUM(cogs_ficha) / NULLIF(SUM(venta_neta_ficha), 0)), 2) AS margen,
           ROUND(100.0 * SUM(lineas_costo_gt_venta) / NULLIF(SUM(lineas), 0), 3)  AS pct_gt
      FROM celda`);
  const s = g[0];
  console.log(
    `  · [MR.9.1] sonda 30d mayoreo: ${s.celdas} celdas / ${s.lineas} lineas · cubierto ${s.pct_cubierto}% · ` +
      `margen ${s.margen}% · costo>venta ${s.pct_gt}%`,
  );
  // Base sin mayoreo en la ventana (una DB de desarrollo): NO MEDIDO, no un rojo ni un verde.
  if (!(s.celdas > 0)) {
    console.log('  ! [MR.9.1] NO MEDIDO: sin mayoreo U-D-8 en 30 dias en esta base; compuertas omitidas.');
  } else {
    // (a) Si casi nada se cubre, el join a la ficha se rompió (sucursal/sku con padding, etc.).
    //     Medido: 99.9 % de la venta neta de mayoreo tiene ficha.
    if (!(Number(s.pct_cubierto) > 95)) {
      throw new Error(`[MR.9.1] la ficha cubre sólo ${s.pct_cubierto}% del mayoreo (medido ~99.9%): el JOIN a kdii se rompió.`);
    }
    // (b) Unidad: si el COGS volviera a multiplicar por c9 (base) en vez de c56 (peldaño), el margen se
    //     hunde a cientos de puntos negativos. Medido: ~10 %. Banda ancha a propósito.
    if (!(Number(s.margen) > -20 && Number(s.margen) < 60)) {
      throw new Error(`[MR.9.1] margen de mayoreo ${s.margen}% fuera de [-20, 60]: sospecha de error de unidad en el COGS.`);
    }
    // (c) Anti-recorte al revés: tope, no piso. Hay venta bajo costo legítima.
    if (!(Number(s.pct_gt) < 10)) {
      throw new Error(`[MR.9.1] ${s.pct_gt}% de renglones con costo > venta (tope 10%): revisar el peldaño.`);
    }
  }

  // ── 2. La matview ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_margin_standard_daily`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_margin_ficha_daily`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW analytics.mv_erp_margin_ficha_daily AS
    ${cuerpo(`h.c9::date >= CURRENT_DATE - 400`)}
    WITH NO DATA`);
  // La llave Kepler de la celda: es por la que se une la vista combinada.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_mv_erp_margin_ficha_daily
        ON analytics.mv_erp_margin_ficha_daily (tenant_id, warehouse_code, sku, sale_date, doctype)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_erp_margin_ficha_daily TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_erp_margin_ficha_daily IS
    $$[MR.9.1] Costo ESTANDAR de la ficha (kdii.c77 x c58 x c56) para los renglones de MAYOREO (U-D-8)
    que NO traen el costo congelado c62. Disjunta de mv_erp_margin_daily por construccion. Es el costo
    de HOY, no el del dia de la venta: medido, difiere del congelado < 0.5 % en pesos dentro de 90 dias.
    Corta la replica cruzada (left(c1,2) = sucursal). No leer sola: leer analytics.v_margin_standard_daily.$$`);

  // ── 3. La vista combinada: el margen contra el costo estándar, por celda ─────────────────
  // El árbitro trae TODA la venta de la celda (venta_neta) y la costeada con c62; esta matview
  // trae la de mayoreo sin c62 costeada con la ficha. Disjuntas → se suman.
  await knex.raw(`
    CREATE VIEW analytics.v_margin_standard_daily
    WITH (security_invoker = true) AS
    SELECT m.tenant_id,
           m.warehouse_id,
           m.warehouse_code,
           m.product_id,
           m.sku,
           m.sale_date,
           m.doctype,
           m.es_ruta,
           m.lineas,
           m.venta_bruta,
           m.venta_neta,
           m.unidades_vendidas,
           m.venta_neta_costeada                                          AS venta_neta_ticket,
           m.cogs_arbitrado                                               AS cogs_ticket,
           f.venta_neta_ficha,
           f.cogs_ficha,
           COALESCE(m.venta_neta_costeada, 0) + COALESCE(f.venta_neta_ficha, 0) AS venta_neta_costeada,
           CASE WHEN m.cogs_arbitrado IS NULL AND f.cogs_ficha IS NULL THEN NULL
                ELSE COALESCE(m.cogs_arbitrado, 0) + COALESCE(f.cogs_ficha, 0) END AS cogs,
           -- Lo que NO tiene costo con qué juzgarse. Se declara, nunca se dibuja como 0 % de margen.
           m.venta_neta - COALESCE(m.venta_neta_costeada, 0) - COALESCE(f.venta_neta_ficha, 0)
                                                                          AS venta_neta_sin_costo,
           CASE
             WHEN COALESCE(m.venta_neta_costeada, 0) = 0 AND COALESCE(f.venta_neta_ficha, 0) = 0 THEN 'sin_costo'
             WHEN COALESCE(f.venta_neta_ficha, 0) = 0 THEN 'ticket'
             WHEN COALESCE(m.venta_neta_costeada, 0) = 0 THEN 'ficha_actual'
             ELSE 'ticket_y_ficha'
           END                                                            AS metodo_costo
      FROM analytics.mv_erp_margin_daily m
      LEFT JOIN analytics.mv_erp_margin_ficha_daily f
        ON f.tenant_id = m.tenant_id AND f.warehouse_code = m.warehouse_code::text
       AND f.sku = m.sku AND f.sale_date = m.sale_date AND f.doctype = m.doctype`);
  await knex.raw(`GRANT SELECT ON analytics.v_margin_standard_daily TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_margin_standard_daily IS
    $$[MR.9.1] EL MARGEN CONTRA EL COSTO ESTANDAR, por almacen x producto x dia x doctype (Kepler).
    Mostrador y rutas: costo que Kepler congela en el renglon (kdm2.c62). Mayoreo (U-D-8): costo
    estandar de la ficha de HOY (kdii.c77), porque c62 viene vacio. metodo_costo lo declara por fila.
    Margen = 1 - cogs / venta_neta_costeada, siempre NETO de IVA/IEPS. venta_neta_sin_costo es NO
    MEDIDO, no 0 %. Wincaja NO esta aqui (ADR-059: se juzga con su propia evidencia).
    Hereda del arbitro la replica cruzada 03<-02 (oct-2025 a ene-2026, ~$8.3 M) en mostrador.$$`);

  console.log('  ✓ [MR.9.1] mv_erp_margin_ficha_daily (WITH NO DATA) + v_margin_standard_daily creadas.');
  console.log('  ! [MR.9.1] FALTA el primer REFRESH — lo hace el nocturno (3.8 s medidos a 400 d).');
};

/** El cuerpo, para que el candado mida el MISMO texto que se materializa. */
exports._cuerpo = cuerpo;

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_margin_standard_daily`);
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_erp_margin_ficha_daily`);
};
