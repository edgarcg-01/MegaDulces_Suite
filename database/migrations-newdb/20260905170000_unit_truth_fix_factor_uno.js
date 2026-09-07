/**
 * U.4 fix — un factor de 1 NO es "nada que verificar" cuando el testigo dice que SI hay caja.
 *
 * ── El defecto, medido contra prod ──────────────────────────────────────────────────────────
 * La primera version cortaba en `base_per_box <= 1 THEN no_aplica` ANTES de mirar al testigo.
 * Suena razonable — si no hay caja, no hay factor que auditar — pero deja pasar en silencio el
 * caso exactamente inverso: alguien DECLARO que no hay caja contra dos testigos que dicen que si.
 *
 * Medido: **13 SKUs, $5,135,134 de venta 365d**, todos con `source = override`, todos con
 * `base_per_box = 1` y con lo PAGADO y la escalera del ERP coincidiendo entre si:
 *
 *   sku     testigo_pago   testigo_erp   base_label   venta 365d
 *   -----   ------------   -----------   ----------   ----------
 *   70006   18.00          18.00         KG           $1,365,711
 *   70043   12.00          12.00         KG           $1,355,879
 *   20555   18.00          18.00         KG           $  842,106
 *   70140   18.00          18.00         500          $  482,194
 *   44227    5.00           5.00         KG           $  447,357
 *   30540   10.00          10.00         KG           $  362,072
 *
 * Son los de GRANEL, y `20555 CAR SURTIDO 18KG COLOMBINA` es literalmente el SKU que destapo la
 * auditoria de peldano (U.1): publicaba $4,982,228 de existencia valuando 6,753 KILOS al precio
 * del BULTO de 18 kg.
 *
 * ⚠️ El 1 puede ser CORRECTO: en granel la existencia va en kilos y dividir por 18 mostraria
 * bultos donde el operador cuenta kilos. Pero eso es una decision de PRESENTACION que alguien
 * tomo, no la ausencia de un empaque. Los dos testigos coinciden en que el bulto trae 18 kg. La
 * vista tiene que decir "esto esta en disputa y hay que mirarlo", no "aca no hay nada".
 *
 * Es el mismo error de forma que el bug de `nunca_entro` en el dictamen de existencia: una
 * condicion que parece una tautologia inofensiva y termina archivando el caso mas caro.
 *
 * ── El fix ─────────────────────────────────────────────────────────────────────────────────
 * `no_aplica` ahora exige DOS cosas: que el factor sea 1 **y** que ningun testigo lo contradiga.
 * Ademas el CASE del veredicto se calcula UNA sola vez en un CTE y `medible` se deriva de el —
 * antes estaban duplicados y podian desincronizarse en el proximo cambio sin que nada avisara.
 *
 * Efecto esperado: 8 SKUs de peso pasan a `disputa_granel` ($4.50M) y 5 a `en_disputa` ($639k).
 * `box_factor` NO cambia: el candado de equivalencia contra v_warehouse_box_factor (100,908
 * filas, 0 discrepancias) tiene que seguir dando cero.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  // Sin consumidores todavia (la vista nacio en el batch anterior), asi que DROP + CREATE es
  // seguro. En una vista viva iria CREATE OR REPLACE: recrearla revienta con 0A000 si alguien
  // la tiene en un plan cacheado.
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
      SELECT w.tenant_id, w.warehouse_id, w.warehouse_code, w.product_id, w.sku,
             w.box_factor AS box_factor,        -- divisor NATIVO de ese almacen
             w.factor_source, w.erp, w.base_label, w.box_label,
             w.is_weight, w.is_master_suspect,
             b.box_factor AS base_per_box,      -- unidades BASE por caja (del empaque)
             b.source     AS base_source,
             b.factor_unit, b.unit_base,
             lad.f2, lad.f3,
             pago.upb     AS testigo_pago,
             lad.f3       AS testigo_erp
        FROM analytics.v_warehouse_box_factor w
        JOIN analytics.v_product_box_factor  b
          ON b.tenant_id = w.tenant_id AND b.product_id = w.product_id
        LEFT JOIN analytics.v_product_unit_ladder lad ON lad.sku = w.sku
        LEFT JOIN pago                                ON pago.sku = w.sku
    ), juzgado AS (
      SELECT base.*,
             CASE WHEN testigo_pago > 0 THEN base_per_box / testigo_pago END AS razon_pago,
             CASE WHEN testigo_erp  > 0 THEN base_per_box / testigo_erp  END AS razon_erp,
             CASE WHEN box_factor   > 0 THEN base_per_box / box_factor   END AS nativo_a_base,
             -- Hay al menos un testigo que afirma que SI existe una caja.
             (COALESCE(testigo_pago, 0) > 1.05 OR COALESCE(testigo_erp, 0) > 1.05) AS testigo_ve_caja
        FROM base
    ), fallado AS (
      SELECT j.*,
             -- EJE 1: el factor de CAJA (unidades base por caja). Propiedad del EMPAQUE, no del
             -- almacen: la caja trae lo que trae en las 9 bodegas. Gana la primera que aplica.
             CASE
               -- ⭐ Va PRIMERO. Declarar "no hay caja" contra un testigo que dice que si la hay
               -- es una afirmacion, no una ausencia. 13 SKUs / $5.1M vivian aca como no_aplica.
               WHEN j.base_per_box <= 1 AND j.testigo_ve_caja AND j.is_weight
                                                                     THEN 'disputa_granel'
               WHEN j.base_per_box <= 1 AND j.testigo_ve_caja         THEN 'en_disputa'
               WHEN j.base_per_box <= 1                               THEN 'no_aplica'
               WHEN j.testigo_pago IS NULL AND j.testigo_erp IS NULL   THEN 'sin_testigo'
               WHEN (j.razon_pago IS NOT NULL AND abs(j.razon_pago - 1) <= 0.05)
                 OR (j.razon_erp  IS NOT NULL AND abs(j.razon_erp  - 1) <= 0.05)
                                                                      THEN 'verificado'
               -- En granel el testigo cuenta KILOS por bulto y el factor puede contar otra cosa:
               -- la contradiccion es estructural, no un error de captura. Se separa para que la
               -- bandeja no mezcle lo que pide criterio con lo que es mecanico.
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

           -- EJE 2: el divisor NATIVO contra la escalera (audita ADR-055). Solo Wincaja puede
           -- diferir; en Kepler el nativo ES la base. Medido: 24,795 celdas dan razon 1 y 1,085
           -- dan f2 exacto = 99.5%. Las 128 restantes (45 SKUs) traen factor_venta = f2 en vez
           -- de f3/f2 y el divisor les queda 4-40x chico: ese es el defecto vivo de ADR-055.
           CASE
             WHEN f.erp = 'kepler'                                   THEN 'nativo_es_base'
             WHEN f.nativo_a_base IS NULL                            THEN 'sin_razon'
             WHEN abs(f.nativo_a_base - 1) < 0.01                    THEN 'vende_la_base'
             WHEN f.f2 > 1 AND abs(f.nativo_a_base - f.f2) < 0.01     THEN 'vende_paquete'
             ELSE                                                         'no_explicado'
           END AS veredicto_nativo,

           -- La UNICA bandera que hay que mirar antes de multiplicar. Se DERIVA del veredicto
           -- (antes era un predicado duplicado que podia desincronizarse en silencio). Con false
           -- el dinero va NULL con motivo, NUNCA 0: un cero se lee como "vale cero" y la verdad
           -- es "no se esta midiendo". Mismo contrato que rung_veredicto IS NULL en U.2b.
           (f.veredicto IN ('verificado', 'no_aplica')) AS medible
      FROM fallado f
  `);

  await knex.raw('ALTER VIEW analytics.v_unit_truth SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_unit_truth TO app_runtime');

  await knex.raw(`COMMENT ON VIEW analytics.v_unit_truth IS
    'U.4 - El resolvedor de unidad con veredicto, grano (tenant, almacen, producto). box_factor es el divisor NATIVO de ese almacen (identico a v_warehouse_box_factor, ADR-055); base_per_box son unidades BASE por caja. El veredicto contrasta base_per_box contra DOS testigos independientes: lo PAGADO al proveedor (v_supplier_cost_ladder.units_per_box, derivado de kepler_ods.kdpv_prov_prod) y la escalera del ERP (kdii.c84). Medido 2026-09-05: la etiquetera coincide con lo pagado en 5,569 de 5,578 SKUs (99.84%, razon mediana 1.00) - o sea SI tiene testigo, contra lo que afirmaba la doc; 93% de la venta queda verificada. La fuente peor es el override manual. Un factor de 1 con testigo que ve caja NO es no_aplica: son 13 SKUs / $5.1M de granel que declaran que no hay empaque contra dos testigos que dicen 18, 12, 5, 10... REGLA DURA: antes de multiplicar una cantidad por dinero, exigir medible = true; con false el dinero va NULL con motivo, NUNCA 0. Ver ADR-056 y docs/UNIDADES_DE_MEDIDA.md.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_truth');
};
