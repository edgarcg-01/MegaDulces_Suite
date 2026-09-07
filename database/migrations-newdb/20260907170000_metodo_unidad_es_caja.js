/**
 * U.7 fix — "no hay factor de caja" NO es lo mismo que "no sé convertir a cajas".
 *
 * ── El defecto, atrapado antes de publicarse ───────────────────────────────────────────────
 * `metodo_cajas` mandaba a `sin_metodo` todo lo que tuviera `veredicto = 'no_aplica'`, o sea
 * factor 1 **sin ningún testigo que lo contradiga**. Medido sobre el sell-out de 90 días, eso
 * habría bajado el total publicado de **602,049 a 399,494 cajas (−33.6%)**, y el 95% de esa caída
 * eran justamente los `no_aplica` (192,608 de 202,555 unidades).
 *
 * Pero `no_aplica` no significa ignorancia: significa que **la unidad de venta ES la unidad más
 * grande**. Verificado contra la escalera de precio del ODS, que es el árbitro:
 *
 *   · 240 de 278 SKUs ($4,668,979 · 193,970 unidades) cobran dentro de banda de `p1` — el precio
 *     de la unidad BASE — y su escalera **no tiene `f2` ni `f3`**: no hay paquete ni caja.
 *   · Los nombres lo dicen solos: `57009 COBERTURA 20K LUSSEL CUBETA` a $1,453.25 contra p1
 *     $1,500.08 (la unidad es la cubeta de 20 kg) · `87234 BOT SABRISURTIDO / 35` a $296.43
 *     contra p1 $313.49 con `unit_base = CJA` (**la unidad es la caja**) · `70187 LA ROSA JAPONES
 *     20KG GRANEL` a $1,130.37 contra $1,224.78 (el costal).
 *   · Sólo 4 SKUs ($680) quedan fuera de banda y 34 ($40,767) sin escalera con qué opinar.
 *
 * Para esos productos `cajas = unidades` es la respuesta CORRECTA, no un default disfrazado.
 * Tratarlos como "sin método" habría cambiado una cifra buena por un hueco — el error simétrico
 * al que esta fase persigue, y de los caros: −33.6% en el número que se mira todos los días.
 *
 * ── El fix ─────────────────────────────────────────────────────────────────────────────────
 * Método nuevo `unidad_es_caja` entre `divisor` y `sin_metodo`. Exige `box_factor <= 1` además de
 * `veredicto = 'no_aplica'`: si el almacén declara un divisor nativo > 1 (Wincaja vendiendo
 * paquete de un producto cuya base no tiene caja), manda el divisor, no esta rama.
 *
 * `sin_metodo` queda para lo que de verdad no se sabe: `en_disputa` (57 SKUs, un testigo lo
 * contradice) y `sin_testigo` (680 SKUs con factor > 1 y nada que lo respalde). Eso sí se declara.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_unit_truth AS
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
           f.cja_price,
           f.cja_price_source,
           CASE
             -- El dinero primero: inmune a la unidad del numerador, que es lo que falla.
             WHEN f.cja_price > 0                                    THEN 'dinero'
             -- Granel: la cantidad YA esta en kilos.
             WHEN f.is_weight                                        THEN 'peso'
             -- Divisor verificado antes que la rama de abajo: si el almacen declara un divisor
             -- nativo real, manda el divisor.
             WHEN f.veredicto = 'verificado' AND f.box_factor > 1     THEN 'divisor'
             -- ⭐ La unidad de venta ES la unidad mas grande: no hay paquete ni caja en la
             -- escalera y ningun testigo dice que la haya, asi que cajas = unidades. NO es un
             -- default: verificado contra el precio realizado en 240 de 278 SKUs.
             WHEN f.veredicto = 'no_aplica' AND f.box_factor <= 1     THEN 'unidad_es_caja'
             ELSE                                                         'sin_metodo'
           END AS metodo_cajas
      FROM fallado f
  `);

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth IS
    'U.4/U.7 - El resolvedor de unidad con veredicto Y metodo, grano (tenant, almacen, producto). box_factor es el divisor NATIVO de ese almacen (ADR-055); base_per_box son unidades BASE por caja. El veredicto contrasta base_per_box contra DOS testigos independientes: lo PAGADO al proveedor (v_supplier_cost_ladder.units_per_box) y la escalera del ERP (kdii.c84); la etiquetera coincide con lo pagado en 5,569 de 5,578 SKUs (99.84%). metodo_cajas ORDENA los testigos: dinero (revenue/cja_price, inmune a la unidad del numerador, 92.9% de la venta) > peso (la caja no aplica) > divisor (solo con el factor verificado; donde medible=true coincide con el dinero, razon mediana 0.997 sobre $547M) > unidad_es_caja (no hay paquete ni caja en la escalera y ningun testigo dice que la haya: cajas = unidades, verificado contra el precio realizado en 240 de 278 SKUs -- 57009 CUBETA 20K a $1,453 vs p1 $1,500, 87234 con unit_base CJA) > sin_metodo (se declara NULL, NO se dibuja). REGLA DURA: leer metodo_cajas y medible antes de convertir; con sin_metodo el numero va NULL con motivo, NUNCA 0. Ver ADR-057 y docs/UNIDADES_DE_MEDIDA.md.'`);
};

exports.down = async function down(knex) {
  // Volver a la version sin `unidad_es_caja` exigiria reescribir la vista entera; como el cambio
  // solo AGREGA un valor al CASE (no cambia columnas), el down es no-op deliberado: revertirlo
  // reintroduciria la caida del 33.6% en el total de cajas.
};
