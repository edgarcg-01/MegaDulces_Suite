'use strict';
/**
 * `[PQ.167]` **El post-mortem compara costo contra costo.** (Edgar, 2026-11-27: «arréglalos», tras el
 * análisis de fondo de los 509 arreglos de 30 días.)
 *
 * ── Qué estaba mal (medido en prod el 2026-11-27, sólo lectura) ─────────────────────────────────
 * `salido` sumaba `analytics.stock_movements.amount`, que en una VENTA es el PRECIO (mediana 1.307× el
 * costo de la unidad, 13,629 movimientos de 30 días) y en un TRASPASO es el COSTO (1.000×, 47,189).
 * `comprado` es el importe de la entrada: costo sin IVA. La `rotacion` (`salido / comprado`) y el
 * `veredicto` (nunca_salio / salio_poco / parcial / rindio) dividían precio entre costo: un producto
 * que se vendía salía «rindió» antes de rendir (hallazgo #1 de [PQ.161]).
 *
 * ── Qué cambia ──────────────────────────────────────────────────────────────────────────────────
 * Sólo la salida: `qty × caja_cost ÷ divisor nativo` del plan (el divisor de `stock_pz`, ADR-055), la
 * misma base que `comprado`. `vendido` y `traspasado` quedan como estaban (son su propio dato). Una
 * salida sin costo en el plan se cuenta en `salidas_sin_costo` y su renglón queda `sin_resolver`: no
 * se juzga lo que no se pudo valuar. Todo lo demás es la migración 20261009133029 tal cual.
 *
 * ⛔ Construirla tarda ~5 min (lo midió la original): FUERA DE HORARIO (CLAUDE.md regla 9).
 * `down` reconstruye la vista original llamando al `up` de 20261009133029.
 */

