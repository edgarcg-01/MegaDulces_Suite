'use strict';
/**
 * `[PR.S2.5]` — **A4 dejo de no existir: el ARBITRO DEL COSTO entra a las senales.**
 *
 * ── ⛔ Un motivo del registro caduco, y el registro lo destapo ─────────────────────────────
 * A4 estaba declarada `no_existe` con este motivo, escrito el 2026-09-30 por la manana:
 *
 *   *"analytics.mv_erp_margin_daily existe pero nunca se poblo (relispopulated=false):
 *     la matvista esta vacia"*
 *
 * **Ya es falso.** Medido esa misma tarde: `relispopulated = true`, **889,806 filas, 134 MB**,
 * de oct-2025 a hoy, con **97.28 %** de los renglones trayendo costo de verdad. La poblo el
 * carril nocturno que `[PR.R1]` cableo.
 *
 * ⭐ Esto es exactamente para lo que el registro existe: un markdown con esa frase adentro
 * seguiria diciendola hoy. Acá la frase se volvio a medir y cambio el estado.
 *
 * ⛔ Y no es una senal menor: es **el arbitro del costo** (ADR-059), el que decide si el margen
 * de la Suite es una medicion o un espejo del markup.
 *
 * ── ⭐⭐ Lo que trae, y por que cambia el diseno del motor ────────────────────────────────
 * El margen REALIZADO (dinero contra dinero, sin unidades de por medio) contra la meta que la
 * ficha de Kepler pide, medido sobre 19,553 celdas y $25.6 M de venta de 30 dias:
 *
 *   · realizado **14.83 %**  ·  meta de la ficha **11.30 %**  ·  diferencia **+3.53 pp**
 *
 * **La brecha va al reves de lo que cualquiera supondria.** Y es sistematica, no de unas pocas
 * celdas: mediana **+6.14 pp** sobre 15,591 celdas / $17.7 M, y se repite en **las 8 plazas**
 * (realizado 13.0-16.0 % contra meta 10.8-12.3 %).
 *
 * ⛔ **Consecuencia directa: `m1_meta_margen` NO es una meta que alcanzar — es un piso que ya
 * se supera.** Un motor que "cerrara la brecha contra la meta" propondria **BAJAR** precios.
 * Por eso esta vista publica la diferencia con su signo y su monto, y no la llama brecha.
 *
 * ── ⛔ Lo que NO se publica, y por que ────────────────────────────────────────────────────
 * El costo por unidad del arbitro (`cogs_arbitrado / unidades_vendidas`) **no se compara** con
 * el costo de la ficha: medido, en 2,528 celdas la razon mediana es **3.2301** y en 1,820 es
 * **0.6842**. Eso no es una diferencia de costo, es el **peldano** — dos unidades distintas.
 * El MARGEN si es comparable porque las dos piernas son dinero de los mismos renglones.
 * *Auditar una cantidad prestandole un precio funciona; auditar un precio prestandole una
 * cantidad de otra unidad, no.*
 *
 * ⚠️ El arbitro tiene 14 almacenes e incluye las **RUTA-\***, que no son sucursales de Kepler y
 * quedan fuera del join. Va declarado: no es un hueco, es otro universo.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_signals';
const MV = 'analytics.mv_price_signals';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const [{ pob }] = (await knex.raw(`
    SELECT relispopulated AS pob FROM pg_class
     WHERE oid = 'analytics.mv_erp_margin_daily'::regclass`)).rows;
  if (!pob) {
    throw new Error('[PR.S2.5] analytics.mv_erp_margin_daily volvio a estar vacia: A4 no se '
      + 'puede cablear y su motivo en el registro tendria que volver a decirlo.');
  }

  /**
   * ⚠️ El primer intento parchaba la vista con regex sobre `pg_get_viewdef`. Malo: esa funcion
   * NORMALIZA el SQL -- expande el `*`, reescribe los CASE y **borra todos los comentarios**.
   * La vista habria quedado en prod sin una sola de las razones escritas adentro. Aca va el
   * cuerpo completo y explicito, que es el que se lee cuando alguien pregunta por que.
   *
   * ⛔ Y se recrea entera en vez de encadenar una vista sobre la otra: un nivel mas de CTE es
   * justo lo que el planner ya demostro que no sabe podar bajo un LIMIT ([PR.S2.4]).
   */
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
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
    peldano_base AS (
      SELECT sucursal, sku, peldano, unidad, markup_pct, margen_venta_pct
        FROM analytics.v_kepler_margin_target
       WHERE peldano = 1 AND veredicto = 'capturado'
    ),

    -- ══ F5 · INVENTARIO ═══════════════════════════════════════════════════════════════════
    -- ⭐ EL PUENTE DE LLAVES, en un solo lugar. inventory_health y v_abc_class viven en
    --    (warehouse_id, product_id) y las senales en (sucursal, sku). warehouses.kepler_code es
    --    la unica columna que los une, y se verifico UNICO: 29,355 filas -> 29,355 celdas.
    -- ⛔ La sucursal 00 de Kepler es OFICINAS y no tiene warehouse con kepler_code: sus 9,592
    --    celdas quedan sin inventario a proposito, no por un join roto.
    inv AS (
      SELECT w.kepler_code AS sucursal, pr.sku::text AS sku,
             h.days_cover, h.status, h.on_hand, h.avg_daily_units,
             a.abc_class, a.annual_value
        FROM analytics.inventory_health h
        JOIN commercial.warehouses w
          ON w.id = h.warehouse_id AND w.kepler_code IS NOT NULL AND w.deleted_at IS NULL
        JOIN catalog.products pr
          ON pr.id = h.product_id AND pr.deleted_at IS NULL
        LEFT JOIN analytics.v_abc_class a
          ON a.warehouse_id = h.warehouse_id AND a.product_id = h.product_id
    ),

    -- ══ F6 · DEMANDA ══════════════════════════════════════════════════════════════════════
    -- ⚠️ Grano SKU, NO plaza: el mismo valor se repite en las 9 sucursales. Va declarado en
    --    f6_motivo, porque un numero que no distingue plaza no puede sostener una decision
    --    de precio POR plaza sin que alguien lo sepa.
    -- ⛔ 6 SKUs traen dos filas: DISTINCT ON por la mas reciente, no un promedio silencioso.
    dem AS (
      SELECT DISTINCT ON (d.sku)
             d.sku, d.z_seasonal, d.has_seasonal, d.iad, d.band, d.status AS dem_status
        FROM analytics.demand_acceleration d
       ORDER BY d.sku, d.computed_at DESC
    ),

    -- ══ F7 · HISTORIAL DE PRECIO ══════════════════════════════════════════════════════════
    hist AS (
      SELECT ch.sucursal, ch.sku, count(*)::int AS cambios,
             max(ch.fecha) AS ultimo,
             round((percentile_cont(0.5) WITHIN GROUP (
               ORDER BY abs(100.0 * ch.delta / NULLIF(ch.precio_anterior, 0))))::numeric, 2)
               AS magnitud_mediana
        FROM analytics.v_label_price_changes ch
       WHERE ch.fecha >= CURRENT_DATE - 90
       GROUP BY 1, 2
    ),

    -- ══ F8 · ESCALERA ═════════════════════════════════════════════════════════════════════
    -- El precio del peldano caja, llevado a unidad base, contra el precio de la unidad base.
    -- ⛔ NO se usa pv_base_cuadra: omite el impuesto y declara roto un catalogo sano en el
    --    79.3 % (medido en la Fase CE). Aca se comparan dos precios del MISMO catalogo, asi
    --    que el impuesto se cancela en la razon.
    esc AS (
      SELECT k.sucursal, k.sku, k.peldano_caja, k.factor_caja, k.unidad_caja, k.pv1,
             CASE k.peldano_caja WHEN 2 THEN k.pv2 WHEN 3 THEN k.pv3 END AS pv_caja
        FROM analytics.v_kepler_unit_ladder k
    ),

    -- ══ F9 · MERMA ════════════════════════════════════════════════════════════════════════
    -- ⛔ Una celda puede tener hasta 6 periodos de roll-forward: sin agregar, el LEFT JOIN
    --    multiplicaria las filas de la vista (medido: 86,163 -> 98,383).
    -- ⛔ Y no_recontado se EXCLUYE: son periodos sin conteo final, o sea mediciones que no
    --    ocurrieron. Sumarlas como si cuadraran es dibujar un cero.
    merma AS (
      SELECT r.kepler_sucursal AS sucursal, r.sku,
             count(*)::int AS periodos,
             sum(r.no_explicado) AS no_explicado,
             sum(r.vendido)      AS vendido
        FROM analytics.mv_erp_count_rollforward r
       WHERE r.veredicto <> 'no_recontado'
       GROUP BY 1, 2
    ),
    sin_reconteo AS (
      SELECT DISTINCT r.kepler_sucursal AS sucursal, r.sku
        FROM analytics.mv_erp_count_rollforward r
       WHERE r.veredicto = 'no_recontado'
    ),

    -- ══ F10 · CANASTA ═════════════════════════════════════════════════════════════════════
    -- ⚠️ El pipeline de afinidad solo mira retail (U/D/10): EXCLUYE el mayoreo, que es la
    --    mayor parte de la venta. Declarado en f10_motivo.
    canasta AS (
      SELECT pr.sku::text AS sku, max(f.lift) AS lift_max, count(*)::int AS socios
        FROM intelligence.product_affinity f
        JOIN catalog.products pr ON pr.id = f.product_a AND pr.deleted_at IS NULL
       GROUP BY 1
    ),

    -- ══ F11 · PROMOCION ═══════════════════════════════════════════════════════════════════
    -- ⭐ Esto es un CATALOGO: se lee entero, asi que una celda sin regla no es una ausencia,
    --    es el hecho de que no hay promocion. Por eso su cobertura es completa siempre.
    promo AS (
      SELECT d.tienda AS sucursal, d.sku, count(*)::int AS reglas,
             min(d.umbral) AS umbral, max(d.pct) AS pct,
             bool_and(d.umbral_verificado) AS verificado
        FROM analytics.v_erp_discount_rules d
       WHERE d.valid_to IS NULL OR d.valid_to >= CURRENT_DATE
       GROUP BY 1, 2
    ),

    -- ══ F12 · FALTANTES ═══════════════════════════════════════════════════════════════════
    -- ⛔ Esto es una CAPTURA, no un catalogo: sin reporte no se sabe si no falto nada o si
    --    nadie miro. Por eso hace falta saber que plazas reportan (plazas_que_reportan).
    falta AS (
      SELECT w.kepler_code AS sucursal, f.sku::text AS sku,
             sum(f.times_reported)::int AS reportes, max(f.week_start) AS ultimo
        FROM commercial.floor_stockouts f
        JOIN commercial.warehouses w
          ON w.id = f.warehouse_id AND w.kepler_code IS NOT NULL
       WHERE f.kind = 'agotado' AND f.sku IS NOT NULL
       GROUP BY 1, 2
    ),
    -- == F13 . MARGEN REALIZADO -- el ARBITRO DEL COSTO (ADR-059) =========================
    -- ⭐ Dinero contra dinero: venta costeada menos COGS arbitrado, sin unidades de por medio.
    --    Es la unica pierna de esta vista que dice lo que de verdad se GANO, no lo que la
    --    ficha pide ni lo que la formula del ERP implica.
    -- ⚠️ warehouse_code trae 14 almacenes e incluye RUTA-*, que no son sucursales de Kepler:
    --    quedan fuera del join a proposito. No es un hueco, es otro universo.
    arb AS (
      SELECT g.warehouse_code AS sucursal, g.sku,
             sum(g.venta_neta_costeada)   AS venta_costeada,
             sum(g.cogs_arbitrado)        AS cogs,
             sum(g.lineas)::int           AS lineas,
             sum(g.lineas_con_costo)::int AS lineas_con_costo,
             mode() WITHIN GROUP (ORDER BY g.metodo_costo) AS metodo
        FROM analytics.mv_erp_margin_daily g
       WHERE g.sale_date >= CURRENT_DATE - 30
         AND g.warehouse_code ~ '^0[0-8]$'
       GROUP BY 1, 2
    ),
    plazas_que_reportan AS (
      SELECT DISTINCT w.kepler_code AS sucursal
        FROM commercial.floor_stockouts f
        JOIN commercial.warehouses w ON w.id = f.warehouse_id AND w.kepler_code IS NOT NULL
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

      -- ═══ FAMILIA 3 · COSTO — 38.2 % ═══
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

      -- ═══ FAMILIA 5 · INVENTARIO — 34.0 % ═══ [E1 · E3 · G2]
      i.days_cover                                          AS e1_dias_cobertura,
      i.status                                              AS e3_estado_inventario,
      i.on_hand                                             AS e3_existencia,
      i.abc_class                                           AS g2_clase_abc,
      i.annual_value                                        AS g2_valor_anual,
      -- ⭐ Este veredicto NO es un peso, es una RESTRICCION. Subir el precio de lo agotado no
      --    vende mas; bajar el de lo que sobra libera capital. Son dos direcciones opuestas y
      --    el motor tiene que distinguirlas antes de ponderar nada.
      CASE
        WHEN i.status IS NULL                      THEN 'sin_evidencia_de_inventario'
        WHEN i.status IN ('agotado', 'critico')    THEN 'no_subir_sin_existencia'
        WHEN i.status IN ('sobrestock', 'muerto')  THEN 'habilita_bajar'
        ELSE                                            'sin_restriccion'
      END                                                   AS f5_veredicto,
      CASE WHEN i.status IS NULL THEN 'sin_dato' ELSE 'completa' END AS f5_cobertura,
      CASE WHEN i.status IS NULL THEN
        CASE WHEN p.sucursal = '00'
             THEN 'la sucursal 00 de Kepler es OFICINAS: no tiene almacen que medir'
             ELSE 'este SKU no tiene salud de inventario calculada en esta plaza'
        END
      END                                                   AS f5_motivo,

      -- ═══ FAMILIA 6 · DEMANDA — 61.3 % ═══ [B3 · B5]  ⚠️ grano SKU, no plaza
      d.z_seasonal                                          AS b3_z_estacional,
      d.has_seasonal                                        AS b3_tiene_estacion,
      d.iad                                                 AS b5_iad,
      d.band                                                AS b5_banda,
      CASE
        WHEN d.sku IS NULL                        THEN 'sin_evidencia_de_demanda'
        WHEN d.band IS NULL                       THEN 'venta_insuficiente'
        WHEN d.band LIKE 'accel%'                 THEN 'acelerando'
        WHEN d.band LIKE 'desacel%'               THEN 'desacelerando'
        ELSE                                           'estable'
      END                                                   AS f6_veredicto,
      CASE
        WHEN d.sku  IS NULL THEN 'sin_dato'
        WHEN d.band IS NULL THEN 'parcial'
        ELSE                     'completa'
      END                                                   AS f6_cobertura,
      -- ⛔ El motivo se publica SIEMPRE, incluso con cobertura completa: no es una ausencia,
      --    es una advertencia de GRANO. El mismo valor se repite en las 9 plazas, y nadie
      --    deberia sostener una decision por plaza con un numero que no distingue plazas.
      CASE
        WHEN d.sku  IS NULL THEN 'este SKU no entro al calculo de aceleracion de demanda'
        WHEN d.band IS NULL THEN 'venta insuficiente para una banda: ' || COALESCE(d.dem_status, 'sin estado')
        ELSE 'ATENCION: medido por SKU, no por plaza -- el mismo valor se repite en las 9 sucursales'
      END                                                   AS f6_motivo,

      -- ═══ FAMILIA 7 · HISTORIAL DE PRECIO — 35.8 % ═══ [D5 · D6]
      h.cambios                                             AS d5_cambios_90d,
      h.magnitud_mediana                                    AS d5_magnitud_mediana_pct,
      (CURRENT_DATE - h.ultimo)                             AS d6_dias_sin_cambio,
      -- ⭐ D6 es fatiga: dos alzas seguidas duelen mas que una del doble. El umbral de 21 dias
      --    es el paso que el plan de margen usa entre movimientos -- tocar antes es pisarse.
      CASE
        WHEN h.sucursal IS NULL                        THEN 'sin_historial_de_cambio'
        WHEN (CURRENT_DATE - h.ultimo) < 21            THEN 'movido_hace_poco'
        WHEN h.cambios >= 4                            THEN 'precio_inquieto'
        ELSE                                                'precio_asentado'
      END                                                   AS f7_veredicto,
      CASE WHEN h.sucursal IS NULL THEN 'sin_dato' ELSE 'completa' END AS f7_cobertura,
      CASE WHEN h.sucursal IS NULL
           THEN 'sin cambios de precio en 90 dias: no se puede medir fatiga ni frecuencia'
      END                                                   AS f7_motivo,

      -- ═══ FAMILIA 8 · ESCALERA — 100 % ═══ [D8]
      e.peldano_caja                                        AS d8_peldano_caja,
      e.factor_caja                                         AS d8_factor_caja,
      e.unidad_caja                                         AS d8_unidad_caja,
      CASE WHEN e.factor_caja > 0 AND e.pv_caja > 0
           THEN round((e.pv_caja / e.factor_caja)::numeric, 4) END AS d8_precio_caja_por_pieza,
      -- ⭐ La prima: cuanto MAS caro sale comprar la caja, por unidad. Negativa = el descuento
      --    por volumen que el cliente espera. Positiva = el catalogo se lee como un error.
      CASE WHEN e.pv1 > 0 AND e.pv_caja > 0 AND e.factor_caja > 0
           THEN round((100.0 * ((e.pv_caja / e.factor_caja) / e.pv1 - 1))::numeric, 2) END
                                                            AS d8_prima_caja_pct,
      CASE
        WHEN e.sucursal IS NULL                             THEN 'sin_ficha_de_unidades'
        WHEN e.peldano_caja = 1 OR e.factor_caja IS NULL
          OR e.factor_caja <= 1                             THEN 'sin_caja'
        WHEN e.pv1 IS NULL OR e.pv1 <= 0
          OR e.pv_caja IS NULL OR e.pv_caja <= 0            THEN 'sin_precio_comparable'
        WHEN (e.pv_caja / e.factor_caja) <= e.pv1 * 1.0001  THEN 'escalera_coherente'
        ELSE                                                     'escalera_incoherente'
      END                                                   AS f8_veredicto,
      CASE WHEN e.sucursal IS NULL THEN 'sin_dato' ELSE 'completa' END AS f8_cobertura,
      CASE WHEN e.sucursal IS NULL
           THEN 'este par no tiene ficha de unidades en Kepler'
      END                                                   AS f8_motivo,

      -- ═══ FAMILIA 9 · MERMA — 16.1 % ═══ [A10]
      mm.periodos                                           AS a10_periodos,
      mm.no_explicado                                       AS a10_no_explicado,
      CASE WHEN mm.vendido > 0
           THEN round((100.0 * mm.no_explicado / mm.vendido)::numeric, 2) END
                                                            AS a10_no_explicado_vs_vendido_pct,
      CASE
        WHEN mm.sucursal IS NOT NULL AND mm.no_explicado < 0 THEN 'merma'
        WHEN mm.sucursal IS NOT NULL AND mm.no_explicado > 0 THEN 'sobrante'
        WHEN mm.sucursal IS NOT NULL                         THEN 'cuadra'
        WHEN sr.sucursal IS NOT NULL                         THEN 'contado_sin_recontar'
        ELSE                                                      'sin_evidencia_de_conteo'
      END                                                   AS f9_veredicto,
      CASE WHEN mm.sucursal IS NULL THEN 'sin_dato' ELSE 'completa' END AS f9_cobertura,
      -- ⛔ Dos ausencias distintas con motivos distintos: una celda que se conto y no se
      --    RECONTO no es una celda que nunca se conto. La primera se puede cerrar con un
      --    conteo; la segunda ni siquiera esta en el programa.
      CASE
        WHEN mm.sucursal IS NULL AND sr.sucursal IS NOT NULL
          THEN 'hay conteo inicial pero no final: el periodo no cerro, no es que cuadre'
        WHEN mm.sucursal IS NULL
          THEN 'este par nunca entro a un roll-forward de conteos'
      END                                                   AS f9_motivo,

      -- ═══ FAMILIA 10 · CANASTA — 25.4 % ═══ [B10]  ⚠️ solo retail
      k.lift_max                                            AS b10_lift_max,
      k.socios                                              AS b10_socios,
      CASE
        WHEN k.sku IS NULL     THEN 'sin_evidencia_de_canasta'
        WHEN k.lift_max >= 1.5 THEN 'arrastra_canasta'
        ELSE                        'sin_arrastre'
      END                                                   AS f10_veredicto,
      CASE WHEN k.sku IS NULL THEN 'sin_dato' ELSE 'completa' END AS f10_cobertura,
      CASE
        WHEN k.sku IS NULL THEN 'sin pares de afinidad para este SKU'
        ELSE 'ATENCION: la afinidad solo mira retail (U/D/10) -- EXCLUYE el mayoreo'
      END                                                   AS f10_motivo,

      -- ═══ FAMILIA 11 · PROMOCION — 100 % ═══ [G5]  ⭐ catalogo, no captura
      (pm.sucursal IS NOT NULL)                             AS g5_promo_vigente,
      pm.umbral                                             AS g5_promo_umbral,
      pm.pct                                                AS g5_promo_pct,
      pm.verificado                                         AS g5_promo_verificada,
      CASE WHEN pm.sucursal IS NOT NULL THEN 'promo_vigente' ELSE 'sin_promo' END AS f11_veredicto,
      -- Se lee el catalogo ENTERO: no hay regla = no hay promocion. Eso es un hecho, no un hueco.
      'completa'::text                                      AS f11_cobertura,

      -- ═══ FAMILIA 12 · FALTANTES — 22.2 % de plazas ═══ [E4]  ⛔ captura, no catalogo
      COALESCE(fl.reportes, 0)                              AS e4_reportes_faltante,
      fl.ultimo                                             AS e4_ultimo_reporte,
      CASE
        WHEN fl.sucursal IS NOT NULL THEN 'reportado_faltante'
        WHEN pr.sucursal IS NOT NULL THEN 'sin_reporte'
        ELSE                              'plaza_no_reporta'
      END                                                   AS f12_veredicto,
      CASE WHEN pr.sucursal IS NULL THEN 'sin_dato' ELSE 'completa' END AS f12_cobertura,
      CASE WHEN pr.sucursal IS NULL
           THEN 'en esta plaza nadie ha reportado faltantes desde el mostrador: la ausencia no dice que no los haya'
      END                                                   AS f12_motivo,

      -- === FAMILIA 13 . MARGEN REALIZADO === [A4]  el ARBITRO DEL COSTO
      ab.venta_costeada                                     AS a4_venta_costeada_30d,
      ab.cogs                                               AS a4_cogs_30d,
      CASE WHEN ab.venta_costeada > 0
           THEN round((100.0 * (ab.venta_costeada - ab.cogs) / ab.venta_costeada)::numeric, 2)
      END                                                   AS a4_margen_realizado_pct,
      ab.metodo                                             AS a4_metodo_costo,
      CASE WHEN ab.lineas > 0
           THEN round((100.0 * ab.lineas_con_costo / ab.lineas)::numeric, 1) END
                                                            AS a4_lineas_con_costo_pct,
      -- ⭐⭐ La DIFERENCIA contra lo que la ficha pide. Se llama diferencia y no brecha a
      --    proposito: medido, el realizado SUPERA a la meta por 3.53 pp en agregado y 6.14 pp
      --    de mediana, en las 8 plazas. La meta de Kepler no es un objetivo que alcanzar, es
      --    un PISO que ya se supera -- y un motor que "cerrara la brecha" bajaria precios.
      CASE WHEN ab.venta_costeada > 0
             AND COALESCE(pv.margen_venta_pct, pb.margen_venta_pct) IS NOT NULL
           THEN round(((100.0 * (ab.venta_costeada - ab.cogs) / ab.venta_costeada)
                       - COALESCE(pv.margen_venta_pct, pb.margen_venta_pct))::numeric, 2)
      END                                                   AS a4_dif_vs_meta_pp,
      CASE WHEN ab.venta_costeada > 0
             AND COALESCE(pv.margen_venta_pct, pb.margen_venta_pct) IS NOT NULL
           THEN round((ab.venta_costeada
                       * ((100.0 * (ab.venta_costeada - ab.cogs) / ab.venta_costeada)
                          - COALESCE(pv.margen_venta_pct, pb.margen_venta_pct)) / 100.0)::numeric, 2)
      END                                                   AS a4_dif_vs_meta_mxn,
      -- ⛔ sum() de puros NULL devuelve NULL, no 0: sin esta primera rama 97 celdas SIN
      --    MEDICION caian al ELSE y se publicaban como 'coincide_con_meta'. La compuerta de
      --    ausencias mudas las encontro. Una ausencia disfrazada de coincidencia es peor que
      --    una ausencia muda: la muda se nota, esta se lee como un resultado.
      CASE
        WHEN ab.sucursal IS NULL                       THEN 'sin_evidencia_de_margen'
        WHEN ab.venta_costeada IS NULL                 THEN 'sin_venta_costeada'
        WHEN ab.venta_costeada <= 0                    THEN 'sin_venta_costeada'
        WHEN COALESCE(pv.margen_venta_pct, pb.margen_venta_pct) IS NULL
                                                       THEN 'sin_meta_con_que_comparar'
        WHEN (100.0 * (ab.venta_costeada - ab.cogs) / ab.venta_costeada)
             - COALESCE(pv.margen_venta_pct, pb.margen_venta_pct) >  2 THEN 'realizado_supera_meta'
        WHEN (100.0 * (ab.venta_costeada - ab.cogs) / ab.venta_costeada)
             - COALESCE(pv.margen_venta_pct, pb.margen_venta_pct) < -2 THEN 'realizado_bajo_meta'
        ELSE                                                                'coincide_con_meta'
      END                                                   AS f13_veredicto,
      CASE WHEN ab.venta_costeada > 0 THEN 'completa' ELSE 'sin_dato' END AS f13_cobertura,
      CASE WHEN ab.sucursal IS NULL
           THEN 'este par no vendio con costo arbitrado en 30 dias: sin dinero contra dinero no hay margen realizado'
           WHEN COALESCE(ab.venta_costeada, 0) <= 0
           THEN 'hubo renglones pero ninguno con costo: el arbitro no puede pronunciarse'
      END                                                   AS f13_motivo,

      p.venta_neta_30d                                      AS venta_30d,
      p.unidades_base_30d                                   AS unidades_30d
    FROM analytics.v_price_psychology p
    LEFT JOIN peldano_vendido pv ON pv.sucursal = p.sucursal AND pv.sku = p.sku
    LEFT JOIN peldano_base    pb ON pb.sucursal = p.sucursal AND pb.sku = p.sku
    LEFT JOIN analytics.v_kepler_standard_cost c
                                 ON c.sucursal  = p.sucursal AND c.sku  = p.sku
    LEFT JOIN analytics.mv_price_waterfall_sku w
                                 ON w.sucursal  = p.sucursal AND w.sku  = p.sku
    LEFT JOIN inv    i  ON i.sucursal  = p.sucursal AND i.sku  = p.sku
    LEFT JOIN dem    d  ON d.sku       = p.sku
    LEFT JOIN hist   h  ON h.sucursal  = p.sucursal AND h.sku  = p.sku
    LEFT JOIN esc    e  ON e.sucursal  = p.sucursal AND e.sku  = p.sku
    LEFT JOIN merma  mm ON mm.sucursal = p.sucursal AND mm.sku = p.sku
    LEFT JOIN sin_reconteo sr ON sr.sucursal = p.sucursal AND sr.sku = p.sku
    LEFT JOIN canasta k ON k.sku       = p.sku
    LEFT JOIN promo  pm ON pm.sucursal = p.sucursal AND pm.sku = p.sku
    LEFT JOIN falta  fl ON fl.sucursal = p.sucursal AND fl.sku = p.sku
    LEFT JOIN plazas_que_reportan pr ON pr.sucursal = p.sucursal
    LEFT JOIN arb   ab ON ab.sucursal = p.sucursal AND ab.sku = p.sku
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT s.*, now() AS calculado_al FROM ${VIEW} s`);
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_price_signals ON ${MV} (sucursal, sku)`);
  await knex.raw(`CREATE INDEX ix_mv_price_signals_plaza_venta
    ON ${MV} (sucursal, venta_30d DESC NULLS LAST)`);
  await knex.raw(`CREATE INDEX ix_mv_price_signals_sku ON ${MV} (sku)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    $c$[PR.S2.4/S2.5] La capa 2 materializada, por un costo MEDIDO: con 29 senales la consulta de
    una pantalla -WHERE sucursal + ORDER BY + LIMIT 50- pasa de 1,622 ms a 118,754 ms sobre la
    vista y vuelve a 8 ms aca. No es volumen, es el LIMIT. El precio -que la psicologia y el
    costo dejan de ser de ahora- se declara en calculado_al.$c$`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.S2.3/S2.5] Capa 2 del motor de margen: 29 senales en 13 familias de cobertura, una fila
    por (sucursal, sku). Cada familia lleva su cobertura y su motivo, porque coberturas de 100% y
    de 0.3% no se pueden sumar en un solo score.
    ⭐⭐ La familia 13 es el ARBITRO DEL COSTO (A4, ADR-059): dinero contra dinero. Medido sobre
    19,553 celdas y $25.6M de venta de 30 dias, el margen REALIZADO es 14.83% contra una meta de
    ficha de 11.30% -- la diferencia va al REVES de lo que cualquiera supondria, es sistematica
    (mediana +6.14 pp) y se repite en las 8 plazas. Por eso m1_meta_margen NO es una meta que
    alcanzar sino un piso que ya se supera, y un motor que "cerrara la brecha" bajaria precios.
    ⛔ El costo por UNIDAD del arbitro no se compara con el de la ficha: la razon mediana es
    3.2301 en 2,528 celdas y 0.6842 en 1,820 -- eso es el PELDANO, no una diferencia de costo.
    El margen si es comparable porque las dos piernas son dinero de los mismos renglones.$c$`);

  // -- Compuertas ---------------------------------------------------------------------
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE f13_cobertura = 'completa')::int f13,
           round(sum(venta_30d) FILTER (WHERE f13_cobertura = 'completa')::numeric, 0) venta_f13,
           round(sum(venta_30d)::numeric, 0) venta_total,
           count(*) FILTER (WHERE f13_veredicto = 'realizado_supera_meta')::int supera,
           count(*) FILTER (WHERE f13_veredicto = 'realizado_bajo_meta')::int bajo,
           count(*) FILTER (WHERE f13_cobertura <> 'completa' AND f13_motivo IS NULL)::int mudas,
           count(*) FILTER (WHERE f13_veredicto = 'sin_evidencia_de_margen'
                              AND a4_margen_realizado_pct IS NOT NULL)::int fantasma,
           round((100.0 * (sum(a4_venta_costeada_30d) - sum(a4_cogs_30d))
                  / NULLIF(sum(a4_venta_costeada_30d), 0))::numeric, 2) margen_agregado
      FROM ${MV}`)).rows;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.5] ${g.filas.toLocaleString()} filas · A4 cubre ${g.f13.toLocaleString()} `
    + `celdas (${((100 * g.f13) / g.filas).toFixed(1)} %) pero `
    + `${((100 * g.venta_f13) / g.venta_total).toFixed(1)} % de la venta`);
  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.5] ⭐ margen REALIZADO agregado ${g.margen_agregado} % · supera la meta `
    + `en ${g.supera.toLocaleString()} celdas · queda bajo en ${g.bajo.toLocaleString()}`);

  if (g.filas !== 86163) throw new Error(`[PR.S2.5] ${g.filas} filas: el arbitro fana el grano.`);
  if (g.mudas > 0) throw new Error(`[PR.S2.5] ${g.mudas} ausencias MUDAS en la familia 13.`);
  if (g.fantasma > 0) throw new Error(`[PR.S2.5] ${g.fantasma} margenes sin evidencia.`);
  if (g.f13 === 0) throw new Error('[PR.S2.5] A4 quedo en cero: el join contra el arbitro no pego.');
  /**
   * ⛔ La DIRECCION de la diferencia no se asume: se verifica. Si algun dia el realizado quedara
   *    por DEBAJO de la meta en la mayoria de las celdas, la tesis que sostiene el diseno del
   *    motor -que la meta de Kepler es un piso, no un objetivo- dejaria de ser cierta, y eso hay
   *    que enterarse por un rojo y no por una sorpresa.
   */
  if (g.supera <= g.bajo) {
    throw new Error(`[PR.S2.5] el realizado supera la meta en ${g.supera} celdas y queda bajo en `
      + `${g.bajo}: la medicion que sostiene el diseno del motor cambio de signo.`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
