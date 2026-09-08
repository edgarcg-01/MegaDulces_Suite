/**
 * K.1 fix — el PRECIO no puede votar. El árbitro es el COSTO, y la medición lo prueba.
 *
 * ── Qué salió mal en la mig 20260908120000 (mía, de hace minutos) ─────────────────────────
 * Puse los tres testigos a votar en la columna `certeza`. Resultado: `en_conflicto` cargaba
 * **$21,643,214** — un tercio del dinero de 90 días. Medí de dónde salía ese conflicto y **casi
 * todo lo generaba el PRECIO**:
 *
 *     quien contradice al factor declarado    renglones      importe    medianas (decl/costo/precio)
 *     solo el PRECIO                             50,447   $19,456,690      12.00 / 10.00 / 1.00
 *     LOS DOS                                     8,812    $2,143,820      10.00 / 13.00 / 1.00
 *     solo el COSTO                                 288       $42,704
 *
 * El precio dice "factor 1" cuando el renglón declara 12 y el costo dice 10. No es un conflicto de
 * unidad: es **descuento**. Y se ve por doctype:
 *
 *     U-D-10 Ticket             certero 91.9%   ·  en conflicto  7.3%
 *     U-D-8  Telemarketing      certero  0.6%   ·  en conflicto 56.9%  ($11,913,223)
 *     U-D-12 No fiscal          certero 76.9%   ·  en conflicto 22.3%
 *
 * `U-D-8` descuenta tanto que el precio cae al peldaño base casi siempre. Un testigo que se
 * equivoca en el 56.9% de un doctype entero no es un testigo: es ruido con voto.
 *
 * ── El costo SOLO, que es lo que Edgar propuso ────────────────────────────────────────────
 *
 *     el costo CONFIRMA el factor declarado    673,468 renglones   $44,954,578
 *     el costo no alcanza (sin escalera)        20,520
 *     el costo CONTRADICE                        9,100 renglones    $2,186,524
 *
 * **98.67% de confirmación** sobre los 682,568 renglones donde el costo puede hablar. Y la regla
 * de fondo, medida aparte: `c62 = u1_cost x c58` en **98.36%** de 674,182 renglones, mediana
 * **exactamente 1.0000**, parejo en las 6 sucursales (98.23%-99.00%).
 *
 * Ancla independiente al grano de catálogo: `kdik.c16` (el costo unitario propio de Kepler) contra
 * la misma escalera pagada da mediana **1.0000 en las SIETE sucursales** (86.3-98.0%).
 *
 * ── El veredicto nuevo ───────────────────────────────────────────────────────────────────
 *
 *     confirmado    el costo de Kepler confirma el factor que el renglón declara
 *     contradicho   el costo dice OTRO factor -> bandeja real, con los dos valores visibles
 *     sin_costo     el SKU no tiene escalera pagada -> se publica el declarado, marcado
 *     sin_factor    el renglón no declara nada (ni por c58 ni por precio de su propia unidad)
 *
 * `factor_por_precio` **se conserva como columna informativa** — sirve para explicar un renglón y
 * para detectar descuentos — pero NO vota. La medición de arriba queda escrita acá para que nadie
 * lo vuelva a meter al veredicto sin volver a medirlo.
 *
 * ⚠️ `CREATE OR REPLACE` no puede cambiar el TIPO ni el orden de las columnas existentes, y
 * `certeza` ya existe con los valores viejos. Los valores nuevos son otros strings del mismo tipo
 * (text), así que el reemplazo es válido: cambia el contenido, no la forma.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const NUMN = (col, dec) => `round(nullif(regexp_replace(${col}::text,'[^0-9.-]','','g'),'')::numeric,${dec})`;

exports.up = async function up(knex) {
  if (!(await knex.raw(`SELECT to_regclass('analytics.v_erp_sales_line_units') AS v`)).rows[0]?.v) {
    console.log('  [K.1 fix] la vista no existe — no-op.');
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
    tst AS (
      SELECT r.*,
             -- ⭐ EL ARBITRO: c62 / u1_cost tiene que dar el factor del renglon.
             CASE WHEN sc.u1_cost > 0 AND r.costo_linea > 0
                   AND (r.costo_linea / sc.u1_cost) >= 0.85
                   AND abs((r.costo_linea / sc.u1_cost)
                           - round(r.costo_linea / sc.u1_cost))
                       <= 0.15 * GREATEST(round(r.costo_linea / sc.u1_cost), 1)
                  THEN GREATEST(round(r.costo_linea / sc.u1_cost), 1)
             END                                      AS factor_por_costo,
             -- INFORMATIVO, NO VOTA: el precio se descuenta y en U-D-8 cae al peldano base en el
             -- 56.9% de los renglones. Sirve para explicar y para detectar descuento, no para juzgar.
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
      t.costo_linea,
      t.costo_base_pagado,
      t.factor_por_costo,
      t.factor_por_precio,
      -- ⭐ EL VEREDICTO: solo el COSTO arbitra. El precio no vota (ver header).
      CASE
        WHEN t.factor_resuelto  IS NULL                             THEN 'sin_factor'
        WHEN t.factor_por_costo IS NULL                             THEN 'sin_costo'
        WHEN t.factor_por_costo = t.factor_resuelto                 THEN 'confirmado'
        ELSE                                                             'contradicho'
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
    'K.1 - El renglon de venta de Kepler con su unidad CONFIRMADA POR EL COSTO de Kepler. Regla: c62 = u1_cost x c58 (98.36% de 674,182 renglones, mediana EXACTAMENTE 1.0000, parejo en las 6 sucursales). certeza = confirmado / contradicho / sin_costo / sin_factor. El PRECIO viaja en factor_por_precio pero NO VOTA: se descuenta, y en U-D-8 Telemarketing cae al peldano base en 56.9% de los renglones -- meterlo al veredicto fabricaba $19.5M de conflicto falso. Todo es Kepler contra Kepler.'`);

  const t0 = Date.now();
  const v = (await knex.raw(`
    SELECT certeza, count(*)::int n, round(sum(importe)::numeric,0) imp
      FROM analytics.v_erp_sales_line_units
     WHERE tenant_id = '${M}'::uuid AND fecha > current_date - 90
     GROUP BY 1 ORDER BY n DESC`)).rows;
  const total = v.reduce((s, r) => s + r.n, 0);
  console.log(`  (${Date.now() - t0} ms sobre 90 dias)`);
  for (const r of v) {
    console.log(`  ${String(r.certeza).padEnd(13)} ${String(r.n).padStart(8)} (${(100 * r.n / total).toFixed(2)}%)`
      + `  $${Number(r.imp || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  }
  const conf = v.find((r) => r.certeza === 'confirmado');
  const contra = v.find((r) => r.certeza === 'contradicho');
  if (!conf || (100 * conf.n / total) < 90) {
    throw new Error(`confirmado ${conf ? (100 * conf.n / total).toFixed(2) : 0}%, se midio ~96%`);
  }
  // Si el costo nunca contradijera, no seria un arbitro: seria un espejo del declarado.
  if (!contra || contra.n === 0) throw new Error('contradicho = 0: el costo no esta arbitrando nada');
};

exports.down = async function down() {
  // No-op: volver a meter el precio al veredicto fabrica $19.5M de conflicto falso.
};
