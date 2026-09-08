/**
 * K.0/K.1 — La verdad absoluta de la unidad en Kepler: TRES testigos de Kepler que se confirman.
 *
 * ── Por qué el costo y no el precio ───────────────────────────────────────────────────────
 * Edgar: *"también puede ser contra el costo unitario. necesito que tengamos una verdad absoluta"*.
 * Tenía razón, y la razón es estructural: **el precio tiene niveles, descuentos y promociones; el
 * costo no.** `wincaja.precios` llega a tener 6 niveles poblados por artículo; `kdii` tiene tres
 * precios de peldaño que el cajero puede pisar. El costo pagado al proveedor no se negocia por
 * ticket.
 *
 * ⚠️ Y todo acá es **Kepler contra Kepler**. La regla de no mezclar sistemas la violé dos veces en
 * esta fase (la última, juzgando el `costo_promedio` de Wincaja contra `v_supplier_cost_ladder`,
 * que sale de `kepler_ods.kdpv_prov_prod`). `v_supplier_cost_ladder` y `v_product_unit_ladder` SÍ
 * son legítimas acá: las dos derivan de `kepler_ods`. Lo que sigue prohibido es la etiquetera
 * (`product_label_prices`), `factor_sale` y cualquier cosa de `wincaja.*`.
 *
 * ── Los tres testigos, medidos contra prod (90 d, sucursales 01-06) ───────────────────────
 *
 *  1. **DECLARADO** — `c55/c56/c57/c58`: el renglón trae su propia conversión.
 *     `c9 = c56 x c58` en **99.99%** de 899,646 renglones.
 *
 *  2. **COSTO** — `c62` contra lo que Kepler le pagó al proveedor (`kdpv_prov_prod`):
 *
 *         c62 = u1_cost x c58   ->   98.36% de 674,182 renglones, mediana EXACTAMENTE 1.0000
 *
 *     Y es parejo: suc 01 98.23% · 02 98.37% · 03 98.36% · 04 98.28% · 05 98.38% · 06 99.00% ·
 *     U-D-12 98.90%. Los 11,059 que no cuadran valen $843,129 en 90 d (8,544 con costo MAYOR,
 *     mediana 1.306 — actualizaciones de costo; 2,515 con costo menor, 0.825).
 *     Ancla independiente del renglón: `kdik.c16` (el costo unitario del catálogo de Kepler)
 *     contra la misma escalera da mediana **1.0000 en las SIETE sucursales**, 86.3–98.0%.
 *
 *  3. **PRECIO** — `c12` contra los tres precios de peldaño de `kdii` (`c90/c91/c92`), sólo
 *     dentro de la banda 0.5x-2x que `route-promo.service.ts:212` ya usa. Fuera de banda NULL:
 *     no se adivina. (El importer del fact es el único lugar del repo sin esa banda — eso se
 *     corrige en K.5, no acá.)
 *
 *     Cruzados: los tres de acuerdo en **90.7%** de 646,283 renglones.
 *
 * ── Qué se publica ───────────────────────────────────────────────────────────────────────
 * `certeza` dice CUÁNTA evidencia sostiene el factor, y `factor_resuelto` sigue siendo el del
 * renglón — el costo y el precio **confirman o contradicen**, no reemplazan:
 *
 *     certero        los testigos disponibles (>=2) dan el MISMO factor
 *     dos_de_tres    2 coinciden y el tercero no existe (no contradice)
 *     en_conflicto   2+ testigos dan factores DISTINTOS -> se ven los tres, no se elige
 *     sin_testigo    solo el declarado, sin costo ni precio con que cruzarlo
 *
 * ⛔ `en_conflicto` NO inventa un ganador. Los tres valores viajan en la fila para que el conflicto
 * se resuelva mirando (ADR-056: lo que no se pudo medir se declara).
 *
 * ⚠️ `CREATE OR REPLACE` sólo agrega columnas AL FINAL — el orden de las que ya estaban no cambia,
 * así que los consumidores no se enteran. Y se re-aplican `security_invoker` y el `GRANT`, que no
 * se heredan (lección U.7).
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS (9na vez).
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const NUMN = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

exports.up = async function up(knex) {
  const ok = (await knex.raw(`
    SELECT (to_regclass('analytics.v_erp_sales_line_units') IS NOT NULL
        AND to_regclass('analytics.v_supplier_cost_ladder') IS NOT NULL
        AND to_regclass('analytics.v_product_unit_ladder')  IS NOT NULL) AS ok`)).rows[0];
  if (!ok?.ok) {
    console.log('  [K.0] faltan la vista de renglon o las escaleras de Kepler — no-op.');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_sales_line_units AS
    WITH src AS (
      SELECT
        l.sucursal::text                              AS sucursal,
        btrim(l.c1::text)                             AS almacen_erp,
        btrim(l.c2::text)||'-'||btrim(l.c3::text)||'-'||btrim(l.c4::text) AS doctype,
        btrim(l.c6::text)                             AS folio,
        btrim(l.c7::text)                             AS linea,
        l.c32::date                                   AS fecha,
        NULLIF(btrim(l.c8::text),'')                  AS sku,
        NULLIF(btrim(l.c10::text),'')                 AS nombre,
        NULLIF(btrim(l.c11::text),'')                 AS unidad_base,
        ${NUMN('l.c9', 4)}                            AS cantidad_base,
        ${NUMN('l.c12', 6)}                           AS precio_base,
        ${NUMN('l.c13', 2)}                           AS importe,
        NULLIF(btrim(l.c55::text),'')                 AS unidad_vendida,
        ${NUMN('l.c56', 4)}                           AS cantidad_vendida,
        ${NUMN('l.c57', 6)}                           AS precio_vendido,
        ${NUMN('l.c58', 4)}                           AS factor_declarado,
        -- Testigo 2: el costo del renglon, en la unidad del renglon.
        ${NUMN('l.c62', 6)}                           AS costo_linea
      FROM kepler_ods.kdm2 l
      WHERE l.c2 = 'U' AND l.c3 = 'D'
        AND btrim(l.c4::text) IN ('8', '10', '12')
        AND (btrim(l.c1::text) = l.sucursal::text
             OR btrim(l.c1::text) LIKE l.sucursal::text || '-%')
        AND l.c32 > '1900-01-01'::timestamp
    ),
    res AS (
      SELECT s.*,
             CASE btrim(s.almacen_erp)
               WHEN '01-001' THEN 'RUTA-21' WHEN '01-002' THEN 'RUTA-22'
               WHEN '01-003' THEN 'RUTA-23' WHEN '01-004' THEN 'RUTA-26'
               WHEN '01-005' THEN 'RUTA-27' WHEN '01-006' THEN 'RUTA-28'
               ELSE s.sucursal END                    AS warehouse_code,
             CASE
               WHEN s.factor_declarado > 0                          THEN s.factor_declarado
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida = s.unidad_base                THEN 1::numeric
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida <> s.unidad_base
                AND s.precio_base > 0 AND s.precio_vendido > 0
                AND (s.precio_vendido / s.precio_base) >= 1
                AND abs((s.precio_vendido / s.precio_base)
                        - round(s.precio_vendido / s.precio_base)) <= 0.01
                                                                    THEN round(s.precio_vendido / s.precio_base)
             END                                      AS factor_resuelto,
             CASE
               WHEN s.factor_declarado > 0                          THEN 'linea_c58'
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida = s.unidad_base                THEN 'linea_base'
               WHEN s.unidad_vendida IS NOT NULL
                AND s.unidad_vendida <> s.unidad_base
                AND s.precio_base > 0 AND s.precio_vendido > 0
                AND (s.precio_vendido / s.precio_base) >= 1
                AND abs((s.precio_vendido / s.precio_base)
                        - round(s.precio_vendido / s.precio_base)) <= 0.01
                                                                    THEN 'linea_precio'
               ELSE                                                      'sin_declarar'
             END                                      AS factor_source
        FROM src s
    ),
    -- Testigo 2 y 3 resueltos a FACTOR, para poder cruzarlos con el declarado.
    tst AS (
      SELECT r.*,
             -- COSTO: c62 / u1_cost tiene que dar el factor. Se exige que caiga a menos del 15%
             -- de un entero >= 1; si no, NULL (el costo no alcanza para decidir).
             CASE WHEN sc.u1_cost > 0 AND r.costo_linea > 0
                   AND (r.costo_linea / sc.u1_cost) >= 0.85
                   AND abs((r.costo_linea / sc.u1_cost)
                           - round(r.costo_linea / sc.u1_cost))
                       <= 0.15 * GREATEST(round(r.costo_linea / sc.u1_cost), 1)
                  THEN GREATEST(round(r.costo_linea / sc.u1_cost), 1)
             END                                      AS factor_por_costo,
             -- PRECIO: el peldano de kdii cuyo precio esta mas cerca de c12, SOLO dentro de la
             -- banda 0.5x-2x. Fuera de banda no se adivina.
             CASE
               WHEN pl.p3 > 0 AND r.precio_base > 0 AND pl.f3 > 0
                AND abs(ln(r.precio_base / pl.p3)) <= ln(2)
                AND abs(ln(r.precio_base / pl.p3)) <= COALESCE(abs(ln(r.precio_base / NULLIF(pl.p2,0))), 99)
                AND abs(ln(r.precio_base / pl.p3)) <= COALESCE(abs(ln(r.precio_base / NULLIF(pl.p1,0))), 99)
                                                                    THEN pl.f3
               WHEN pl.p2 > 0 AND r.precio_base > 0 AND pl.f2 > 0
                AND abs(ln(r.precio_base / pl.p2)) <= ln(2)
                AND abs(ln(r.precio_base / pl.p2)) <= COALESCE(abs(ln(r.precio_base / NULLIF(pl.p1,0))), 99)
                                                                    THEN pl.f2
               WHEN pl.p1 > 0 AND r.precio_base > 0
                AND abs(ln(r.precio_base / pl.p1)) <= ln(2)         THEN 1::numeric
             END                                      AS factor_por_precio,
             sc.u1_cost                               AS costo_base_pagado
        FROM res r
        LEFT JOIN analytics.v_supplier_cost_ladder sc ON sc.sku = r.sku
        LEFT JOIN analytics.v_product_unit_ladder  pl ON pl.sku = r.sku
    )
    SELECT
      w.tenant_id, t.sucursal, t.almacen_erp, t.warehouse_code, w.id AS warehouse_id,
      t.doctype, t.folio, t.linea, t.fecha, t.sku, p.id AS product_id, t.nombre,
      t.unidad_base, t.cantidad_base, t.precio_base, t.importe,
      t.unidad_vendida, t.cantidad_vendida, t.precio_vendido, t.factor_declarado,
      t.factor_resuelto, t.factor_source,
      (t.factor_declarado > 0 AND t.cantidad_vendida IS NOT NULL
        AND abs(t.cantidad_base - t.cantidad_vendida * t.factor_declarado) <= 0.001) AS cuadra,
      -- ── K.0: los dos testigos nuevos, los dos de Kepler ──────────────────────────────────
      t.costo_linea,
      t.costo_base_pagado,
      t.factor_por_costo,
      t.factor_por_precio,
      -- ── K.1: CUANTA evidencia sostiene el factor. No elige: describe. ────────────────────
      CASE
        WHEN t.factor_resuelto IS NULL                              THEN 'sin_factor'
        -- Conflicto: algun testigo presente contradice al declarado.
        WHEN (t.factor_por_costo  IS NOT NULL AND t.factor_por_costo  <> t.factor_resuelto)
          OR (t.factor_por_precio IS NOT NULL AND t.factor_por_precio <> t.factor_resuelto)
                                                                    THEN 'en_conflicto'
        WHEN t.factor_por_costo IS NOT NULL AND t.factor_por_precio IS NOT NULL
                                                                    THEN 'certero'
        WHEN t.factor_por_costo IS NOT NULL OR  t.factor_por_precio IS NOT NULL
                                                                    THEN 'dos_de_tres'
        ELSE                                                             'sin_testigo'
      END                                             AS certeza
      FROM tst t
      JOIN commercial.warehouses w
        ON w.code = t.warehouse_code AND w.deleted_at IS NULL
      LEFT JOIN catalog.products p
        ON p.tenant_id = w.tenant_id AND p.sku = t.sku AND p.deleted_at IS NULL
  `);

  await knex.raw('ALTER VIEW analytics.v_erp_sales_line_units SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_erp_sales_line_units TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_erp_sales_line_units IS
    'K.0/K.1 - El renglon de venta de Kepler con TRES testigos de KEPLER que confirman su unidad: el DECLARADO (c55/c56/c57/c58, invariante c9=c56xc58 al 99.99%), el COSTO (c62 = u1_cost x c58 al 98.36%, mediana 1.0000, parejo en las 6 sucursales) y el PRECIO (c12 contra c90/c91/c92 dentro de banda 0.5x-2x). certeza dice cuanta evidencia sostiene el factor; en_conflicto NO elige ganador, deja los tres valores visibles. Doctypes 8/10/12 = el mismo corte que mv_kepler_sales_daily. TODO es Kepler contra Kepler: la etiquetera y wincaja.* siguen prohibidas.'`);

  const t0 = Date.now();
  const v = (await knex.raw(`
    SELECT certeza, count(*)::int n, round(sum(importe)::numeric,0) imp
      FROM analytics.v_erp_sales_line_units
     WHERE tenant_id = '${M}'::uuid AND fecha > current_date - 90
     GROUP BY 1 ORDER BY n DESC`)).rows;
  const total = v.reduce((s, r) => s + r.n, 0);
  console.log(`  (la vista responde en ${Date.now() - t0} ms sobre 90 dias)`);
  for (const r of v) {
    console.log(`  ${String(r.certeza).padEnd(14)} ${String(r.n).padStart(8)} (${(100 * r.n / total).toFixed(2)}%)`
      + `  $${Number(r.imp || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }

  const cert = v.find((r) => r.certeza === 'certero');
  const conf = v.find((r) => r.certeza === 'en_conflicto');
  // Si TODO fuera certero, algun testigo esta copiando a otro y la certeza no vale nada.
  if (!cert || cert.n === 0) throw new Error('no hay ningun renglon certero: los testigos no se cruzan');
  if (cert.n === total) throw new Error('TODO es certero: algun testigo esta copiando a otro');
  if (!conf || conf.n === 0) throw new Error('en_conflicto = 0: el cruce no esta detectando nada');
};

exports.down = async function down() {
  // No-op: quitar los testigos dejaria el factor sin nada que lo confirme.
};