const VISTA = 'analytics.mv_purchase_postmortem';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${VISTA}`);
  await knex.raw(`
    CREATE MATERIALIZED VIEW ${VISTA} AS
    -- ⛔ Los CTE van MATERIALIZED a proposito. En Postgres 12+ un CTE referenciado UNA sola vez
    -- se INLINEA por default, y acá eso mete las dos vistas derivadas del ODS adentro del join:
    -- el planificador elige un nested loop y vuelve a derivar los renglones por cada recibo.
    -- Medido: con MATERIALIZED la construccion tarda ~5 min; sin la palabra se paso de 15 y hubo
    -- que cancelarla. La diferencia es UNA palabra y es el doble de un orden de magnitud.
    WITH rec AS MATERIALIZED (
      SELECT r.tenant_id, r.sucursal, r.folio, r.receipt_date,
             -- [DM.19] El destino REAL de la mercancia, no quien capturo el documento.
             COALESCE(r.origen_warehouse_id, r.warehouse_id) AS warehouse_id,
             r.origen_veredicto, r.proveedor_nombre, r.proveedor_rfc, r.referencia, r.oc_folio
        FROM analytics.erp_goods_receipts r
       WHERE r.receipt_date >= CURRENT_DATE - 180
         AND COALESCE(r.origen_warehouse_id, r.warehouse_id) IS NOT NULL
    ), lin AS MATERIALIZED (
      SELECT l.tenant_id, l.sucursal, l.folio, btrim(l.sku) AS sku, l.cantidad, l.unidad, l.importe
        FROM analytics.erp_goods_receipt_lines l
       -- SER = servicios, no mercancia: no tiene desempeno de producto que medir.
       WHERE l.unidad <> 'SER' AND l.importe > 0
    ), compras AS (
      SELECT r.tenant_id, r.warehouse_id, p.id AS product_id,
             sum(l.importe)                                         AS comprado,
             count(DISTINCT r.sucursal || '/' || r.folio)           AS n_recibos,
             max(r.receipt_date)                                    AS ultima_compra,
             min(r.receipt_date)                                    AS primera_compra,
             -- Lo que el documento NO alcanza a atribuir a una plaza. Se declara, no se reparte.
             sum(l.importe) FILTER (WHERE r.origen_veredicto = 'centro_no_dice_plaza') AS comprado_sin_resolver,
             (array_agg(r.proveedor_nombre ORDER BY r.receipt_date DESC))[1]           AS proveedor,
             (array_agg(r.proveedor_rfc    ORDER BY r.receipt_date DESC))[1]           AS proveedor_rfc
        FROM rec r
        JOIN lin l ON l.tenant_id = r.tenant_id AND l.sucursal = r.sucursal AND l.folio = r.folio
        JOIN catalog.products p ON p.tenant_id = r.tenant_id AND btrim(p.sku) = l.sku
       GROUP BY 1, 2, 3
    ), mov AS MATERIALIZED (
      -- [PQ.167] La SALIDA se valua AL COSTO (el de la caja del plan entre su divisor nativo), la misma
      -- base que lo comprado. Antes era m.amount, que en una venta es PRECIO (1.31x el costo, medido el
      -- 2026-11-27) y en un traspaso es costo: la rotacion y el veredicto dividian precio entre costo.
      -- Una salida cuyo producto no tiene costo en el plan no se valua: se cuenta en salidas_sin_costo.
      SELECT m.tenant_id, m.warehouse_id, m.product_id,
             sum(m.qty * rpc.caja_cost / GREATEST(COALESCE(rpc.display_bf, rpc.bf, 1), 1))
               FILTER (WHERE m.movement_kind = 'salida' AND rpc.caja_cost > 0)              AS salido,
             count(*) FILTER (WHERE m.movement_kind = 'salida' AND COALESCE(rpc.caja_cost, 0) <= 0) AS salidas_sin_costo,
             sum(m.amount) FILTER (WHERE m.movement_label IN ('Venta', 'Venta contado'))     AS vendido,
             sum(m.amount) FILTER (WHERE m.movement_label = 'Traspaso a sucursal')           AS traspasado,
             max(m.doc_date) FILTER (WHERE m.movement_kind = 'salida')                       AS ultima_salida
        FROM analytics.stock_movements m
        LEFT JOIN analytics.replenishment_plan rpc
               ON rpc.tenant_id = m.tenant_id AND rpc.warehouse_id = m.warehouse_id AND rpc.product_id = m.product_id
       WHERE m.doc_date >= CURRENT_DATE - 180
       GROUP BY 1, 2, 3
    ), stock AS MATERIALIZED (
      SELECT rp.tenant_id, rp.warehouse_id, rp.product_id,
             rp.stock_pz / NULLIF(COALESCE(rp.display_bf, rp.bf, 1), 0) * COALESCE(rp.caja_cost, 0) AS valor_hoy
        FROM analytics.replenishment_plan rp
       WHERE rp.stock_pz > 0
    )
    SELECT c.tenant_id,
           c.warehouse_id,
           c.product_id,
           w.code                                  AS warehouse_code,
           w.name                                  AS warehouse_name,
           (w.sells_to_public IS FALSE)            AS no_vende,
           p.sku,
           p.nombre,
           c.proveedor,
           c.proveedor_rfc,
           p.supplier_id,
           round(c.comprado::numeric, 2)                           AS comprado,
           round(COALESCE(c.comprado_sin_resolver, 0)::numeric, 2) AS comprado_sin_resolver,
           c.n_recibos,
           c.primera_compra,
           c.ultima_compra,
           (CURRENT_DATE - c.ultima_compra)                        AS dias_desde_compra,
           round(COALESCE(m.salido, 0)::numeric, 2)                AS salido,
           round(COALESCE(m.vendido, 0)::numeric, 2)               AS vendido,
           round(COALESCE(m.traspasado, 0)::numeric, 2)            AS traspasado,
           m.ultima_salida,
           round(COALESCE(s.valor_hoy, 0)::numeric, 2)             AS valor_hoy,
           -- Que tanto de lo comprado volvio a salir. >1 = el SKU movio mas de lo que se le compro
           -- en la ventana (habia existencia previa): NO es un error, es que rindio.
           CASE WHEN c.comprado > 0
                THEN round((COALESCE(m.salido, 0) / c.comprado)::numeric, 4) END AS rotacion,
           /*
            * El veredicto. Cinco estados, no tres: las dos AUSENCIAS no son la misma cosa y la
            * tercera ni siquiera es una ausencia.
            *   · sin_resolver  -> el documento no dice a que plaza iba. NO se puede juzgar.
            *   · nunca_salio   -> se compro y no salio ni una vez. Es el caso que Edgar busca.
            *   · salio_poco    -> salio menos de la mitad de lo que se compro.
            *   · rindio        -> salio al menos tanto como se compro.
            *   · parcial       -> entre la mitad y el total.
            */
           CASE
             WHEN COALESCE(c.comprado_sin_resolver, 0) >= c.comprado * 0.5 THEN 'sin_resolver'
             -- [PQ.167] Si salio mercancia que no se puede valuar, no se juzga: diria «nunca salio» de algo que salio.
             WHEN COALESCE(m.salidas_sin_costo, 0) > 0                     THEN 'sin_resolver'
             WHEN COALESCE(m.salido, 0) = 0                                THEN 'nunca_salio'
             WHEN COALESCE(m.salido, 0) < c.comprado * 0.5                 THEN 'salio_poco'
             WHEN COALESCE(m.salido, 0) < c.comprado                       THEN 'parcial'
             ELSE 'rindio'
           END AS veredicto,
           CURRENT_DATE AS computed_on
      FROM compras c
      JOIN commercial.warehouses w ON w.tenant_id = c.tenant_id AND w.id = c.warehouse_id
      JOIN catalog.products p      ON p.tenant_id = c.tenant_id AND p.id = c.product_id
      LEFT JOIN mov   m ON m.tenant_id = c.tenant_id AND m.warehouse_id = c.warehouse_id AND m.product_id = c.product_id
      LEFT JOIN stock s ON s.tenant_id = c.tenant_id AND s.warehouse_id = c.warehouse_id AND s.product_id = c.product_id
  `);

  // UNIQUE para poder refrescar CONCURRENTLY: si no, el REFRESH toma ACCESS EXCLUSIVE y la
  // pantalla se queda colgada mientras corre el nocturno.
  await knex.raw(`CREATE UNIQUE INDEX mv_purchase_postmortem_pk
                    ON ${VISTA} (tenant_id, warehouse_id, product_id)`);
  await knex.raw(`CREATE INDEX mv_purchase_postmortem_veredicto
                    ON ${VISTA} (tenant_id, veredicto)`);
  await knex.raw(`CREATE INDEX mv_purchase_postmortem_sup
                    ON ${VISTA} (tenant_id, supplier_id)`);

  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`).catch(() => { /* el rol puede no existir fuera de prod */ });

  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW ${VISTA} IS
      'RA.PM — autopsia de la compra: comprado vs lo que volvio a salir, por (almacen, producto), '
      'ventana de 180 dias. En PESOS porque las cantidades vienen en PAQ/PZA/KG mezclados. '
      'El almacen es el DESTINO resuelto (origen_warehouse_id), no quien capturo el documento. '
      'Refresco nocturno. El detalle y las cifras que la justifican estan en la migracion.'`);
};

/** Vuelve a la vista de 20261009133029 (con su salida a precio), tal cual. */
exports.down = async function down(knex) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await require('./20261009133029_postmortem_compras.js').up(knex);
};
