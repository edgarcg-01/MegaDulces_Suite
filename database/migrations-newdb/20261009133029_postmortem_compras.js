'use strict';
/**
 * `[RA.PM]` — **La autopsia de la compra: qué pedimos que no rindió.**
 *
 * Pedido de Edgar (2026-10-09): *"ya tenemos las ordenes de compra o las compras desde contpaq o
 * fiscales. hay que comparar eso con pedidos que se hayan quedado en stock o no hayan rendido como
 * se pensaba, para aprender esos pedidos y no volverlos a repetir"*.
 *
 * ── Lo medido antes de escribirla (sólo lectura, contra prod, 2026-10-09) ────────────────────
 *
 * ⛔ **Lo FISCAL no puede ser la espina, y eso cambia el pedido.** Cuatro mediciones:
 *   1. `fiscal.cfdis` (428,435 filas; 141,996 recibidas tipo I) **no tiene renglones**: no existe
 *      tabla de conceptos, el detalle vive en el XML y trae el código del PROVEEDOR, no nuestro
 *      SKU. Sin SKU no hay autopsia por producto.
 *   2. Sólo **6,210 de 12,977 recibos (47.9%)** traen RFC del proveedor.
 *   3. La `referencia` del recibo la **teclea a mano** quien captura: `F-18852`, `10-8853`,
 *      `0-F8803`, `R-F-4679`, y una que dice `LPA`. Casa con el folio del CFDI **41 veces de
 *      6,210 (1.1%)**.
 *   4. Por IMPORTE sí casa: **1,641 únicos (26.4%)**, con placebo —el mismo cruce contra OTRO
 *      proveedor— en **97 (1.6%)**, o sea que el cruce identifica de verdad. Aflojar la tolerancia
 *      a 0.5% sólo suma 17% más, así que el 70% que falta **no es tolerancia ni IVA**
 *      (contra `subtotal` casa 152 contra 1,819: `monto` es el total CON impuesto).
 *
 * ⇒ La espina es **`analytics.erp_goods_receipt_lines`** (99,586 renglones con SKU, cantidad y
 *   costo). El CFDI se engancha donde se puede y se DECLARA la cobertura.
 *
 * ⛔ **Dos trampas más, las dos medidas:**
 *   · `unidad = 'SER'` son **2,108 renglones por $108,253,686**: servicios, no mercancía. Fuera.
 *   · Las cantidades vienen en **PAQ (63,998) · PZA (26,769) · KG (5,232)** y hasta gramajes
 *     crudos (`500`, `250`). Sumarlas daría un número que no está en ninguna unidad. ⭐ Por eso
 *     **la autopsia se mide en PESOS**, que es lo único conmensurable (ADR-059: el dinero arbitra).
 *
 * ⭐⭐ **Y el hallazgo que reformula todo:** `warehouse_id` y `origen_warehouse_id` difieren en
 *   **5,693 de 7,242 recibos (79%)**, $200 M de $344 M — el `00` capturaba compras destinadas a
 *   otras plazas (Fase DM.19 / PO). Midiendo con `warehouse_id` salía que el 78% de la compra
 *   entra por el CEDIS y que el 82% "nunca vendió". Con `origen_warehouse_id`:
 *
 *   | destino | pares | comprado | salió | nunca salió |
 *   |---|---:|---:|---:|---:|
 *   | sucursales que venden | 11,818 | $166,855,583 | $218,742,642 | 2,039 · **$3,407,973** |
 *   | CEDIS | 2,669 | $142,253,390 | $54,736,982 | 441 · **$4,435,816** |
 *
 * ⚠️ **El CEDIS no vende, traspasa**: su "rindió" se mide contra la SALIDA (traspaso a sucursal),
 * no contra la venta. Medido: 111,700 traspasos con importe en 180 d, sólo 33 sin él.
 *
 * ⚠️ **$66,378,636 quedan `sin_resolver`** (`origen_veredicto = 'centro_no_dice_plaza'`): el
 * documento no dice a qué plaza iba. Se DECLARA por fila, nunca se reparte a ojo (ADR-056).
 *
 * ── Por qué MATVISTA y no vista ─────────────────────────────────────────────────────────────
 * La ventana es de 180 dias, no 365: a 365 la construccion se pasa de 10 min. La consulta
 * equivalente tarda **4 min 54 s** contra prod: cruza dos vistas derivadas del ODS
 * (`erp_goods_receipts` ⋈ `erp_goods_receipt_lines`) y las dos se re-derivan. El piso de esta casa
 * son 500 ms. Se refresca de noche, con umbral en `CRON_JOBS` (si no, `db-health` da verde
 * incondicional — lo midió la Fase VP).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
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
      SELECT m.tenant_id, m.warehouse_id, m.product_id,
             sum(m.amount) FILTER (WHERE m.movement_kind = 'salida')                        AS salido,
             sum(m.amount) FILTER (WHERE m.movement_label IN ('Venta', 'Venta contado'))     AS vendido,
             sum(m.amount) FILTER (WHERE m.movement_label = 'Traspaso a sucursal')           AS traspasado,
             max(m.doc_date) FILTER (WHERE m.movement_kind = 'salida')                       AS ultima_salida
        FROM analytics.stock_movements m
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

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${VISTA}`);
};
