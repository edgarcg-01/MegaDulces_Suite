/**
 * U.4 — `analytics.v_unit_truth`: EL resolvedor de unidad, con veredicto.
 *
 * ── Por que existe ──────────────────────────────────────────────────────────────────────────
 * Ocho fuentes reclaman saber cuantas unidades hace una caja, cuatro vistas resuelven entre
 * ellas con precedencias distintas, y **44 archivos** vuelven a resolver por su cuenta leyendo
 * catalog.products.factor_sale (27) o commercial.product_label_prices.box_size (17). Un solo
 * archivo lee la escalera anclada al ERP. Esa es la capa logica que venia fallando: la unidad no
 * se resuelve UNA vez, se re-deriva en cada piso.
 *
 * Esta vista NO reimplementa la precedencia — la LEE de v_warehouse_box_factor (ADR-055) y de
 * v_product_box_factor (UM.1). Lo que agrega es lo que faltaba: **el testigo y el veredicto**.
 * El numero sale identico al que se publica hoy; lo nuevo es saber si se le puede creer.
 *
 * ── El testigo que nadie habia buscado ──────────────────────────────────────────────────────
 * docs/UNIDADES_DE_MEDIDA.md marcaba la etiquetera con "no se puede verificar" y concluia que el
 * 40% de la venta no tenia contra que contrastarse. Existe un segundo testigo INDEPENDIENTE:
 * analytics.v_supplier_cost_ladder.units_per_box = box_cost / u1_cost, derivado de
 * kepler_ods.kdpv_prov_prod, o sea **lo que se le pago al proveedor**. No toca la etiquetera ni
 * el catalogo: es dinero contra etiqueta.
 *
 * Medido en prod 2026-09-05, contrastando las dos:
 *
 *   fuente          SKUs    con testigo   coincide          contradice   venta que contradice
 *   -------------   -----   -----------   ---------------   ----------   --------------------
 *   etiquetera      5,679   5,578         5,569 (99.84%)    9            $104,507
 *   kepler_c84      2,084   2,083         2,082             1            $49,870
 *   default         2,266     846           846             0            -
 *   factor_sale       905     148           118             30           $614,807
 *   override          278     277           215             62           $6,174,488
 *
 * Razon mediana de la etiquetera contra lo pagado: **1.00**. La cobertura verificable de la venta
 * pasa de 44.8% (solo kdii) a ~94%.
 *
 * ⚠️ Y se da vuelta la sospecha: la fuente PEOR es la correccion MANUAL. Los override fallan 22%,
 * y la forma delata el patron — 70006, 70043, 20555 y 70140 traen override = 1 contra 18, 12, 18
 * y 18 pagados. Son los de granel, donde units_per_box son KILOS por bulto y el 1 puede ser
 * deliberado (el stock va en kg). Por eso el veredicto los separa en `disputa_granel`: van a
 * bandeja, NO se corrigen parejo. Corregir parejo es lo que propuso $2.59M de compra en 57009.
 *
 * ── Los DOS ejes, y por que son dos ─────────────────────────────────────────────────────────
 * 1. `veredicto` — sobre `base_per_box` (unidades BASE por caja). Es propiedad del EMPAQUE, no
 *    del almacen: la caja trae lo que trae en las 9 bodegas.
 * 2. `veredicto_nativo` — solo tiene sentido en Wincaja, donde el divisor de presentacion cuenta
 *    unidades de VENTA (el paquete en multipack) y no unidades base. Audita la afirmacion de
 *    ADR-055: base_per_box / box_factor tiene que dar 1 (el almacen vende la base) o f2 (vende
 *    paquete). Medido: 24,795 celdas dan 1 y 1,085 dan f2 exacto (mediana 10.000) = **99.5%**.
 *    Las 128 restantes (45 SKUs) traen factor_venta = f2 en vez de f3/f2 — el divisor les queda
 *    4-40x chico. Ese es el unico defecto vivo de ADR-055 y ahora tiene nombre.
 *
 * ⛔ NO confundir los dos ejes. Comparar el divisor NATIVO de Wincaja contra units_per_box (que
 * cuenta base) marcaria los 355 multipack legitimos como falsos positivos. La primera version de
 * este chequeo cometio ese error y daba 16,897 celdas "mal": el testigo iba contra base_per_box,
 * no contra box_factor.
 *
 * ── Como se consume ─────────────────────────────────────────────────────────────────────────
 * `medible` es la unica bandera que hay que mirar antes de multiplicar (mismo contrato que
 * `rung_veredicto IS NULL` en U.2b): true cuando el factor esta verificado o no aplica. Con
 * `medible = false` el dinero va **NULL con motivo, nunca $0** — un cero se lee como "vale cero"
 * y la verdad es "no se esta midiendo".
 *
 * derive-no-copy sobre kepler_ods + wincaja: cero importers, cero tablas nuevas. 1,391 ms para
 * las 100,908 filas; los lectores paginan.
 *
 * SIN BACKTICKS en los comentarios SQL de abajo: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth');

  await knex.raw(`
    CREATE VIEW analytics.v_unit_truth AS
    WITH pago AS (
      -- EL TESTIGO: unidades base por caja segun lo que se PAGO (box_cost / u1_cost sobre
      -- kepler_ods.kdpv_prov_prod). Independiente de la etiquetera y del catalogo.
      SELECT sku, max(units_per_box)::numeric AS upb
        FROM analytics.v_supplier_cost_ladder
       WHERE units_per_box > 0
       GROUP BY sku
    ), base AS (
      SELECT w.tenant_id,
             w.warehouse_id,
             w.warehouse_code,
             w.product_id,
             w.sku,
             w.box_factor        AS box_factor,      -- divisor NATIVO de ese almacen
             w.factor_source,
             w.erp,
             w.base_label,
             w.box_label,
             w.is_weight,
             w.is_master_suspect,
             b.box_factor        AS base_per_box,    -- unidades BASE por caja (del empaque)
             b.source            AS base_source,
             b.factor_unit,
             b.unit_base,
             lad.f2,
             lad.f3,
             pago.upb            AS testigo_pago,
             lad.f3              AS testigo_erp
        FROM analytics.v_warehouse_box_factor w
        JOIN analytics.v_product_box_factor  b
          ON b.tenant_id = w.tenant_id AND b.product_id = w.product_id
        LEFT JOIN analytics.v_product_unit_ladder lad ON lad.sku = w.sku
        LEFT JOIN pago                                ON pago.sku = w.sku
    ), juzgado AS (
      SELECT base.*,
             -- Razon contra cada testigo. >1 = el factor publicado es MAYOR que el testigo.
             CASE WHEN testigo_pago > 0 THEN base_per_box / testigo_pago END AS razon_pago,
             CASE WHEN testigo_erp  > 0 THEN base_per_box / testigo_erp  END AS razon_erp,
             -- Razon nativo->base. En Kepler siempre 1; en Wincaja 1 (vende la base) o f2.
             CASE WHEN box_factor > 0 THEN base_per_box / box_factor END     AS nativo_a_base
        FROM base
    )
    SELECT j.tenant_id,
           j.warehouse_id,
           j.warehouse_code,
           j.product_id,
           j.sku,
           j.box_factor,
           j.base_per_box,
           j.factor_source,
           j.base_source,
           j.erp,
           j.base_label,
           j.box_label,
           j.unit_base,
           j.factor_unit,
           j.is_weight,
           j.is_master_suspect,
           j.f2,
           j.f3,
           j.testigo_pago,
           j.testigo_erp,
           round(j.razon_pago, 4)     AS razon_pago,
           round(j.razon_erp,  4)     AS razon_erp,
           round(j.nativo_a_base, 4)  AS nativo_a_base,

           -- ── EJE 1: el factor de CAJA (unidades base por caja). Gana la primera que aplica.
           CASE
             WHEN j.base_per_box <= 1                              THEN 'no_aplica'
             WHEN j.testigo_pago IS NULL AND j.testigo_erp IS NULL  THEN 'sin_testigo'
             WHEN (j.razon_pago IS NOT NULL AND abs(j.razon_pago - 1) <= 0.05)
               OR (j.razon_erp  IS NOT NULL AND abs(j.razon_erp  - 1) <= 0.05)
                                                                    THEN 'verificado'
             -- En granel el testigo cuenta KILOS por bulto y el factor puede contar otra cosa:
             -- la contradiccion es estructural, no un error de captura. Se separa para que la
             -- bandeja no mezcle 62 casos que piden criterio con errores mecanicos.
             WHEN j.is_weight                                       THEN 'disputa_granel'
             ELSE                                                        'en_disputa'
           END AS veredicto,

           -- ── EJE 2: el divisor NATIVO contra la escalera (audita ADR-055). Solo Wincaja puede
           -- diferir; en Kepler el nativo ES la base.
           CASE
             WHEN j.erp = 'kepler'                                  THEN 'nativo_es_base'
             WHEN j.nativo_a_base IS NULL                           THEN 'sin_razon'
             WHEN abs(j.nativo_a_base - 1) < 0.01                   THEN 'vende_la_base'
             WHEN j.f2 > 1 AND abs(j.nativo_a_base - j.f2) < 0.01    THEN 'vende_paquete'
             ELSE                                                        'no_explicado'
           END AS veredicto_nativo,

           -- La UNICA bandera que hay que mirar antes de multiplicar. Con false, el dinero va
           -- NULL con motivo — nunca 0. Mismo contrato que rung_veredicto IS NULL en U.2b.
           (j.base_per_box <= 1
            OR (j.razon_pago IS NOT NULL AND abs(j.razon_pago - 1) <= 0.05)
            OR (j.razon_erp  IS NOT NULL AND abs(j.razon_erp  - 1) <= 0.05)) AS medible
      FROM juzgado j
  `);

  await knex.raw('ALTER VIEW analytics.v_unit_truth SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth IS
    'U.4 - El resolvedor de unidad con veredicto, grano (tenant, almacen, producto). box_factor es el divisor NATIVO de ese almacen (identico a v_warehouse_box_factor, ADR-055); base_per_box son unidades BASE por caja. El veredicto contrasta base_per_box contra DOS testigos independientes: lo PAGADO al proveedor (v_supplier_cost_ladder.units_per_box, derivado de kepler_ods.kdpv_prov_prod) y la escalera del ERP (kdii.c84). Medido 2026-09-05: la etiquetera coincide con lo pagado en 5,569 de 5,578 SKUs (99.84%, razon mediana 1.00) - o sea SI tiene testigo, contra lo que afirmaba la doc. La fuente peor es el override manual: 62 de 277 contradicen ($6.17M de venta), casi todos granel con override=1 contra 12-18 pagados. REGLA DURA: antes de multiplicar una cantidad por dinero, exigir medible = true; con false el dinero va NULL con motivo, NUNCA 0. Ver ADR-056 y docs/UNIDADES_DE_MEDIDA.md.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth');
};
