/**
 * U.1 — `analytics.v_unit_rung_audit`: el detector de PELDAÑO CRUZADO.
 *
 * ── La clase de error que detecta ────────────────────────────────────────────────────────────
 * Dos magnitudes que se multiplican viven en peldaños distintos de la escalera de unidades
 * (base → paquete → caja/bulto) y nada declara el peldaño de cada una. El caso que la destapó:
 * `20555 CAR SURTIDO 18KG COLOMBINA` publicaba $4,982,228 de existencia — 6,753 KILOS valuados a
 * $737.78, que es el precio del BULTO de 18 kg. Lo correcto: ~$276,805.
 *
 * ── El detector, en una línea ───────────────────────────────────────────────────────────────
 * La pantalla publica  (stock / display_bf) * caja_cost.  La verdad es  stock * pagado.
 * Coinciden si y sólo si:      display_bf  ==  caja_cost / pagado
 * El cociente entre el divisor real y el esperado ES el factor de error. No hace falta resolver
 * la escalera, ni el rótulo, ni el nombre del producto.
 *
 * ── Los DOS árbitros, y por qué son dos ─────────────────────────────────────────────────────
 *   · almacenes KEPLER  -> `replenishment_plan.real_buy_cost` (costo unitario de compra ponderado
 *     90 d). Sirve porque viene en la MISMA unidad que el stock.
 *   · almacenes WINCAJA -> `wincaja.v_stock.costo_promedio` (el costo de Wincaja por SU propia
 *     unidad de stock). `real_buy_cost` sale de compras KEPLER y puede venir en otro peldaño, así
 *     que del lado de Wincaja no es árbitro válido.
 *
 * ── Medido en prod 2026-09-03, sobre los 5,570 SKUs con existencia ──────────────────────────
 *   OK  (el divisor cierra la brecha, ±70%)  5,313 SKUs (94%) · razón mediana 1.02 · $53.2M
 *   X1  divisor CHICO   -> INFLADA              40 SKUs · razón 0.15 · publica $9.23M vs $628k
 *   X2  divisor GRANDE  -> DEFLACTADA          113 SKUs · razón 8.62 · publica $610k vs $2.10M
 *   Z   sin compra reciente -> no arbitrable   104 SKUs · $13k
 * Exposición total ~320 SKUs / ~$11.6M mal valuado en las dos direcciones.
 *
 * ── Por qué se le puede creer al método ─────────────────────────────────────────────────────
 * En el 94% sano la razón mediana es 1.02 y los dos valuados difieren 3.8% ($53.2M vs $55.2M):
 * ése es el piso de ruido entre el costo de compra ponderado a 90 d y el costo de caja de lista.
 * Dos fuentes independientes coincidiendo donde deben. Los marcados están a 6.7x y 8.6x.
 *
 * ⚠️ ES UN TAMIZ, NO UN VEREDICTO. `real_buy_cost` es un promedio de 90 días y absorbe flete y
 * descuentos; la última compra sigue mejor al costo real que el promedio. Los marcados necesitan
 * confirmación por SKU (bandeja `peldano_cruzado`) antes de tocar nada.
 *
 * ⚠️ Y ninguna corrección se acepta sin contrastar el pedido resultante contra `revenue30`: una
 * corrección uniforme del `suf` llegó a proponer $2.59M/mes de compra contra $132k/mes de venta
 * real en `57009` — donde el divisor SÍ era legítimo (stock en cubetas, demanda en kilos).
 *
 * Ver docs/UNIDADES_DE_MEDIDA.md §7.10 y §8quater.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_unit_rung_audit WITH (security_invoker = true) AS
    WITH plan AS (
      SELECT rp.tenant_id, rp.product_id, rp.warehouse_id,
             w.code                              AS warehouse_code,
             w.kepler_code IS NOT NULL           AS es_kepler,
             p.sku, p.nombre,
             rp.stock_pz, rp.suf, rp.bf,
             GREATEST(COALESCE(rp.display_bf, rp.bf, 1), 1) AS display_bf,
             rp.caja_cost, rp.real_buy_cost, rp.revenue30, rp.daily_pieces
        FROM analytics.replenishment_plan rp
        JOIN commercial.warehouses w ON w.tenant_id = rp.tenant_id AND w.id = rp.warehouse_id
        JOIN catalog.products     p ON p.tenant_id = rp.tenant_id AND p.id = rp.product_id
       WHERE rp.stock_pz > 0 AND rp.caja_cost > 0
    ), wcj AS (
      -- Costo propio de Wincaja por SU unidad de stock. Es el arbitro de ese lado.
      SELECT v.tenant_id, w.id AS warehouse_id, p.id AS product_id, v.costo_promedio
        FROM wincaja.v_stock v
        JOIN commercial.warehouses w
          ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch
         AND w.kepler_code IS NULL AND w.deleted_at IS NULL
        JOIN catalog.products p
          ON p.tenant_id = v.tenant_id AND p.sku = v.sku AND p.deleted_at IS NULL
       WHERE v.costo_promedio > 0
    ), a AS (
      SELECT pl.*,
             wc.costo_promedio,
             CASE WHEN pl.es_kepler THEN 'kepler_compra' ELSE 'wincaja_costo' END AS arbitro,
             CASE WHEN pl.es_kepler THEN NULLIF(pl.real_buy_cost, 0)
                  ELSE COALESCE(NULLIF(wc.costo_promedio, 0), NULLIF(pl.real_buy_cost, 0)) END AS pagado
        FROM plan pl
        LEFT JOIN wcj wc ON wc.tenant_id = pl.tenant_id
                        AND wc.warehouse_id = pl.warehouse_id
                        AND wc.product_id = pl.product_id
    ), b AS (
      SELECT a.*,
             CASE WHEN a.pagado > 0 THEN a.caja_cost / a.pagado END AS display_bf_esperado
        FROM a
    )
    SELECT b.tenant_id, b.warehouse_id, b.warehouse_code, b.product_id, b.sku, b.nombre,
           b.arbitro,
           b.stock_pz, b.suf, b.bf, b.display_bf,
           round(b.display_bf_esperado::numeric, 4)                       AS display_bf_esperado,
           round((b.display_bf / NULLIF(b.display_bf_esperado, 0))::numeric, 4) AS razon,
           round(b.caja_cost::numeric, 4)                                 AS caja_cost,
           round(b.pagado::numeric, 4)                                    AS pagado,
           round((b.stock_pz / b.display_bf * b.caja_cost)::numeric, 2)   AS valor_publicado,
           round((b.stock_pz * b.pagado)::numeric, 2)                     AS valor_arbitrado,
           round(b.revenue30::numeric, 2)                                 AS revenue30,
           -- El veredicto. La banda +-70% es generosa a proposito: el ruido medido entre el costo
           -- de compra de 90 d y el costo de caja de lista es 3.8%, asi que lo que cae afuera esta
           -- muy afuera (las medianas marcadas son 0.15 y 8.62).
           CASE WHEN b.display_bf_esperado IS NULL                                    THEN 'z_no_arbitrable'
                WHEN b.display_bf / b.display_bf_esperado BETWEEN 0.60 AND 1.70       THEN 'ok'
                WHEN b.display_bf < b.display_bf_esperado                             THEN 'x1_inflada'
                ELSE                                                                       'x2_deflactada' END AS veredicto,
           COALESCE(ul.is_weight, false)                                  AS es_granel,
           (uov.product_id IS NOT NULL)                                   AS con_override,
           uov.sold_as                                                    AS override_sold_as,
           -- suf>1 con bf=1 es el estado que produjo los 15 auto-seed de granel: el factor quedo
           -- en la columna que SOLO consume la demanda. Se expone para triage.
           (b.suf > 1 AND b.bf <= 1)                                      AS factor_partido,
           vbf.factor_source,
           vbf.box_label, vbf.base_label
      FROM b
      LEFT JOIN analytics.v_product_unit_ladder ul ON ul.sku = b.sku
      LEFT JOIN commercial.product_unit_overrides uov
             ON uov.tenant_id = b.tenant_id AND uov.product_id = b.product_id AND uov.deleted_at IS NULL
      LEFT JOIN analytics.v_warehouse_box_factor vbf
             ON vbf.tenant_id = b.tenant_id AND vbf.warehouse_id = b.warehouse_id
            AND vbf.product_id = b.product_id`);

  await knex.raw('GRANT SELECT ON analytics.v_unit_rung_audit TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_unit_rung_audit');
};
