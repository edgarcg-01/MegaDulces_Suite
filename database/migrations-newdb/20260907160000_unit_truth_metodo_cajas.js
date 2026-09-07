/**
 * U.7 — `v_unit_truth` dice también CÓMO sacar las cajas, y en qué orden.
 *
 * ── Por qué el divisor no alcanza ──────────────────────────────────────────────────────────
 * Los 44 consumidores dividen una cantidad por un factor para publicar "cajas". Medido con el
 * árbitro de dinero (`revenue / cja_price`, que no depende de ningún divisor), sobre los 570 SKUs
 * donde las fórmulas privadas y el resolvedor discrepan: `factor_sale` sobra 3.286x, el resolvedor
 * falta 0.369x, y en **296 SKUs ($78.3M) no acierta NINGUNO**. La razón es que en esos SKUs
 * `sales_daily.units` no está en ninguna unidad — mezcla peldaños incluso dentro de un mismo
 * almacén (`42029` en el almacén `01` promedia $71.07/unidad, ni la pieza de $12 ni el paquete de
 * $115). Ningún divisor arregla un numerador que no tiene unidad.
 *
 * ── Pero el resolvedor SÍ es bueno donde dice que lo es ────────────────────────────────────
 * Sobre TODA la población (no el subconjunto adversarial), donde `medible = true` el divisor
 * verificado y el dinero **coinciden**: razón mediana **0.997**, 38,713 de 40,853 celdas dentro de
 * ±25%, $547,152,677 de venta. Con `medible = false` la mediana se corre a 1.036 sobre 760 celdas.
 * O sea la bandera separa bien: no hay que elegir entre los dos testigos, hay que ORDENARLOS.
 *
 * ── El orden, y por qué ese ─────────────────────────────────────────────────────────────────
 *   1. `dinero`   — hay `cja_price > 0`: cajas = ingreso / precio de caja. Va PRIMERO porque es
 *                   inmune a la unidad del numerador, que es justo lo que falla. Cubre el 92.9%
 *                   de la venta (6,142 SKUs).
 *   2. `divisor`  — no hay precio de caja pero el factor está VERIFICADO: cajas = cantidad /
 *                   box_factor. Cubre el 7.1% restante ($45.9M) donde el dinero no llega.
 *   3. `peso`     — producto de peso: la caja no aplica, se muestran kilos.
 *   4. `sin_metodo` — ni precio de caja ni factor verificado. **Se declara NULL, no se dibuja.**
 *
 * ⚠️ `cja_price` es por PRODUCTO, no por almacén, y viene de `analytics.product_box_price`
 * (alimentada por `ods-derived.js` desde kdpv). Cuando su `source` es el fallback PAQ x factor_sale
 * arrastra la ambigüedad de `factor_sale`, así que se expone `cja_price_source` para que el lector
 * pueda exigir el precio de lista y no el derivado.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  // Hay que soltar la vista de cobertura: depende de v_unit_truth y DROP la arrastraría.
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth_coverage');
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth');

  await knex.raw(`
    CREATE VIEW analytics.v_unit_truth AS
    WITH pago AS (
      SELECT sku, max(units_per_box)::numeric AS upb
        FROM analytics.v_supplier_cost_ladder
       WHERE units_per_box > 0
       GROUP BY sku
    ), base AS (
      SELECT w.tenant_id, w.warehouse_id, w.warehouse_code, w.product_id, w.sku,
             w.box_factor AS box_factor,
             w.factor_source, w.erp, w.base_label, w.box_label,
             w.is_weight, w.is_master_suspect,
             b.box_factor AS base_per_box,
             b.source     AS base_source,
             b.factor_unit, b.unit_base,
             lad.f2, lad.f3,
             pago.upb     AS testigo_pago,
             lad.f3       AS testigo_erp,
             bp.cja_price::numeric AS cja_price,
             bp.source    AS cja_price_source
        FROM analytics.v_warehouse_box_factor w
        JOIN analytics.v_product_box_factor  b
          ON b.tenant_id = w.tenant_id AND b.product_id = w.product_id
        LEFT JOIN analytics.v_product_unit_ladder lad ON lad.sku = w.sku
        LEFT JOIN pago                                ON pago.sku = w.sku
        LEFT JOIN analytics.product_box_price bp
               ON bp.tenant_id = w.tenant_id AND bp.product_id = w.product_id
    ), juzgado AS (
      SELECT base.*,
             CASE WHEN testigo_pago > 0 THEN base_per_box / testigo_pago END AS razon_pago,
             CASE WHEN testigo_erp  > 0 THEN base_per_box / testigo_erp  END AS razon_erp,
             CASE WHEN box_factor   > 0 THEN base_per_box / box_factor   END AS nativo_a_base,
             (COALESCE(testigo_pago, 0) > 1.05 OR COALESCE(testigo_erp, 0) > 1.05) AS testigo_ve_caja
        FROM base
    ), fallado AS (
      SELECT j.*,
             CASE
               WHEN j.base_per_box <= 1 AND j.testigo_ve_caja AND j.is_weight
                                                                     THEN 'disputa_granel'
               WHEN j.base_per_box <= 1 AND j.testigo_ve_caja         THEN 'en_disputa'
               WHEN j.base_per_box <= 1                               THEN 'no_aplica'
               WHEN j.testigo_pago IS NULL AND j.testigo_erp IS NULL   THEN 'sin_testigo'
               WHEN (j.razon_pago IS NOT NULL AND abs(j.razon_pago - 1) <= 0.05)
                 OR (j.razon_erp  IS NOT NULL AND abs(j.razon_erp  - 1) <= 0.05)
                                                                      THEN 'verificado'
               WHEN j.is_weight                                        THEN 'disputa_granel'
               ELSE                                                         'en_disputa'
             END AS veredicto
        FROM juzgado j
    )
    SELECT f.tenant_id, f.warehouse_id, f.warehouse_code, f.product_id, f.sku,
           f.box_factor, f.base_per_box,
           f.factor_source, f.base_source, f.erp,
           f.base_label, f.box_label, f.unit_base, f.factor_unit,
           f.is_weight, f.is_master_suspect,
           f.f2, f.f3, f.testigo_pago, f.testigo_erp,
           round(f.razon_pago, 4)    AS razon_pago,
           round(f.razon_erp,  4)    AS razon_erp,
           round(f.nativo_a_base, 4) AS nativo_a_base,
           f.veredicto,
           CASE
             WHEN f.erp = 'kepler'                                   THEN 'nativo_es_base'
             WHEN f.nativo_a_base IS NULL                            THEN 'sin_razon'
             WHEN abs(f.nativo_a_base - 1) < 0.01                    THEN 'vende_la_base'
             WHEN f.f2 > 1 AND abs(f.nativo_a_base - f.f2) < 0.01     THEN 'vende_paquete'
             ELSE                                                         'no_explicado'
           END AS veredicto_nativo,
           (f.veredicto IN ('verificado', 'no_aplica')) AS medible,

           -- ── U.7: como sacar las CAJAS, en orden de confianza ──
           f.cja_price,
           f.cja_price_source,
           CASE
             -- El dinero primero: es inmune a la unidad del numerador, que es lo que falla.
             WHEN f.cja_price > 0                                    THEN 'dinero'
             -- En granel la caja no aplica: se muestran kilos.
             WHEN f.is_weight                                        THEN 'peso'
             -- Sin precio de caja, sirve el divisor SOLO si esta verificado.
             WHEN f.veredicto = 'verificado' AND f.box_factor > 1     THEN 'divisor'
             ELSE                                                         'sin_metodo'
           END AS metodo_cajas
      FROM fallado f
  `);

  await knex.raw('ALTER VIEW analytics.v_unit_truth SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth IS
    'U.4/U.7 - El resolvedor de unidad con veredicto Y metodo, grano (tenant, almacen, producto). box_factor es el divisor NATIVO de ese almacen (identico a v_warehouse_box_factor, ADR-055); base_per_box son unidades BASE por caja. El veredicto contrasta base_per_box contra DOS testigos independientes: lo PAGADO al proveedor (v_supplier_cost_ladder.units_per_box) y la escalera del ERP (kdii.c84). Medido 2026-09-05: la etiquetera coincide con lo pagado en 5,569 de 5,578 SKUs (99.84%, razon mediana 1.00) - o sea SI tiene testigo, contra lo que afirmaba la doc. metodo_cajas ORDENA los testigos en vez de elegir uno: dinero (revenue/cja_price, inmune a la unidad del numerador, 92.9% de la venta) > peso (la caja no aplica) > divisor (solo si el factor esta verificado; donde medible=true el divisor y el dinero coinciden con razon mediana 0.997 sobre $547M) > sin_metodo (se declara NULL, NO se dibuja). REGLA DURA: antes de multiplicar o dividir, leer metodo_cajas y medible; con sin_metodo o medible=false el numero va NULL con motivo, NUNCA 0. Ver ADR-057 y docs/UNIDADES_DE_MEDIDA.md.'`);

  // Se reconstruye la vista de cobertura tal cual la dejo la mig 20260907150000.
  await knex.raw(`
    CREATE VIEW analytics.v_unit_truth_coverage AS
    WITH vta AS (
      SELECT s.tenant_id, s.warehouse_id,
             sum(s.revenue)::numeric                                       AS venta_365d,
             count(*) FILTER (WHERE s.channel LIKE 'wincaja%')::int        AS filas_wincaja,
             count(*) FILTER (WHERE s.channel NOT LIKE 'wincaja%')::int    AS filas_kepler,
             max(s.sale_date) FILTER (WHERE s.channel LIKE 'wincaja%')     AS ult_wincaja,
             max(s.sale_date) FILTER (WHERE s.channel NOT LIKE 'wincaja%') AS ult_kepler,
             max(s.sale_date)                                              AS ult_venta
        FROM analytics.sales_daily s
       WHERE s.sale_date >= current_date - 365
       GROUP BY 1, 2
    ), cel AS (
      SELECT tenant_id, warehouse_id,
             count(*)::int                        AS celdas,
             count(*) FILTER (WHERE medible)::int  AS celdas_medibles
        FROM analytics.v_unit_truth
       GROUP BY 1, 2
    )
    SELECT w.tenant_id, w.id AS warehouse_id, w.code AS warehouse_code,
           w.name AS warehouse_name, w.kind, w.kepler_code, w.wincaja_source_branch,
           COALESCE(v.venta_365d, 0) AS venta_365d,
           v.ult_venta, v.ult_wincaja, v.ult_kepler,
           COALESCE(c.celdas, 0) AS celdas,
           COALESCE(c.celdas_medibles, 0) AS celdas_medibles,
           (c.celdas IS NOT NULL AND c.celdas > 0) AS cubierto,
           (COALESCE(v.filas_wincaja, 0) > 0 AND COALESCE(v.filas_kepler, 0) > 0) AS cambio_de_erp,
           CASE
             WHEN w.kepler_code IS NOT NULL           THEN 'kepler'
             WHEN w.wincaja_source_branch IS NOT NULL THEN 'wincaja'
             WHEN COALESCE(v.filas_wincaja, 0) > 0
              AND COALESCE(v.filas_kepler, 0)  > 0    THEN 'erp_mixto_por_fecha'
             ELSE                                          'sin_mapeo_erp'
           END AS motivo
      FROM commercial.warehouses w
      LEFT JOIN vta v ON v.tenant_id = w.tenant_id AND v.warehouse_id = w.id
      LEFT JOIN cel c ON c.tenant_id = w.tenant_id AND c.warehouse_id = w.id
     WHERE w.deleted_at IS NULL
  `);
  await knex.raw('ALTER VIEW analytics.v_unit_truth_coverage SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth_coverage TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth_coverage IS
    'U.6b - Declara que almacenes cubre analytics.v_unit_truth y cuales NO, con el motivo. Existe porque una fila AUSENTE se lee peor que una fila mala: en un LEFT JOIN llega NULL y un COALESCE(medible, true) la cuenta como medible. motivo responde UNA pregunta -- que resuelve el divisor -- con la cobertura primero; el cambio de ERP viaja aparte en cambio_de_erp. motivo = erp_mixto_por_fecha son las 6 rutas de La Piedad: Wincaja hasta 2026-06-26 y Kepler desde 2026-06-29, sin solape.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth_coverage');
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth');
};
