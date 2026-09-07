/**
 * [RR-PROMO.6] — `analytics.v_seller_sales_lines` deja de pagar el enriquecimiento que no usa.
 *
 * EL SÍNTOMA: la corrida del incentivo de Vidis (marca × 3 canales × 3 meses) reventó el
 * `statement_timeout` de 60 s en el API. Medido, la misma query oscila entre 4 s y 29 s
 * según la carga de prod — es cara y la varianza la empuja sobre el tope.
 *
 * LA CAUSA: el brazo de RUTA leía `analytics.v_route_sales_lines`, que es el contrato
 * ENRIQUECIDO del desglose por ticket (RR2): además de la venta trae, POR LÍNEA, la forma
 * de pago dominante del ticket (LATERAL sobre `pagos_dia` + `formas_pago`), el rótulo de
 * unidad (LATERAL sobre `articulos`), la hora y el tipo de documento. El incentivo **no usa
 * ninguna de esas columnas** y las estaba pagando igual: 10.0 s contra 3.0 s.
 *
 * LA CORRECCIÓN: el brazo de ruta se arma de las MISMAS fuentes que alimentan a
 * `v_route_sales_lines` —`wincaja.v_sales_lines` (`ruta_venta`) + `analytics.route_push_lines`—
 * sin los LATERAL de enriquecimiento. No es un universo distinto ni un atajo: es el mismo
 * dato sin las columnas que este consumidor no lee.
 *
 * VERIFICADO CONTRA PROD (jun–ago 2026), que es lo único que hace legítimo el cambio:
 *
 *     v_route_sales_lines sin VEC-PH-H  →  202,484 filas · $19,178,719.50 · 9,992 ms
 *     wincaja ruta + route_push_lines   →  202,484 filas · $19,178,719.50 · 3,030 ms
 *
 * Idéntico al centavo, 3.3× más rápido. El tramo 3 (`VEC-PH-H`, vecinal histórico) no se
 * replica **a propósito**: esta vista ya lo excluía del canal `ruta` para no contarlo dos
 * veces, porque el vecinal se toma completo de Wincaja (ver RR-PROMO.2).
 *
 * Ojo al mantenerla: si `v_route_sales_lines` cambia el UNIVERSO de la venta de ruta (no su
 * enriquecimiento), hay que reflejarlo acá. El candado del smoke compara las dos y truena.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_seller_sales_lines AS
    -- ── RD tramo 1: venta a bordo Wincaja (lo mismo que el tramo 1 de v_route_sales_lines) ──
    SELECT vl.tenant_id, vl.business_date, vl.sku, vl.product_id,
           vl.qty, vl.importe, vl.consecutivo, vl.cliente,
           'ruta'::text                       AS canal,
           vl.source_branch                   AS vendedor,
           'ruta'::text                       AS vendedor_origen,
           vl.source_branch                   AS route_no,
           CASE WHEN vl.qty <> 0 THEN vl.importe / vl.qty END AS precio_unitario,
           vl.source_branch                   AS source_branch
      FROM wincaja.v_sales_lines vl
     WHERE vl.sale_channel = 'ruta_venta'

    UNION ALL

    -- ── RD tramo 2: push de camionetas + vecinal Kepler (tramo 2 de v_route_sales_lines) ──
    SELECT rpl.tenant_id, rpl.business_date, rpl.sku, pr.id AS product_id,
           rpl.qty, rpl.importe, rpl.folio AS consecutivo, rpl.cliente,
           'ruta'::text                       AS canal,
           rpl.route_no                       AS vendedor,
           'ruta'::text                       AS vendedor_origen,
           rpl.route_no                       AS route_no,
           COALESCE(rpl.precio_unitario,
                    CASE WHEN rpl.qty <> 0 THEN rpl.importe / rpl.qty END) AS precio_unitario,
           rpl.route_no                       AS source_branch
      FROM analytics.route_push_lines rpl
      LEFT JOIN catalog.products pr
        ON pr.tenant_id = rpl.tenant_id AND btrim(pr.sku) = btrim(rpl.sku) AND pr.deleted_at IS NULL

    UNION ALL

    -- ── Vecinal / mayoreo / mostrador: el POS trae vendedor. El vecinal COMPLETO va acá
    --    (por eso el canal ruta no replica el tramo VEC-PH-H: se contaría dos veces). ──
    SELECT vl.tenant_id, vl.business_date, vl.sku, vl.product_id,
           vl.qty, vl.importe, vl.consecutivo, vl.cliente,
           CASE vl.sale_channel
             WHEN 'preventa_vecinal' THEN 'vecinal'
             WHEN 'mayoreo_credito'  THEN 'mayoreo'
             ELSE 'mostrador' END             AS canal,
           COALESCE(NULLIF(btrim(vl.vendedor), ''), '(sin vendedor)') AS vendedor,
           'wincaja'::text                    AS vendedor_origen,
           NULL::text                         AS route_no,
           CASE WHEN vl.qty <> 0 THEN vl.importe / vl.qty END AS precio_unitario,
           vl.source_branch                   AS source_branch
      FROM wincaja.v_sales_lines vl
     WHERE vl.sale_channel IN ('preventa_vecinal', 'mayoreo_credito', 'mostrador')`);

  await knex.raw(`GRANT SELECT ON analytics.v_seller_sales_lines TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_seller_sales_lines IS
    'RR-PROMO.6 — venta atribuida a vendedor por canal, sin doble conteo y SIN el enriquecimiento por ticket (forma de pago/unidad/hora) que este consumidor no usa: mismo universo que v_route_sales_lines sin VEC-PH-H (202,484 filas y 19,178,719.50 identicos jun-ago 2026) en 3.0s en vez de 10.0s.'`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  // Vuelve a leer el brazo de ruta desde v_route_sales_lines (def. de RR-PROMO.4).
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_seller_sales_lines AS
    SELECT sl.tenant_id, sl.business_date, sl.sku, sl.product_id,
           sl.qty, sl.importe, sl.consecutivo, sl.cliente,
           'ruta'::text AS canal, sl.source_branch AS vendedor,
           'ruta'::text AS vendedor_origen, sl.source_branch AS route_no,
           CASE WHEN sl.qty <> 0 THEN sl.importe / sl.qty END AS precio_unitario,
           sl.source_branch AS source_branch
      FROM analytics.v_route_sales_lines sl
     WHERE sl.sale_channel = 'ruta_venta' AND sl.source_branch <> 'VEC-PH-H'
    UNION ALL
    SELECT vl.tenant_id, vl.business_date, vl.sku, vl.product_id,
           vl.qty, vl.importe, vl.consecutivo, vl.cliente,
           CASE vl.sale_channel WHEN 'preventa_vecinal' THEN 'vecinal'
             WHEN 'mayoreo_credito' THEN 'mayoreo' ELSE 'mostrador' END AS canal,
           COALESCE(NULLIF(btrim(vl.vendedor), ''), '(sin vendedor)') AS vendedor,
           'wincaja'::text AS vendedor_origen, NULL::text AS route_no,
           CASE WHEN vl.qty <> 0 THEN vl.importe / vl.qty END AS precio_unitario,
           vl.source_branch AS source_branch
      FROM wincaja.v_sales_lines vl
     WHERE vl.sale_channel IN ('preventa_vecinal', 'mayoreo_credito', 'mostrador')`);
  await knex.raw(`GRANT SELECT ON analytics.v_seller_sales_lines TO app_runtime`);
};
