/**
 * [RR-PROMO.2] — `analytics.v_seller_sales_lines`: la venta atribuida a un VENDEDOR,
 * a través de los canales que participan en los incentivos, sin doble conteo.
 *
 * Nace de una mecánica real que el motor no podía contestar:
 *
 *     Proveedor: vidis · del 01/06/2026 al 31/08/2026
 *     Participan: vendedores de RD, vendedores de ruta vecinal y vendedores de mayoreo
 *     Dinámica: bono de $50 por cliente distinto al que se le venda $500 de Vidis
 *
 * Tres canales, una sola dimensión "vendedor". El problema es que **la venta con vendedor
 * vive en dos universos distintos** y se solapan:
 *
 *   · `analytics.v_route_sales_lines` — el universo AUTORITATIVO de ruta (venta a bordo
 *     Wincaja + push de camionetas Kepler + vecinal histórico PH).
 *   · `wincaja.v_sales_lines` — trae `vendedor` en los cuatro canales, pero NO cubre el push.
 *
 * ── Las dos decisiones de fondo, medidas contra prod (jun–ago 2026) ──────────────────────
 *
 * 1) **En RD la ruta ES el vendedor.** El push son $11,419,939 (58% del dinero de ruta) con
 *    `vendedor` en NULL al 100%: la fuente no lo trae. Pero en el tramo Wincaja, donde sí
 *    viene, el código de vendedor **coincide con el número de ruta** (ruta 27 → vendedor 27,
 *    321 → 321, 501 → 501). Por eso en el canal `ruta` la dimensión es `source_branch`: no es
 *    un apaño, es la misma identidad que usa el ERP. Sin esto, un incentivo de RD sólo vería
 *    el 42% de la venta.
 *
 * 2) **El vecinal se solapa.** `VEC-PH-H` dentro del universo de ruta es un re-etiquetado de
 *    `wincaja.v_sales_lines` (`preventa_vecinal`, sucursal 10, pre-cutover): las MISMAS
 *    2,628 líneas por $438,661 en jun–ago. Unir los dos universos a lo bruto las contaría
 *    dos veces. Acá el canal `ruta` **excluye `VEC-PH-H`** y el vecinal se toma completo de
 *    Wincaja ($3,906,001, del cual el universo de ruta sólo veía el 11%).
 *
 * ── Contrato ─────────────────────────────────────────────────────────────────────────────
 * Una fila por línea de venta. `canal` ∈ ruta | vecinal | mayoreo | mostrador — el filtro de
 * qué canales participan es de la MECÁNICA, no de la vista. `vendedor` es la dimensión de
 * pago ya resuelta; `vendedor_origen` dice de dónde salió ('ruta' = el número de ruta,
 * 'wincaja' = la columna del POS) para que nadie confunda las dos cosas.
 *
 * Deriva de dos vistas principales que ya existen — no re-deriva la venta ni copia filas.
 *
 * Idempotente (CREATE OR REPLACE). No crea tablas.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_seller_sales_lines AS
    -- ── RD / reparto: el universo autoritativo (push + venta a bordo) ──
    -- Excluye VEC-PH-H: eso es vecinal y se toma de Wincaja (ver nota 2 del encabezado).
    SELECT sl.tenant_id, sl.business_date, sl.sku, sl.product_id,
           sl.qty, sl.importe, sl.consecutivo, sl.cliente,
           'ruta'::text                       AS canal,
           sl.source_branch                   AS vendedor,
           'ruta'::text                       AS vendedor_origen,
           sl.source_branch                   AS route_no,
           CASE WHEN sl.qty <> 0 THEN sl.importe / sl.qty END AS precio_unitario
      FROM analytics.v_route_sales_lines sl
     WHERE sl.sale_channel = 'ruta_venta'
       AND sl.source_branch <> 'VEC-PH-H'

    UNION ALL

    -- ── Vecinal / preventa y mayoreo y mostrador: el POS sí trae vendedor ──
    SELECT vl.tenant_id, vl.business_date, vl.sku, vl.product_id,
           vl.qty, vl.importe, vl.consecutivo, vl.cliente,
           CASE vl.sale_channel
             WHEN 'preventa_vecinal' THEN 'vecinal'
             WHEN 'mayoreo_credito'  THEN 'mayoreo'
             ELSE 'mostrador' END             AS canal,
           COALESCE(NULLIF(btrim(vl.vendedor), ''), '(sin vendedor)') AS vendedor,
           'wincaja'::text                    AS vendedor_origen,
           NULL::text                         AS route_no,
           CASE WHEN vl.qty <> 0 THEN vl.importe / vl.qty END AS precio_unitario
      FROM wincaja.v_sales_lines vl
     WHERE vl.sale_channel IN ('preventa_vecinal', 'mayoreo_credito', 'mostrador')`);

  await knex.raw(`GRANT SELECT ON analytics.v_seller_sales_lines TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_seller_sales_lines IS
    'RR-PROMO.2 — venta atribuida a vendedor por canal (ruta/vecinal/mayoreo/mostrador) sin doble conteo. En RD la ruta ES el vendedor (el push no trae la columna y en Wincaja el codigo coincide con el numero de ruta); el vecinal se toma de Wincaja y se excluye VEC-PH-H del canal ruta para no contarlo dos veces.'`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_seller_sales_lines`);
};
