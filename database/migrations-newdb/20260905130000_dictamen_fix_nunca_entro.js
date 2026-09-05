/**
 * D.1 fix — dos defectos que la primera corrida del dictamen destapó, medidos contra prod.
 *
 * ── 1. `nunca_entro` marcaba 1,913 celdas SANAS ────────────────────────────────────────────
 * La condicion era `entradas = 0 AND salidas > 0`, que en Kepler es una contradiccion (no hay
 * baseline: si nunca entro nada, no pudo salir) pero en Wincaja NO lo es, porque ahi el baseline
 * SI existe. Caso real medido: SKU 20021 en MD-30 con baseline 3,124, entradas 0, salidas 708 →
 * saldo **+2,416**. Es vender el inventario inicial sin recibir nada nuevo: lo mas normal del
 * mundo, y lo estabamos llamando anomalia.
 *
 * Medido antes del fix: 2,965 celdas marcadas, de las cuales **1,913 tenian saldo POSITIVO**.
 * Habrian inundado la bandeja con no-anomalias y enterrado las 867 reales.
 *
 * El fix: `nunca_entro` exige ademas `qty_cruda < 0`. Pasa a ser lo que siempre quiso decir — un
 * subtipo de saldo imposible cuya causa es inequivoca: no hay ninguna entrada que explique lo que
 * salio. Queda en **867 celdas** (712 Kepler + 155 Wincaja sin baseline).
 *
 * La leccion, que es la de siempre en este proyecto: una regla que es cierta en una fuente no se
 * hereda a la otra. Kepler y Wincaja no guardan la existencia con la misma estructura.
 *
 * ── 2. El EXISTS del conteo fisico corria POR FILA ─────────────────────────────────────────
 * 52,421 subconsultas correlacionadas contra inventory_count_items → **13,200 ms** el agregado
 * completo. Se reemplaza por un LEFT JOIN contra un CTE pre-agregado: hay 6 folios y NINGUNO
 * reconciliado, asi que el conjunto es trivial y la rama queda igual de dormida pero gratis.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  // La vista no tiene consumidores todavia (se creo hace minutos, en el batch anterior), asi que
  // DROP + CREATE es seguro. En una vista viva iria CREATE OR REPLACE — recrearla revienta con
  // 0A000 si alguien la tiene en un plan cacheado.
  await knex.raw('DROP VIEW IF EXISTS analytics.v_existencia_dictamen');

  await knex.raw(`
    CREATE VIEW analytics.v_existencia_dictamen AS
    WITH conteos AS (
      -- Pre-agregado en vez de un EXISTS por fila. Hoy devuelve CERO filas (6 folios, ninguno
      -- reconciliado): la rama existe para el dia que Almacen opere conteos, que es el unico
      -- camino a un baseline real del saldo.
      SELECT DISTINCT cc.tenant_id, cc.warehouse_id, ci.product_id
        FROM commercial.inventory_count_items ci
        JOIN commercial.inventory_counts cc
             ON cc.tenant_id = ci.tenant_id AND cc.id = ci.count_id
            AND cc.reconciled_at IS NOT NULL
    ),
    kep AS (
      SELECT w.tenant_id,
             w.id                                AS warehouse_id,
             w.code                              AS warehouse_code,
             pr.id                               AS product_id,
             pr.sku,
             'kepler'::text                      AS erp,
             0::numeric                          AS baseline,
             sum(k.c8)::numeric                  AS entradas,
             sum(k.c9)::numeric                  AS salidas,
             sum(k.c4 + k.c8 - k.c9)::numeric    AS qty_cruda,
             NULLIF(max(k.c6), '1800-01-01 06:36:36'::timestamp) AS ult_compra,
             NULLIF(max(k.c7), '1800-01-01 06:36:36'::timestamp) AS ult_venta
        FROM kepler_ods.kdil k
        JOIN commercial.warehouses w
             ON w.kepler_code = k.sucursal AND w.kepler_code <> '00' AND w.deleted_at IS NULL
        JOIN catalog.products pr
             ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
       WHERE k.sucursal = k.c1
         AND btrim(k.c3) NOT IN ('00001', '00002', '00022')
       GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
    ),
    win AS (
      SELECT w.tenant_id,
             w.id                                     AS warehouse_id,
             w.code                                   AS warehouse_code,
             pr.id                                    AS product_id,
             pr.sku,
             'wincaja'::text                          AS erp,
             sum(COALESCE(e.existencia_inicial, 0))::numeric AS baseline,
             sum(COALESCE(e.entrada, 0))::numeric     AS entradas,
             sum(COALESCE(e.salida, 0))::numeric      AS salidas,
             sum(COALESCE(e.existencia, 0))::numeric  AS qty_cruda,
             max(e.fecha_ult_compra)                  AS ult_compra,
             max(e.fecha_ult_venta)                   AS ult_venta
        FROM wincaja.existencias e
        JOIN commercial.warehouses w
             ON w.tenant_id = e.tenant_id AND w.wincaja_source_branch = e.source_branch
            AND w.kepler_code IS NULL AND w.deleted_at IS NULL
        JOIN catalog.products pr
             ON pr.tenant_id = e.tenant_id AND pr.sku::text = e.articulo AND pr.deleted_at IS NULL
       WHERE e.source_dataset = 'actual'
         AND e.existencia IS NOT NULL
       GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
    ),
    base AS (
      SELECT * FROM kep
      UNION ALL
      SELECT * FROM win
    ),
    ctx AS (
      SELECT b.*,
             COALESCE(p.cost_with_tax, p.cost_base, 0)::numeric AS costo_unitario,
             rp.rung_veredicto,
             vbf.base_label,
             (cn.product_id IS NOT NULL) AS con_conteo
        FROM base b
        LEFT JOIN catalog.products p
               ON p.tenant_id = b.tenant_id AND p.id = b.product_id
        LEFT JOIN analytics.replenishment_plan rp
               ON rp.tenant_id = b.tenant_id AND rp.warehouse_id = b.warehouse_id
              AND rp.product_id = b.product_id
        LEFT JOIN analytics.v_warehouse_box_factor vbf
               ON vbf.tenant_id = b.tenant_id AND vbf.warehouse_id = b.warehouse_id
              AND vbf.product_id = b.product_id
        LEFT JOIN conteos cn
               ON cn.tenant_id = b.tenant_id AND cn.warehouse_id = b.warehouse_id
              AND cn.product_id = b.product_id
    )
    SELECT c.tenant_id,
           c.warehouse_id,
           c.warehouse_code,
           c.product_id,
           c.sku,
           c.erp,
           GREATEST(c.qty_cruda, 0)                       AS qty_publicada,
           c.qty_cruda,
           c.baseline,
           c.entradas,
           c.salidas,
           c.ult_compra,
           c.ult_venta,
           c.costo_unitario,
           c.base_label,
           c.rung_veredicto,
           -- El dinero va NULL cuando el PELDAÑO esta en disputa (regla U.2b / ADR-055):
           -- multiplicar una cantidad de unidad no verificada por un costo da una cifra inventada.
           CASE WHEN c.rung_veredicto IS NULL
                THEN round((GREATEST(c.qty_cruda, 0) * c.costo_unitario)::numeric, 2)
           END AS valor_existencia,
           CASE WHEN c.rung_veredicto IS NULL
                THEN round((abs(LEAST(c.qty_cruda, 0)) * c.costo_unitario)::numeric, 2)
           END AS valor_faltante,
           CASE WHEN c.salidas > 0 AND c.qty_cruda < 0
                THEN round((abs(c.qty_cruda) / c.salidas)::numeric, 4) END         AS hueco_pct,
           (c.ult_venta > now() - interval '90 days')                              AS vivo,

           CASE WHEN c.con_conteo            THEN 'conteo_fisico'
                WHEN c.baseline <> 0         THEN 'baseline_real'
                ELSE                              'solo_flujo'
           END AS apoyo,

           -- EJE 2. La columna objecion es la PRINCIPAL (gana la primera que aplica) y es la que
           -- se filtra y se pinta; objeciones las trae TODAS, porque una celda puede tener el
           -- saldo imposible Y ademas la unidad en disputa, y quedarse con una sola escondería
           -- la mitad del problema justo en los casos peores.
           --
           -- nunca_entro exige saldo NEGATIVO: sin eso marcaba 1,913 celdas sanas de Wincaja,
           -- donde vender el inventario inicial sin recibir nada nuevo es normal (ver header).
           CASE
             WHEN c.entradas = 0 AND c.salidas > 0 AND c.qty_cruda < 0 THEN 'nunca_entro'
             WHEN c.qty_cruda < 0 AND c.salidas > 0
                  AND abs(c.qty_cruda) / c.salidas > 0.15             THEN 'faltante'
             WHEN c.qty_cruda < 0                                     THEN 'negativo_menor'
             WHEN c.rung_veredicto IN ('x1_inflada', 'x2_deflactada') THEN 'unidad_sin_verificar'
             WHEN c.qty_cruda > 0
                  AND GREATEST(c.ult_compra, c.ult_venta) < now() - interval '365 days'
                                                                      THEN 'sin_movimiento'
             ELSE                                                          'ninguna'
           END AS objecion,
           array_remove(ARRAY[
             CASE WHEN c.entradas = 0 AND c.salidas > 0 AND c.qty_cruda < 0
                       THEN 'nunca_entro' END,
             CASE WHEN c.qty_cruda < 0 AND c.salidas > 0
                       AND abs(c.qty_cruda) / c.salidas > 0.15 THEN 'faltante' END,
             CASE WHEN c.qty_cruda < 0 AND NOT (c.salidas > 0
                       AND abs(c.qty_cruda) / c.salidas > 0.15) THEN 'negativo_menor' END,
             CASE WHEN c.rung_veredicto IN ('x1_inflada', 'x2_deflactada')
                       THEN 'unidad_sin_verificar' END,
             CASE WHEN c.qty_cruda > 0
                       AND GREATEST(c.ult_compra, c.ult_venta) < now() - interval '365 days'
                       THEN 'sin_movimiento' END
           ], NULL) AS objeciones
      FROM ctx c
  `);

  await knex.raw('ALTER VIEW analytics.v_existencia_dictamen SET (security_invoker = true)');

  await knex.raw(`COMMENT ON VIEW analytics.v_existencia_dictamen IS
    'D.1 — Dictamen de existencia por producto x almacen: en que se apoya el numero (apoyo) y que lo contradice (objecion/objeciones). NO es la verdad del saldo: Kepler no guarda baseline (kdil.c4 = 0 en el 100%), asi que su existencia ES el flujo. REGLA DURA: qty_publicada es la que se AGREGA; qty_cruda se MUESTRA en la celda y NUNCA se suma — un saldo de -5,553 no es mercancia negativa que se pueda restar de un total, es al menos 5,553 unidades de movimiento sin registrar, de magnitud desconocida hacia arriba. La vista canonica v_erp_stock_on_hand NO se toca: clampa a cero y alimenta el pedido sugerido. Ver el ADR-056.'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_existencia_dictamen');
};
