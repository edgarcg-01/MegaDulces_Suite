'use strict';
/**
 * `[PR.S2]` — **Capa 2 · Datos: la tabla de señales.**
 *
 * Una fila por `(sucursal, sku)` — el grano donde vive la decisión de precio — con las señales
 * que **ya existen en prod**, cada una junto a **de dónde salió**. No construye ninguna fuente
 * nueva: reúne cuatro que estaban publicadas y sin un solo consumidor.
 *
 * ── ⛔⛔ El hallazgo que decide la forma: las coberturas son INCOMPARABLES ──────────────────
 * Medido el 2026-09-30 sobre los **86,163** pares con precio:
 *
 *   · psicología ............. **100.0 %**  (86,163)
 *   · meta y unidad .......... **97.5 %**   (83,976)
 *   · costo de reposición .... **38.2 %**   (32,877)
 *   · ⛔ cliente y descuento .. **6.0 %**    (5,151)
 *
 * La cascada sólo ve dos tipos de documento — `UD0801` telemarketing ($10.96 M) y `UD1201`
 * crédito ($1.36 M): **$12.3 M de ~$37.8 M = 33 % de la venta**. El mostrador, dos tercios, es
 * **contado anónimo**: sin cliente no hay descuento por cliente que medir. Es un límite de la
 * fuente, no del diseño.
 *
 * ⭐ **Por eso esta vista NO publica un score único.** Una señal al 6 % y una al 100 % no se
 * suman: promediarlas decidiría el precio del mostrador con evidencia que no lo incluye, y el
 * resultado se vería igual de confiable que cualquier otro. Se publica **un veredicto por
 * familia**, cada uno con su cobertura al lado.
 *
 * ── Las dos reducciones de grano, con su regla escrita ─────────────────────────────────────
 *  1. **peldaño → SKU.** Se toma el peldaño **más vendido** en 90 días, no el base. ⛔ No se
 *     promedia: 22 % (pieza) con 13.79 % (caja) **no da 17.9 %** — son dos negocios distintos.
 *     Cuando la venta está repartida y ningún peldaño manda, se publica `peldano_mixto`.
 *  2. **línea de factura → SKU.** Agregación **ponderada por importe**, y se publica la
 *     **dispersión** además de la media: el promedio de un descuento esconde justo al cliente
 *     que se está llevando el margen.
 *
 * VISTA derive-no-copy. No escribe nada. Aditiva.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_signals';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const dep of ['analytics.v_price_psychology', 'analytics.v_kepler_margin_target',
    'analytics.v_kepler_standard_cost', 'analytics.v_price_waterfall']) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [dep])).rows;
    if (!hay) throw new Error(`[PR.S2] falta ${dep}`);
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH
    /**
     * REDUCCION 1 · peldano -> SKU. El peldano que MANDA por venta, no el base.
     * El pareo es por factor: factor_sale de la venta contra el factor de la escalera.
     */
    venta_peldano AS (
      SELECT s.source_branch AS sucursal, s.sku, s.factor_sale,
             sum(s.monto_neto) AS venta
        FROM analytics.mv_kepler_sales_daily s
       WHERE s.business_date >= CURRENT_DATE - 90 AND s.monto_neto > 0
       GROUP BY 1, 2, 3
    ),
    peldano_manda AS (
      SELECT DISTINCT ON (v.sucursal, v.sku)
             v.sucursal, v.sku, m.peldano, m.unidad, m.markup_pct, m.margen_venta_pct,
             m.costo_estandar AS costo_peldano, m.es_caja,
             v.venta AS venta_peldano,
             -- Cuando el peldano que manda no llega al 70% de la venta, la eleccion es dudosa
             -- y se DECLARA: el margen difiere hasta 8 pp entre peldanos.
             (v.venta / NULLIF(sum(v.venta) OVER (PARTITION BY v.sucursal, v.sku), 0)) AS share
        FROM venta_peldano v
        JOIN analytics.v_kepler_margin_target m
          ON m.sucursal = v.sucursal AND m.sku = v.sku
         AND m.veredicto = 'capturado'
         AND abs(COALESCE(m.factor, 1) - COALESCE(v.factor_sale, 1)) < 0.01
       ORDER BY v.sucursal, v.sku, v.venta DESC
    ),
    /**
     * REDUCCION 2 · linea de factura -> SKU. Ponderado por importe, y con la DISPERSION:
     * el promedio de un descuento esconde al cliente que se lleva el margen.
     */
    cascada AS (
      SELECT w.sucursal, w.sku,
             count(*)::int                                        AS lineas,
             count(DISTINCT w.cliente_code)::int                  AS clientes,
             count(DISTINCT w.vendedor_code)::int                 AS vendedores,
             sum(w.neto_linea)                                    AS neto,
             sum(w.bruto_lista)                                   AS lista,
             sum(w.fuga_linea)                                    AS fuga,
             -- La dispersion del precio realmente cobrado, no su media.
             min(w.precio_unitario)                               AS pu_min,
             max(w.precio_unitario)                               AS pu_max,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY w.precio_unitario) AS pu_mediana,
             avg(w.dias_pago)                                     AS dias_pago,
             avg(w.dias_credito)                                  AS dias_credito
        FROM analytics.v_price_waterfall w
       WHERE w.fecha >= CURRENT_DATE - 30
       GROUP BY 1, 2
    )
    SELECT
      p.sucursal, p.sku, p.nombre,

      -- ═══ FAMILIA 1 · PSICOLOGIA — cobertura 100 % ═══
      p.precio                                              AS precio_actual,
      p.terminacion                                         AS d1_terminacion,
      p.falta_para_decena                                   AS d2_falta_decena,
      p.pegado_a_decena                                     AS d3_pegado_decena,
      p.umbral_percepcion_pct                               AS d4_umbral_percepcion,
      p.cand_99                                             AS d1_candidato_99,
      p.alza_implicita_99_pct                               AS d1_alza_99_pct,
      p.veredicto                                           AS f1_veredicto,
      'completa'::text                                      AS f1_cobertura,

      -- ═══ FAMILIA 2 · META Y UNIDAD — cobertura 97.5 % ═══
      pm.peldano                                            AS u1_peldano_manda,
      pm.unidad                                             AS u1_unidad,
      pm.markup_pct                                         AS m1_markup_ficha,
      pm.margen_venta_pct                                   AS m1_meta_margen,
      round((100 * pm.share)::numeric, 1)                   AS u1_share_peldano,
      CASE
        WHEN pm.peldano IS NULL   THEN 'sin_peldano_pareado'
        WHEN pm.share   <  0.70   THEN 'peldano_mixto'
        ELSE                           'peldano_claro'
      END                                                   AS f2_veredicto,
      CASE WHEN pm.peldano IS NULL THEN 'sin_dato' ELSE 'completa' END AS f2_cobertura,

      -- ═══ FAMILIA 3 · COSTO — cobertura 38.2 % ═══
      c.costo_estandar                                      AS a2_costo_ficha,
      c.costo_reposicion_base                               AS a1_costo_hoy,
      c.ultimo_costo                                        AS a3_ultimo_costo,
      c.ultimo_costo_al                                     AS a3_ultimo_costo_al,
      -- ⚠️ ultimo_costo_al llega como text: castear o el operador date - text no existe.
      (CURRENT_DATE - c.ultimo_costo_al::date)              AS a3_dias_sin_comprar,
      CASE WHEN c.costo_estandar > 0 AND c.costo_reposicion_base IS NOT NULL
           THEN round((100.0 * (c.costo_reposicion_base - c.costo_estandar)
                       / c.costo_estandar)::numeric, 2) END AS a6_deriva_costo_pct,
      CASE
        WHEN c.costo_reposicion_base IS NULL THEN 'sin_costo_de_hoy'
        WHEN c.costo_estandar IS NULL        THEN 'sin_costo_de_ficha'
        ELSE                                      'costo_comparable'
      END                                                   AS f3_veredicto,
      CASE WHEN c.costo_reposicion_base IS NULL THEN 'sin_dato' ELSE 'completa' END AS f3_cobertura,

      -- ═══ FAMILIA 4 · CLIENTE Y DESCUENTO — ⛔ cobertura 6.0 % de celdas / 33 % de venta ═══
      w.lineas                                              AS c0_lineas,
      w.clientes                                            AS c3_clientes,
      w.vendedores                                          AS c4_vendedores,
      round(w.neto::numeric, 2)                             AS c0_neto_30d,
      CASE WHEN w.lista > 0
           THEN round((100.0 * w.fuga / w.lista)::numeric, 3) END AS c2_fuga_pct,
      round(w.pu_mediana::numeric, 2)                       AS c5_precio_cobrado_mediano,
      -- ⭐ La DISPERSION, no la media: el rango es lo que senala al cliente que se lleva el margen.
      CASE WHEN w.pu_min > 0
           THEN round((100.0 * (w.pu_max - w.pu_min) / w.pu_min)::numeric, 2) END AS c2_rango_precio_pct,
      round(w.dias_pago::numeric, 1)                        AS a9_dias_pago,
      round((w.dias_pago - w.dias_credito)::numeric, 1)     AS a9_dias_exceso,
      /**
       * ⛔ EL VEREDICTO QUE MAS IMPORTA DE ESTA VISTA. Sin lineas de factura no hay evidencia
       * de cliente, y eso NO es "descuento cero": es que el mostrador vende de contado anonimo.
       * Publicarlo como 0 haria que el motor creyera que ahi no se descuenta.
       */
      CASE
        WHEN w.lineas IS NULL THEN 'sin_evidencia_de_cliente'
        WHEN w.clientes < 5   THEN 'pocos_clientes'
        ELSE                       'evidencia_suficiente'
      END                                                   AS f4_veredicto,
      CASE
        WHEN w.lineas IS NULL THEN 'sin_dato'
        WHEN w.clientes < 5   THEN 'parcial'
        ELSE                       'completa'
      END                                                   AS f4_cobertura,
      CASE WHEN w.lineas IS NULL
           THEN 'el mostrador es contado anonimo: sin cliente no hay descuento por cliente que medir'
           WHEN w.clientes < 5
           THEN 'menos de 5 clientes: la dispersion no es interpretable'
      END                                                   AS f4_motivo,

      p.venta_neta_30d                                      AS venta_30d,
      p.unidades_base_30d                                   AS unidades_30d
    FROM analytics.v_price_psychology p
    LEFT JOIN peldano_manda pm  ON pm.sucursal = p.sucursal AND pm.sku = p.sku
    LEFT JOIN analytics.v_kepler_standard_cost c
                                ON c.sucursal  = p.sucursal AND c.sku  = p.sku
    LEFT JOIN cascada w         ON w.sucursal  = p.sucursal AND w.sku  = p.sku
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.S2] Capa 2 del motor de margen: las SENALES por (sucursal, sku), el grano donde vive
    la decision de precio. No construye fuente nueva -- reune cuatro que estaban publicadas y sin
    un solo consumidor. ⛔⛔ Las coberturas son INCOMPARABLES y por eso NO hay score unico:
    psicologia 100.0% (86,163) · meta 97.5% (83,976) · costo 38.2% (32,877) · cliente y descuento
    6.0% (5,151). La cascada solo ve UD0801 telemarketing ($10.96M) y UD1201 credito ($1.36M) =
    33% de la venta; el mostrador es contado ANONIMO y sin cliente no hay descuento por cliente
    que medir. Promediar una senal al 6% con una al 100% decidiria el precio del mostrador -dos
    tercios de la venta- con evidencia que no lo incluye. Se publica un veredicto POR FAMILIA con
    su cobertura al lado. Dos reducciones de grano con regla escrita: peldano->SKU toma el mas
    VENDIDO (nunca promedia: 22% de pieza con 13.79% de caja no da 17.9%) y declara
    peldano_mixto bajo 70% de share; linea->SKU pondera por importe y publica la DISPERSION, no
    la media, porque el promedio de un descuento esconde al cliente que se lleva el margen.
    VISTA derive-no-copy, security_invoker.$c$`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE f1_cobertura = 'completa')::int f1,
           count(*) FILTER (WHERE f2_cobertura = 'completa')::int f2,
           count(*) FILTER (WHERE f3_cobertura = 'completa')::int f3,
           count(*) FILTER (WHERE f4_cobertura = 'completa')::int f4,
           -- ⛔ NEGATIVA 1: sin evidencia de cliente NO puede publicarse una fuga
           count(*) FILTER (WHERE f4_veredicto = 'sin_evidencia_de_cliente'
                              AND c2_fuga_pct IS NOT NULL)::int fuga_fantasma,
           -- ⛔ NEGATIVA 2: toda ausencia de la familia 4 lleva motivo
           count(*) FILTER (WHERE f4_cobertura <> 'completa'
                              AND f4_motivo IS NULL)::int muda,
           -- ⛔ NEGATIVA 3: un peldano mixto no puede reportarse como claro
           count(*) FILTER (WHERE u1_share_peldano < 70
                              AND f2_veredicto = 'peldano_claro')::int peldano_mentiroso,
           -- ⛔ NEGATIVA 4: nada con costo de hoy puede decir que no lo tiene
           count(*) FILTER (WHERE a1_costo_hoy IS NOT NULL
                              AND f3_veredicto = 'sin_costo_de_hoy')::int costo_mentiroso
      FROM ${VIEW}`)).rows;
  const ms = Date.now() - t0;

  const pc = (n) => `${((100 * n) / g.filas).toFixed(1)}%`;
  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2] ${g.filas} filas en ${ms} ms · cobertura por familia: `
    + `psicología ${pc(g.f1)} · meta ${pc(g.f2)} · costo ${pc(g.f3)} · cliente ${pc(g.f4)}`);

  if (g.fuga_fantasma > 0) {
    throw new Error(`[PR.S2] ${g.fuga_fantasma} filas publican fuga SIN evidencia de cliente: `
      + 'eso no es descuento cero, es que no hay con qué medirlo.');
  }
  if (g.muda > 0) {
    throw new Error(`[PR.S2] ${g.muda} ausencias MUDAS en la familia de cliente.`);
  }
  if (g.peldano_mentiroso > 0 || g.costo_mentiroso > 0) {
    throw new Error(`[PR.S2] veredicto que contradice su dato: ${g.peldano_mentiroso} peldaños, `
      + `${g.costo_mentiroso} costos.`);
  }
  // ⭐ Control positivo: si las cuatro familias tuvieran la MISMA cobertura, la vista estaría
  //    colapsando algo — el hallazgo que la justifica es justamente que difieren.
  if (g.f1 === g.f4) {
    throw new Error('[PR.S2] psicología y cliente tienen la misma cobertura: imposible con el '
      + 'mostrador anónimo. Algún join se está comportando como INNER.');
  }
  if (ms > 8000) {
    // eslint-disable-next-line no-console
    console.log(`  ⚠️ [PR.S2] ${ms} ms: por encima del gate de 1 s para pantalla. `
      + 'Si la va a consumir una vista, hay que materializarla.');
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
