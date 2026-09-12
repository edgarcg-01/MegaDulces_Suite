/**
 * UXC.1 — EL FACTOR DE CAJA QUE SE PUEDE PUBLICAR A NIVEL PRODUCTO, con su veredicto.
 *
 * Nace de un reporte de Edgar sobre una celda concreta de Sell-Out:
 *
 *     96504   RUFFLES QUESO 27G / 1   UxC = 1      <- y son 58
 *
 * ── Lo medido (2026-09-11, prod) ────────────────────────────────────────────────────────────
 *
 * El resolvedor canónico YA tenía la respuesta: `v_product_box_factor` da **58** para ese SKU
 * (`source = kepler_c84`), y tres testigos independientes lo confirman — Kepler `c84` en 13
 * almacenes, `wincaja.factor_venta` en 3, y lo PAGADO al proveedor ($281.35 / $4.85 = 58.01).
 * Lo que publicaba el 1 era `catalog.products.factor_sale`, que Sell-Out lee directo.
 *
 *     Sell-Out publica 1 y el resolvedor dice >1 ....   208 productos · $4,971,338 / 90 d
 *     factor_sale difiere del resolvedor (cualquier direccion) ...  659 de 11,236
 *
 * ⛔ Y hay CUATRO consumidores leyendo CUATRO fuentes distintas del mismo número: Sell-Out
 * (`factor_sale`), Andén (`product_barcodes.factor`), Compras (`factor_sale` con respaldo en la
 * etiquetera) y el resolvedor canónico. ADR-055 ya declaraba cuál manda.
 *
 * ── Por qué una vista NUEVA y no una columna en `v_product_box_factor` ──────────────────────
 *
 * Porque `v_product_box_factor` es la **raíz** de la cadena, no su hoja: de él cuelgan
 * `v_warehouse_box_factor`, `v_unit_truth`, `mv_kepler_sales_daily`, `v_erp_stock_on_hand`,
 * `v_sales_demand_truth` y `erp_sales_invoice_lines`. El consenso entre plazas sólo se puede
 * calcular leyendo `v_warehouse_box_factor`, o sea su propio dependiente: meterlo adentro sería
 * un ciclo.
 *
 * ── ⭐ La trampa que se midió ANTES de elegir: `default` NO es un voto ───────────────────────
 *
 * `factor_source = 'default'` no significa "esta plaza opina 1": significa **que no hay testigo
 * ahí**. Contarlo como voto fabrica desacuerdos donde hay un solo testigo:
 *
 *     "difieren" contando default como voto ....   497    <- 9 fabricados
 *     difieren entre TESTIGOS REALES ...........   488    ($19,067,599 / 90 d)
 *     sin NINGUN testigo (todo default) ........ 2,197
 *
 * Los 2,197 sin testigo publican hoy un `1` indistinguible de "no sabemos". Acá salen con
 * veredicto propio (`sin_testigo`) en vez de confundirse con los de pieza.
 *
 * ── El contrato ─────────────────────────────────────────────────────────────────────────────
 *
 * `box_factor_publicable` trae un número SÓLO cuando los testigos reales concuerdan. Cuando no,
 * va **NULL** y `veredicto` dice por qué — nunca una moda, nunca un promedio (ADR-056: lo que no
 * se puede afirmar se declara). El consumidor que quiera el valor de siempre lo tiene igual en
 * `box_factor_resolvedor`, con su `source`.
 *
 * @param { import("knex").Knex } knex
 */

const V = 'analytics.v_product_box_factor_consensus';

