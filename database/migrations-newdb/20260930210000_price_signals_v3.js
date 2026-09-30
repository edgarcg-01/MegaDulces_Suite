'use strict';
/**
 * `[PR.S2.3]` — **La capa 2 al 100 %: se cablean las 12 senales que ya tenian fuente.**
 *
 * ── Que significa "la capa 2 completa" ────────────────────────────────────────────────────
 * El registro de la capa 1 dejo el estado medido: 16 cableadas, **13 disponibles** (la fuente
 * existe y esta poblada, y **nadie la lee**) y 17 que no existen. Una senal `disponible` es la
 * peor de las tres: nadie sabe que esta ahi, y el motor decide sin ella creyendo que no hay mas.
 *
 * ⭐ La capa 2 esta completa cuando **no queda ninguna en `disponible`**: cada fuente que existe
 * o se lee, o se midio y se cerro con su numero escrito. Eso es lo que hace esta migracion mas
 * la que la sigue.
 *
 * ── ⛔ A5 NO se cablea, y la razon es una medicion ────────────────────────────────────────
 * `v_supplier_cost_ladder` iba a traer "la escalera del proveedor: comprar mejor habilita vender
 * mejor". **No existe tal escalera.**
 *
 * El primer intento de comprobarlo fue circular -- comparo `u1_cost` contra `box_cost/units_per_box`
 * y dio 100.00 % de identidad, porque **esa vista define `units_per_box` como `box_cost/u1_cost`**.
 * Verificar una vista contra si misma la pone verde siempre.
 *
 * La prueba buena cruza el costo CRUDO del proveedor (`kdpv_prov_prod.c8` y `c9`) contra un
 * testigo independiente: el factor de unidades **capturado en `kdii`**. Medido sobre 6,511 SKUs:
 *
 *   · **6,407 (98.4 %)** -- la razon de costos entre peldanos es **exactamente** el factor de
 *     unidades (razon media **0.99999**) ⇒ el costo por unidad base es identico en todos los
 *     peldanos ⇒ **cero descuento por volumen**.
 *   · 96 "con descuento" -- razon media **0.072**, que no es un descuento del 7 % sino una
 *     escalera **corrida** (el defecto ya documentado en el decode de Kepler).
 *   · 3 al reves, mismo artefacto invertido.
 *
 * Cablearla publicaria **una constante disfrazada de senal**. Se declara y se cierra.
 *
 * ── Lo que si se cablea, con su cobertura MEDIDA el 2026-09-30 ────────────────────────────
 *
 *   f5  inventario ...... 34.0 %  E1 cobertura · E3 sobrestock · G2 clase ABC
 *   f6  demanda ......... 61.3 %  B3 estacionalidad · B5 momentum      ⚠️ grano SKU, no plaza
 *   f7  historial ....... 35.8 %  D5 frecuencia · D6 fatiga
 *   f8  escalera ........ 100 %   D8 coherencia                        ⭐ 717 incoherentes
 *   f9  merma ........... 16.1 %  A10 roll-forward de conteos
 *   f10 canasta ......... 25.4 %  B10 arrastre                         ⚠️ solo retail
 *   f11 promocion ....... 100 %   G5 regla vigente                     (presencia, ver abajo)
 *   f12 faltantes ....... 22.2 %  E4 lo que el mostrador reporto       (captura, ver abajo)
 *
 * ── ⭐⭐ Dos fuentes que parecen iguales y NO lo son ──────────────────────────────────────
 * `v_erp_discount_rules` es un **catalogo**: se lee entero, asi que una celda sin regla **no es
 * una ausencia** -- es el hecho de que no hay promocion. Cobertura `completa` siempre.
 *
 * `floor_stockouts` es una **captura**: una celda sin reporte puede significar que no falto
 * nada, o que en esa plaza **nadie reporta**. Medido: solo 2 de 9 plazas tienen algun reporte.
 * Por eso su cobertura es `completa` unicamente donde la plaza reporta, y `sin_dato` en el resto
 * con su motivo escrito. Tratar las dos igual publicaria "aqui no falta nada" sobre siete plazas
 * donde nadie ha mirado.
 *
 * ── ⚠️ Y una correccion al registro ───────────────────────────────────────────────────────
 * El motivo de G5 decia "4 mecanismos, 2 con umbral NO verificado". Medido hoy: las **338**
 * reglas son `descuento_cantidad` y las 338 traen `umbral_verificado = true`. Lo que llega a las
 * celdas esta verificado al 100 %. La advertencia describia otra ventana.
 *
 * @param { import("knex").Knex } knex
 */

