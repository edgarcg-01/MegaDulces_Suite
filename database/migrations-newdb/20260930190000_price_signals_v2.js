'use strict';
/**
 * `[PR.S2.2]` — **Dos correcciones a la capa de datos, las dos medidas.**
 *
 * ── 1 · La velocidad: 79,618 ms → se repunta a la matvista ─────────────────────────────────
 * El diagnóstico pieza por pieza puso **58,560 de los 79,618 ms** en la cascada agregada — el
 * 73 % en un solo CTE. `[PR.S2.1]` la materializó (`mv_price_waterfall_sku`, lectura **2 ms**).
 * Acá se repunta la vista a ella.
 *
 * ── 2 · La cobertura del peldaño: 97.5 % → 26.5 %, y por qué ───────────────────────────────
 * La reducción "peldaño → SKU" toma el peldaño **más vendido**, pero eso **exige venta con
 * factor pareado**. Medido: sólo **22,822 de 86,163** pares la tienen. Los otros 63,341 no son
 * productos sin meta — son productos **sin venta en la ventana**, que es otra cosa.
 *
 * ⭐ La corrección: cuando no hay venta que desempate, se cae al peldaño **base**, y la fuente
 * se **declara** en `u1_fuente_peldano`:
 *
 *   · `vendido` ....... el peldaño que manda por venta (el bueno)
 *   · `base_sin_venta`  respaldo: sin venta no hay desempate, se usa la base
 *   · `sin_ficha` ..... Kepler no capturó markup en ningún peldaño
 *
 * ⛔ **No es lo mismo y por eso no se colapsa.** Un margen sacado del peldaño vendido describe
 * lo que el negocio hace; uno sacado de la base describe lo que la ficha dice. Mezclarlos en una
 * sola columna sin decir cuál es cuál es exactamente el defecto que este motor existe para no
 * repetir — el margen difiere hasta **8 pp** entre peldaños.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_signals';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ hay }] = (await knex.raw(
    `SELECT to_regclass('analytics.mv_price_waterfall_sku') IS NOT NULL AS hay`)).rows;
  if (!hay) throw new Error('[PR.S2.2] falta analytics.mv_price_waterfall_sku ([PR.S2.1])');

  /**
   * ⚠️ DROP + CREATE, no CREATE OR REPLACE: se renombra u1_peldano_manda -> u1_peldano y
   * REPLACE no puede cambiar el nombre de una columna. Es seguro porque esta vista todavia
   * no tiene ningun consumidor -- si lo tuviera, habria que recrearla con el nombre viejo
   * conservado como alias (el repo ya pago un 0A000 por recrear una vista viva).
   */
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);

  await knex.raw(`
    CREATE VIEW ${VIEW}
      WITH (security_invoker = true) AS
    WITH venta_peldano AS (
      SELECT s.source_branch AS sucursal, s.sku, s.factor_sale,
             sum(s.monto_neto) AS venta
        FROM analytics.mv_kepler_sales_daily s
       WHERE s.business_date >= CURRENT_DATE - 90 AND s.monto_neto > 0
       GROUP BY 1, 2, 3
    ),
    -- El peldano que MANDA por venta. Sin venta no hay desempate: cae al respaldo de abajo.
    peldano_vendido AS (
      SELECT DISTINCT ON (v.sucursal, v.sku)
             v.sucursal, v.sku, m.peldano, m.unidad, m.markup_pct, m.margen_venta_pct,
             (v.venta / NULLIF(sum(v.venta) OVER (PARTITION BY v.sucursal, v.sku), 0)) AS share
        FROM venta_peldano v
        JOIN analytics.v_kepler_margin_target m
          ON m.sucursal = v.sucursal AND m.sku = v.sku
         AND m.veredicto = 'capturado'
         AND abs(COALESCE(m.factor, 1) - COALESCE(v.factor_sale, 1)) < 0.01
       ORDER BY v.sucursal, v.sku, v.venta DESC
    ),
    -- ⭐ El RESPALDO: el peldano base. Describe lo que la ficha dice, no lo que el negocio hace.
    --    Se usa sólo donde no hay venta, y la diferencia queda escrita en u1_fuente_peldano.
    peldano_base AS (
      SELECT sucursal, sku, peldano, unidad, markup_pct, margen_venta_pct
        FROM analytics.v_kepler_margin_target
       WHERE peldano = 1 AND veredicto = 'capturado'
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

      -- ═══ FAMILIA 2 · META Y UNIDAD ═══
      COALESCE(pv.peldano, pb.peldano)                      AS u1_peldano,
      COALESCE(pv.unidad, pb.unidad)                        AS u1_unidad,
      COALESCE(pv.markup_pct, pb.markup_pct)                AS m1_markup_ficha,
      COALESCE(pv.margen_venta_pct, pb.margen_venta_pct)    AS m1_meta_margen,
      round((100 * pv.share)::numeric, 1)                   AS u1_share_peldano,
      /**
       * ⭐ LA COLUMNA QUE EVITA EL COLAPSO. Un margen del peldano VENDIDO describe lo que el
       * negocio hace; uno de la BASE describe lo que la ficha dice. Difieren hasta 8 pp.
       */
      CASE
        WHEN pv.peldano IS NOT NULL THEN 'vendido'
        WHEN pb.peldano IS NOT NULL THEN 'base_sin_venta'
        ELSE                             'sin_ficha'
      END                                                   AS u1_fuente_peldano,
      CASE
        WHEN pv.peldano IS NOT NULL AND pv.share <  0.70 THEN 'peldano_mixto'
        WHEN pv.peldano IS NOT NULL                      THEN 'peldano_claro'
        WHEN pb.peldano IS NOT NULL                      THEN 'peldano_supuesto'
        ELSE                                                  'sin_meta'
      END                                                   AS f2_veredicto,
      CASE
        WHEN pv.peldano IS NOT NULL THEN 'completa'
        WHEN pb.peldano IS NOT NULL THEN 'parcial'
        ELSE                             'sin_dato'
      END                                                   AS f2_cobertura,
      CASE
        WHEN pv.peldano IS NULL AND pb.peldano IS NOT NULL
          THEN 'sin venta en 90 dias no hay peldano que desempate: se usa la base, que dice lo que la ficha pide, no lo que el negocio hace'
        WHEN pb.peldano IS NULL
          THEN 'Kepler no capturo markup en ningun peldano de este SKU'
      END                                                   AS f2_motivo,

      -- ═══ FAMILIA 3 · COSTO — cobertura 38.2 % ═══
      c.costo_estandar                                      AS a2_costo_ficha,
      c.costo_reposicion_base                               AS a1_costo_hoy,
      c.ultimo_costo                                        AS a3_ultimo_costo,
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

      -- ═══ FAMILIA 4 · CLIENTE — ⛔ 6 % de celdas / 33 % de la venta ═══
      w.lineas                                              AS c0_lineas,
      w.clientes                                            AS c3_clientes,
      w.vendedores                                          AS c4_vendedores,
      w.neto                                                AS c0_neto_30d,
      CASE WHEN w.lista > 0
           THEN round((100.0 * w.fuga / w.lista)::numeric, 3) END AS c2_fuga_pct,
      w.pu_mediana                                          AS c5_precio_cobrado_mediano,
      CASE WHEN w.pu_min > 0
           THEN round((100.0 * (w.pu_max - w.pu_min) / w.pu_min)::numeric, 2) END AS c2_rango_precio_pct,
      w.dias_pago                                           AS a9_dias_pago,
      round((w.dias_pago - w.dias_credito)::numeric, 1)     AS a9_dias_exceso,
      w.calculado_al                                        AS c0_calculado_al,
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
    LEFT JOIN peldano_vendido pv ON pv.sucursal = p.sucursal AND pv.sku = p.sku
    LEFT JOIN peldano_base    pb ON pb.sucursal = p.sucursal AND pb.sku = p.sku
    LEFT JOIN analytics.v_kepler_standard_cost c
                                 ON c.sucursal  = p.sucursal AND c.sku  = p.sku
    LEFT JOIN analytics.mv_price_waterfall_sku w
                                 ON w.sucursal  = p.sucursal AND w.sku  = p.sku
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE u1_fuente_peldano = 'vendido')::int p_vendido,
           count(*) FILTER (WHERE u1_fuente_peldano = 'base_sin_venta')::int p_base,
           count(*) FILTER (WHERE u1_fuente_peldano = 'sin_ficha')::int p_sin,
           count(*) FILTER (WHERE f3_cobertura = 'completa')::int f3,
           count(*) FILTER (WHERE f4_cobertura <> 'sin_dato')::int f4,
           count(*) FILTER (WHERE f4_veredicto = 'sin_evidencia_de_cliente'
                              AND c2_fuga_pct IS NOT NULL)::int fuga_fantasma,
           count(*) FILTER (WHERE f2_cobertura <> 'completa' AND f2_motivo IS NULL)::int muda,
           -- ⛔ Un peldaño de respaldo NUNCA puede reportarse como claro
           count(*) FILTER (WHERE u1_fuente_peldano = 'base_sin_venta'
                              AND f2_veredicto = 'peldano_claro')::int respaldo_mentiroso,
           count(*) FILTER (WHERE m1_meta_margen IS NOT NULL
                              AND u1_fuente_peldano = 'sin_ficha')::int meta_fantasma
      FROM ${VIEW}`)).rows;
  const ms = Date.now() - t0;

  const pc = (n) => `${((100 * n) / g.filas).toFixed(1)}%`;
  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.2] ${g.filas} filas en ${ms} ms (antes 79,618) · peldaño: `
    + `vendido ${pc(g.p_vendido)} · base ${pc(g.p_base)} · sin ficha ${pc(g.p_sin)} · `
    + `costo ${pc(g.f3)} · cliente ${pc(g.f4)}`);

  if (g.fuga_fantasma > 0) throw new Error(`[PR.S2.2] ${g.fuga_fantasma} fugas sin evidencia.`);
  if (g.muda > 0) throw new Error(`[PR.S2.2] ${g.muda} ausencias MUDAS en la familia de meta.`);
  if (g.respaldo_mentiroso > 0) {
    throw new Error(`[PR.S2.2] ${g.respaldo_mentiroso} peldaños de RESPALDO reportados como `
      + 'claros: lo que la ficha dice no es lo que el negocio hace.');
  }
  if (g.meta_fantasma > 0) {
    throw new Error(`[PR.S2.2] ${g.meta_fantasma} metas publicadas sin ficha que las respalde.`);
  }
  if (g.p_vendido === 0) throw new Error('[PR.S2.2] ningún peldaño resuelto por venta.');
  if (ms > 8000) {
    throw new Error(`[PR.S2.2] sigue tardando ${ms} ms: repuntar a la matvista no sirvió.`);
  }
};

exports.down = async function down(knex) {
  // No se revierte a la versión de 80 s. Se baja la vista.
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