const SQL = `
CREATE OR REPLACE VIEW ${V} AS
WITH testigos AS (
  -- Solo las plazas que AFIRMAN algo. 'default' es ausencia, no opinion.
  SELECT tenant_id, product_id,
         count(*)::int                   AS plazas_con_testigo,
         count(DISTINCT box_factor)::int AS factores_distintos,
         min(box_factor)::numeric        AS factor_min,
         max(box_factor)::numeric        AS factor_max,
         string_agg(DISTINCT factor_source, ',') AS fuentes
    FROM analytics.v_warehouse_box_factor
   WHERE factor_source <> 'default'
   GROUP BY 1, 2)
SELECT b.tenant_id,
       b.product_id,
       COALESCE(t.plazas_con_testigo, 0) AS plazas_con_testigo,
       COALESCE(t.factores_distintos, 0) AS factores_distintos,
       t.factor_min,
       t.factor_max,
       t.fuentes,
       b.box_factor                      AS box_factor_resolvedor,
       b.source,
       b.unit_base,
       b.is_weight,
       b.is_master_suspect,
       CASE WHEN COALESCE(t.plazas_con_testigo, 0) = 0 THEN 'sin_testigo'
            WHEN t.factores_distintos > 1            THEN 'difiere_entre_plazas'
            ELSE 'consenso' END          AS veredicto,
       -- NULL cuando no se puede afirmar. Nunca una moda.
       CASE WHEN COALESCE(t.plazas_con_testigo, 0) = 0 THEN NULL
            WHEN t.factores_distintos > 1            THEN NULL
            ELSE t.factor_max END        AS box_factor_publicable
  FROM analytics.v_product_box_factor b
  LEFT JOIN testigos t
    ON t.tenant_id = b.tenant_id AND t.product_id = b.product_id`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  // U.7: security_invoker y el GRANT NO se heredan tras CREATE OR REPLACE.
  await knex.raw(`ALTER VIEW ${V} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${V} TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW ${V} IS
    'UXC.1 - Factor de caja por PRODUCTO con veredicto de consenso entre plazas. box_factor_publicable trae numero SOLO si los testigos reales concuerdan; NULL con motivo si no (ADR-056: nunca una moda). factor_source = default se EXCLUYE del conteo: es ausencia, no opinion (contarlo fabricaba 9 desacuerdos). Lo consume Sell-Out en vez de catalog.products.factor_sale, que publicaba 1 en 208 productos donde el resolvedor dice >1 ($4.97M/90d). ADR-055.'`);

  // ── Auto-verificacion ─────────────────────────────────────────────────────────────────────
  const r = (await knex.raw(`
    SELECT count(*)::int productos,
           count(*) FILTER (WHERE veredicto = 'consenso')::int consenso,
           count(*) FILTER (WHERE veredicto = 'difiere_entre_plazas')::int difieren,
           count(*) FILTER (WHERE veredicto = 'sin_testigo')::int sin_testigo,
           count(*) FILTER (WHERE box_factor_publicable IS NOT NULL)::int publicables
      FROM ${V}`)).rows[0];
  console.log(`  [uxc] ${r.productos} productos · consenso ${r.consenso} · difieren ${r.difieren}`
    + ` · sin testigo ${r.sin_testigo} · publicables ${r.publicables}`);

  if (r.publicables !== r.consenso) {
    throw new Error(`publicables (${r.publicables}) != consenso (${r.consenso}): `
      + 'se esta publicando un numero sin consenso');
  }
  if (r.difieren < 1) throw new Error('cero desacuerdos: la vista no esta mirando las plazas');
  if (r.sin_testigo < 1) throw new Error('cero sin_testigo: default se esta contando como voto');

  // PRUEBA NEGATIVA 1 - el SKU que abrio el reporte tiene que salir con 58, no con 1.
  const caso = (await knex.raw(`
    SELECT v.box_factor_publicable, v.veredicto, v.source, p.factor_sale
      FROM ${V} v JOIN catalog.products p ON p.id = v.product_id AND p.tenant_id = v.tenant_id
     WHERE p.sku = '96504' AND p.deleted_at IS NULL`)).rows[0];
  if (!caso) throw new Error('el SKU 96504 del reporte no aparece en la vista');
  console.log(`  [uxc] 96504: publicable ${caso.box_factor_publicable} (${caso.veredicto},`
    + ` ${caso.source}) · lo que publica hoy Sell-Out (factor_sale): ${caso.factor_sale}`);
  if (Number(caso.box_factor_publicable) !== 58) {
    throw new Error(`96504 deberia publicar 58 y publica ${caso.box_factor_publicable}`);
  }
  if (Number(caso.factor_sale) !== 1) {
    throw new Error(`factor_sale de 96504 ya no es 1 (${caso.factor_sale}): la premisa cambio`);
  }

  // PRUEBA NEGATIVA 2 - excluir 'default' tiene que MORDER: contarlo da MAS desacuerdos.
  const conDefault = (await knex.raw(`
    SELECT count(*)::int n FROM (
      SELECT product_id FROM analytics.v_warehouse_box_factor
       GROUP BY tenant_id, product_id HAVING count(DISTINCT box_factor) > 1) z`)).rows[0].n;
  console.log(`  [uxc] PRUEBA NEGATIVA: contando 'default' como voto darian ${conDefault}`
    + ` desacuerdos; excluyendolo dan ${r.difieren}`);
  if (conDefault <= r.difieren) {
    throw new Error(`excluir 'default' no cambia nada (${conDefault} vs ${r.difieren}): `
      + 'la exclusion es decorativa y hay que revisarla');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${V}`);
};