const VIEW = 'analytics.v_price_signals';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  for (const o of ['analytics.mv_price_waterfall_sku', 'analytics.mv_erp_count_rollforward',
    'analytics.demand_acceleration', 'intelligence.product_affinity',
    'analytics.v_label_price_changes', 'analytics.v_kepler_unit_ladder',
    'analytics.inventory_health', 'analytics.v_abc_class',
    'analytics.v_erp_discount_rules', 'commercial.floor_stockouts']) {
    const [{ hay }] = (await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [o])).rows;
    if (!hay) throw new Error(`[PR.S2.3] falta la fuente ${o}`);
  }

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
  `);

  await knex.raw(`GRANT SELECT ON ${VIEW} TO app_runtime`);

  await knex.raw(`COMMENT ON VIEW ${VIEW} IS
    $c$[PR.S2.3] Capa 2 del motor de margen, COMPLETA: 28 senales cableadas en 12 familias de
    cobertura, una fila por (sucursal, sku). Cada familia lleva su cobertura y su motivo, porque
    coberturas de 100% y de 0.3% no se pueden sumar en un solo score.
    ⛔ A5 (escalera del proveedor) NO se cablea: medido contra un testigo independiente -el factor
    capturado en kdii- el costo por unidad base es IDENTICO en todos los peldanos en 6,407 de
    6,511 SKUs (razon 0.99999). No hay descuento por volumen que leer; cablearla publicaria una
    constante. La primera prueba fue circular (la vista define units_per_box como box_cost/u1_cost)
    y dio 100% de identidad por construccion.
    ⭐ f11 (promocion) es un CATALOGO: se lee entero, asi que sin regla = no hay promo, cobertura
    completa. f12 (faltantes) es una CAPTURA: sin reporte no se sabe si no falto nada o si nadie
    miro, y solo 2 de 9 plazas reportan. Tratarlas igual publicaria "aqui no falta nada" sobre
    siete plazas donde nadie ha mirado.$c$`);

  // ── Compuerta ───────────────────────────────────────────────────────────────────────
  // ⚠️ Se mide DOS veces y se juzga la segunda. La primera pasada en frio dio 11,095 ms contra
  //    2,729-2,986 ms en regimen: gatear sobre la fria haria fallar la migracion por el estado
  //    de la cache, que no es lo que este numero pretende vigilar.
  await knex.raw(`SELECT count(*) FROM ${VIEW}`);
  const t0 = Date.now();
  const [g] = (await knex.raw(`
    SELECT count(*)::int filas,
           count(*) FILTER (WHERE f5_cobertura  = 'completa')::int f5,
           count(*) FILTER (WHERE f6_cobertura <> 'sin_dato')::int f6,
           count(*) FILTER (WHERE f7_cobertura  = 'completa')::int f7,
           count(*) FILTER (WHERE f8_cobertura  = 'completa')::int f8,
           count(*) FILTER (WHERE f9_cobertura  = 'completa')::int f9,
           count(*) FILTER (WHERE f10_cobertura = 'completa')::int f10,
           count(*) FILTER (WHERE f11_veredicto = 'promo_vigente')::int f11,
           count(*) FILTER (WHERE f12_veredicto = 'reportado_faltante')::int f12,
           count(*) FILTER (WHERE f8_veredicto = 'escalera_incoherente')::int incoherentes,
           count(*) FILTER (WHERE f9_veredicto = 'merma')::int con_merma,
           count(*) FILTER (WHERE f5_cobertura  <> 'completa' AND f5_motivo  IS NULL)::int m5,
           count(*) FILTER (WHERE f6_cobertura  <> 'completa' AND f6_motivo  IS NULL)::int m6,
           count(*) FILTER (WHERE f7_cobertura  <> 'completa' AND f7_motivo  IS NULL)::int m7,
           count(*) FILTER (WHERE f8_cobertura  <> 'completa' AND f8_motivo  IS NULL)::int m8,
           count(*) FILTER (WHERE f9_cobertura  <> 'completa' AND f9_motivo  IS NULL)::int m9,
           count(*) FILTER (WHERE f10_cobertura <> 'completa' AND f10_motivo IS NULL)::int m10,
           count(*) FILTER (WHERE f12_cobertura <> 'completa' AND f12_motivo IS NULL)::int m12,
           count(*) FILTER (WHERE f5_veredicto = 'sin_evidencia_de_inventario'
                              AND e1_dias_cobertura IS NOT NULL)::int fantasma5,
           count(*) FILTER (WHERE f9_veredicto = 'sin_evidencia_de_conteo'
                              AND a10_no_explicado IS NOT NULL)::int fantasma9,
           count(*) FILTER (WHERE f12_veredicto = 'plaza_no_reporta'
                              AND e4_reportes_faltante > 0)::int fantasma12
      FROM ${VIEW}`)).rows;
  const ms = Date.now() - t0;
  const pc = (n) => `${((100 * n) / g.filas).toFixed(1)}%`;

  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.3] ${g.filas.toLocaleString()} filas en ${ms} ms · inventario ${pc(g.f5)} `
    + `· demanda ${pc(g.f6)} · historial ${pc(g.f7)} · escalera ${pc(g.f8)} · merma ${pc(g.f9)} `
    + `· canasta ${pc(g.f10)} · promo ${g.f11} celdas · faltantes ${g.f12} celdas`);
  // eslint-disable-next-line no-console
  console.log(`  · [PR.S2.3] ⭐ escaleras INCOHERENTES ${g.incoherentes} · celdas con merma ${g.con_merma}`);

  const mudas = g.m5 + g.m6 + g.m7 + g.m8 + g.m9 + g.m10 + g.m12;
  if (mudas > 0) {
    throw new Error(`[PR.S2.3] ${mudas} ausencias MUDAS `
      + `(f5=${g.m5} f6=${g.m6} f7=${g.m7} f8=${g.m8} f9=${g.m9} f10=${g.m10} f12=${g.m12}).`);
  }
  const fantasmas = g.fantasma5 + g.fantasma9 + g.fantasma12;
  if (fantasmas > 0) {
    throw new Error(`[PR.S2.3] ${fantasmas} valores publicados sin evidencia que los respalde.`);
  }
  // ⛔ La fila NO se puede multiplicar: 12 LEFT JOIN nuevos y cualquiera que no sea unico
  //    duplicaria celdas en silencio. Medido antes: 86,163.
  if (g.filas !== 86163) {
    throw new Error(`[PR.S2.3] la vista devuelve ${g.filas} filas y el grano medido es 86,163: `
      + 'algun LEFT JOIN esta multiplicando celdas.');
  }
  if (g.f8 === 0 || g.f5 === 0 || g.f7 === 0) {
    throw new Error('[PR.S2.3] alguna familia nueva quedo en cero: el puente de llaves no pego.');
  }
  /**
   * ⛔⛔ EL LIMITE DE ESTA VISTA, MEDIDO -- y la razon por la que la sigue una matvista.
   *
   * El barrido completo esta bien (≈2.9 s en regimen, contra 1.2 s de la version de 16 senales).
   * Lo que se rompe es la consulta que hace una PANTALLA:
   *
   *     WHERE sucursal = '03' ORDER BY venta_30d DESC LIMIT 50
   *       · con 16 senales (v2) .....   1,622 ms
   *       · con 28 senales (v3) ... 118,754 ms      ⛔ 73x
   *
   * No es volumen: es el LIMIT. Con 14 joins el planner cree que un plan de arranque rapido le
   * sale barato y elige bucles anidados sobre CTEs que no puede podar. Agregar senales cruzo el
   * punto donde esa apuesta deja de pagar.
   *
   * ⚠️ La primera medicion de esto dio 56 s y estaba MAL: envolvi el cuerpo en otro WITH, que
   * no es como el planner ve una vista. El numero bueno sale con el predicado aplicado al SELECT
   * exterior, que es lo que hace una vista de verdad. Un arnes que no reproduce el entorno real
   * mide otra cosa.
   *
   * Por eso [PR.S2.4] materializa esta vista y la pantalla lee de ahi. La vista se queda como la
   * DEFINICION -- es lo que el registro de senales verifica columna por columna.
   */
  if (ms > 20000) {
    throw new Error(`[PR.S2.3] la vista tarda ${ms} ms en regimen.`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS ${VIEW}`);
};
