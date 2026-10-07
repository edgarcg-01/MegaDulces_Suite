/**
 * RR2.0 — Ampliar el contrato de la LÍNEA de venta de ruta para que
 * /comercial/ventas-por-ruta pueda desglosar el ticket (unidad, precio, margen,
 * hora, forma de pago) y no sólo importes agregados.
 *
 * Dos movimientos, deliberadamente separados por riesgo:
 *
 *  1) `wincaja.v_sales_lines` — SÓLO columnas passthrough de tablas que la vista YA
 *     tiene joineadas (`d.iva/ieps/descuento1/descuento2`, `m.hora`, `p.id`). Cero
 *     joins nuevos, cero cambios en el WHERE, columnas APPENDED al final ⇒
 *     `CREATE OR REPLACE` (no DROP: `v_sales_daily` depende de ella) y los totales
 *     de sell-out / Thot / RA / Command Center no se mueven ni un centavo.
 *
 *  2) `analytics.v_route_sales_lines` — acá SÍ va el enriquecimiento con joins
 *     (catálogo de unidades + forma de pago), porque está scopeada a las ~986k
 *     líneas de ruta y no al 1.4M de la maestra completa.
 *
 * DECODE VERIFICADO EN PROD (2026-08-31) — nada de esto se adivinó:
 *
 *  · `detalles_mov_almacen.unidad_venta` (valores '0'/'1') **NO es la unidad de venta**.
 *    602 SKUs se vendieron con ambos códigos: la razón precio_unitario(0)/precio_unitario(1)
 *    se pega a 1.00 en 562/602 (93%, mediana 1.00) y coincide con `factor_venta`
 *    (prom 17.6) en 0 casos y con 1/factor_venta en 0 casos ⇒ es un flag interno,
 *    ambos códigos operan sobre la MISMA unidad. Leerlo como unidad habría metido un
 *    error de ~17× (el bug de CANON.0.1). Por eso el rótulo sale de
 *    `wincaja.articulos.unidad_venta` (PZA/KGS/CJA/SER), que sí lo dice la fuente.
 *
 *  · `valor_costo` y `valor_venta` son montos EXTENDIDOS de la línea, no unitarios:
 *    Σcosto/Σventa da margen 13.0–16.1% por ruta (creíble); multiplicar por qty da
 *    −93% a −1,234% (absurdo). Verificado también en muestra (qty 3 · 89.80 = 3×29.93).
 *
 *  · `pagos_dia` se une por `maestro.documento`, NO por `consecutivo`:
 *    59,262/59,262 filas empatan con documento y 0 con consecutivo. Cobertura de
 *    tickets del año: 100% en las 13 rutas. 362 folios traen pago partido ⇒ LATERAL
 *    con ORDER BY pagado DESC LIMIT 1 = forma de pago DOMINANTE del ticket (no se
 *    multiplican las líneas).
 *
 *  · Los códigos de forma de pago DIFIEREN POR SUCURSAL (en suc 10 el '3' es Crédito;
 *    en la ruta 21 el '3' es Tarjeta) ⇒ se resuelve siempre por
 *    (source_branch, forma_pago) contra `wincaja.formas_pago`, nunca por código pelado.
 *
 *  · `descuento1/2`: poblados sólo en ~0.9% de las líneas y con valores ambiguos
 *    (3, 8, 5, … 48.51) — NO se verificó si son % o monto ⇒ se exponen CRUDOS y no
 *    se usan en ninguna aritmética ni se rotulan con símbolo. Pendiente de decode.
 *
 *  · `cantidad_auxiliar` = 0 en 986k/986k y `tipo_precio` = '1' constante ⇒ no se exponen.
 *
 * El push de las camionetas y las rutas vecinales NO traen costo/hora/IVA (el contrato
 * del push son 11 columnas). Por eso cada línea lleva `source`: la UI declara
 * "sin dato en la fuente" en vez de dibujar $0 (ver §3.6 de FASE_RR2).
 *
 * security_invoker=true en la vista de analytics: antes leía sólo de
 * `wincaja.v_sales_lines` (que ya es invoker) y quedaba segura por rebote. Ahora que
 * toca `wincaja.articulos/pagos_dia/formas_pago` directo, sin invoker correría como
 * el OWNER (postgres) y saltaría la RLS de esas tablas ⇒ hueco multi-tenant. Con
 * invoker la RLS aplica al rol que consulta (app_runtime ve sólo su tenant).
 *
 * @param { import("knex").Knex } knex
 */

const CUTOVER_VEC = '2026-06-28'; // PH migró de .mdb al push (mig 20260728120000)

exports.up = async function up(knex) {
  // ── 1) route_push_lines: unidad + precio por línea (ya vienen en mart.ventas) ──
  for (const [col, type] of [['unidad', 'text'], ['precio_unitario', 'numeric']]) {
    const has = await knex.schema.withSchema('analytics').hasColumn('route_push_lines', col);
    if (!has) await knex.raw(`ALTER TABLE analytics.route_push_lines ADD COLUMN ${col} ${type}`);
  }
  await knex.raw(`COMMENT ON COLUMN analytics.route_push_lines.unidad IS
    'RR2 — unidad de venta POR LÍNEA tal como la declara la fuente (mart.ventas.unidad / kdm2.c11): PAQ/PZA/KG/CJA/CUB/500/250/2KG/BTO. Passthrough, cero unidades inventadas.'`);
  await knex.raw(`COMMENT ON COLUMN analytics.route_push_lines.precio_unitario IS
    'RR2 — precio neto unitario de la línea (mart.ventas.precio_neto / kdm2.c12), en la unidad de la columna unidad.'`);

  // Índice para el lookup del rótulo de unidad por (tenant, sku) sin pasar por source_dataset.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_wcj_art_sku ON wincaja.articulos (tenant_id, articulo)`);

  // ── 2) wincaja.v_sales_lines: columnas passthrough APPENDED (sin joins nuevos) ──
  //     Idéntica a la def. de 20260805240000 salvo las 6 columnas del final.
  await knex.raw(`
    CREATE OR REPLACE VIEW wincaja.v_sales_lines WITH (security_invoker = true) AS
    WITH conc_dates AS (
      SELECT DISTINCT tenant_id, source_branch, wincaja.fecha_mx_date(fecha) AS d
      FROM wincaja.maestro_mov_almacen
      WHERE source_dataset = 'concentrada'
    )
    SELECT
      m.tenant_id,
      m.source_branch,
      b.warehouse_code,
      (b.kepler_code IS NULL)          AS wincaja_only,
      m.source_dataset,
      wincaja.fecha_mx_date(m.fecha)   AS business_date,
      d.articulo                       AS sku,
      (p.sku IS NOT NULL)              AS in_kepler_catalog,
      d.cantidad_regular               AS qty,
      d.valor_venta                    AS importe,
      d.valor_costo                    AS costo,
      m.consecutivo,
      d.documento                      AS doc_ref,
      m.vendedor,
      m.tercero                        AS cliente,
      m.caja,
      m.cajero,
      CASE WHEN b.is_route THEN 'ruta_venta'
           ELSE COALESCE(cc.channel, 'mostrador') END AS sale_channel,
      -- ── RR2.0: passthrough. Sin joins nuevos; el WHERE no cambia. ──
      p.id                             AS product_id,   -- llave para analytics.v_product_box_factor
      d.iva                            AS iva,
      d.ieps                           AS ieps,
      d.descuento1                     AS descuento1,   -- unidad NO verificada (%/monto): no operar
      d.descuento2                     AS descuento2,
      m.hora                           AS hora_raw      -- serial Access '1899-12-30THH:MM:SS'
    FROM wincaja.detalles_mov_almacen d
    JOIN wincaja.maestro_mov_almacen m
      ON  m.tenant_id     = d.tenant_id
      AND m.source_branch = d.source_branch
      AND m.source_dataset= d.source_dataset
      AND m.consecutivo   = d.consecutivo
    LEFT JOIN conc_dates cd
      ON cd.tenant_id = m.tenant_id AND cd.source_branch = m.source_branch AND cd.d = wincaja.fecha_mx_date(m.fecha)
    LEFT JOIN wincaja.branches b
      ON b.tenant_id = m.tenant_id AND b.source_branch = m.source_branch
    LEFT JOIN catalog.products p
      ON p.tenant_id = m.tenant_id AND p.sku = d.articulo AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT k.channel, k.es_venta
      FROM wincaja.caja_channels k
      WHERE k.tenant_id = m.tenant_id AND k.caja = m.caja
        AND k.source_branch IN (m.source_branch, '*')
      ORDER BY (k.source_branch = m.source_branch) DESC
      LIMIT 1
    ) cc ON true
    WHERE d.tipo = 'V'
      AND d.valor_venta < 10000000
      AND d.valor_venta >= 0
      AND COALESCE(d.cantidad_regular, 0) < 10000000
      AND COALESCE(m.cancelado, false) = false
      AND COALESCE(cc.es_venta, true) = true
      AND NOT EXISTS (
        SELECT 1 FROM wincaja.clientes cli
        WHERE cli.tenant_id = m.tenant_id AND cli.source_branch = m.source_branch
          AND cli.source_dataset = m.source_dataset AND cli.cliente = m.tercero
          AND cli.nombre ILIKE 'ALMAC%'
      )
      AND (
        m.source_dataset = 'concentrada'
        OR cd.d IS NULL
      )
  `);

  // ── 3) analytics.v_route_sales_lines: contrato enriquecido de 3 tramos ──
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_sales_lines`);
  await knex.raw(`
    CREATE VIEW analytics.v_route_sales_lines WITH (security_invoker = true) AS
    -- Tramo 1: venta a bordo Wincaja (.mdb por ruta). El único con costo/IVA/hora.
    SELECT
      sl.tenant_id, sl.source_branch, sl.sale_channel, sl.business_date,
      sl.sku, sl.qty, sl.importe, sl.consecutivo, sl.doc_ref, sl.cliente,
      'wincaja'::text                              AS source,
      NULL::text                                   AS producto,
      NULLIF(upper(btrim(a.unidad_venta)), '')     AS unidad,
      'catalogo'::text                             AS unidad_origen,
      CASE WHEN sl.qty <> 0 THEN sl.importe / sl.qty END AS precio_unitario,
      sl.costo, sl.iva, sl.ieps, sl.descuento1, sl.descuento2,
      substring(sl.hora_raw from 'T(\\d\\d:\\d\\d)') AS hora,
      CASE upper(left(btrim(sl.doc_ref), 1))
        WHEN 'T' THEN 'ticket' WHEN 'F' THEN 'factura' END AS doc_tipo,
      pay.forma_pago, pay.forma_pago_desc, pay.forma_pago_credito, pay.forma_pago_tarjeta,
      sl.vendedor, sl.cajero, sl.caja, sl.product_id
    FROM wincaja.v_sales_lines sl
    LEFT JOIN LATERAL (
      -- rótulo de unidad: manda el catálogo de la PROPIA ruta; si no lo tiene, cualquiera.
      SELECT ar.unidad_venta
      FROM wincaja.articulos ar
      WHERE ar.tenant_id = sl.tenant_id AND ar.articulo = sl.sku
      ORDER BY (ar.source_branch = sl.source_branch) DESC, ar.source_dataset DESC
      LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      -- forma de pago DOMINANTE del ticket (362 folios traen pago partido).
      SELECT pg.forma_pago,
             fp.descripcion     AS forma_pago_desc,
             fp.credito         AS forma_pago_credito,
             fp.tarjeta_credito AS forma_pago_tarjeta
      FROM wincaja.pagos_dia pg
      LEFT JOIN LATERAL (
        SELECT f.descripcion, f.credito, f.tarjeta_credito
        FROM wincaja.formas_pago f
        WHERE f.tenant_id = pg.tenant_id AND f.source_branch = pg.source_branch
          AND f.forma_pago = pg.forma_pago
        ORDER BY f.source_dataset DESC
        LIMIT 1
      ) fp ON true
      WHERE pg.tenant_id = sl.tenant_id AND pg.source_branch = sl.source_branch
        AND pg.folio = sl.doc_ref
      ORDER BY pg.pagado DESC NULLS LAST
      LIMIT 1
    ) pay ON true
    WHERE sl.sale_channel = 'ruta_venta'

    UNION ALL

    -- Tramo 2: push de camionetas (mart.ventas) + rutas vecinales Kepler (md.kdm1/kdm2).
    -- Trae unidad y precio POR LÍNEA; no trae costo/IVA/hora/forma de pago.
    SELECT
      rpl.tenant_id, rpl.route_no AS source_branch, 'ruta_venta'::text AS sale_channel,
      rpl.business_date, rpl.sku, rpl.qty, rpl.importe,
      rpl.folio AS consecutivo, rpl.folio AS doc_ref, rpl.cliente,
      'push'::text                                 AS source,
      rpl.producto,
      NULLIF(upper(btrim(rpl.unidad)), '')         AS unidad,
      'linea'::text                                AS unidad_origen,
      COALESCE(rpl.precio_unitario,
               CASE WHEN rpl.qty <> 0 THEN rpl.importe / rpl.qty END) AS precio_unitario,
      NULL::numeric AS costo, NULL::numeric AS iva, NULL::numeric AS ieps,
      NULL::numeric AS descuento1, NULL::numeric AS descuento2,
      NULL::text AS hora, NULL::text AS doc_tipo,
      NULL::text AS forma_pago, NULL::text AS forma_pago_desc,
      NULL::boolean AS forma_pago_credito, NULL::boolean AS forma_pago_tarjeta,
      NULL::text AS vendedor, NULL::text AS cajero, NULL::text AS caja,
      pr.id AS product_id
    FROM analytics.route_push_lines rpl
    LEFT JOIN catalog.products pr
      ON pr.tenant_id = rpl.tenant_id AND btrim(pr.sku) = btrim(rpl.sku) AND pr.deleted_at IS NULL

    UNION ALL

    -- Tramo 3: histórico vecinal PH en Wincaja (preventa_vecinal suc 10, pre-cutover).
    SELECT
      sl.tenant_id, 'VEC-PH-H'::text AS source_branch, 'ruta_venta'::text AS sale_channel,
      sl.business_date, sl.sku, sl.qty, sl.importe, sl.consecutivo, sl.doc_ref, sl.cliente,
      'wincaja'::text                              AS source,
      NULL::text                                   AS producto,
      NULLIF(upper(btrim(a.unidad_venta)), '')     AS unidad,
      'catalogo'::text                             AS unidad_origen,
      CASE WHEN sl.qty <> 0 THEN sl.importe / sl.qty END AS precio_unitario,
      sl.costo, sl.iva, sl.ieps, sl.descuento1, sl.descuento2,
      substring(sl.hora_raw from 'T(\\d\\d:\\d\\d)') AS hora,
      CASE upper(left(btrim(sl.doc_ref), 1))
        WHEN 'T' THEN 'ticket' WHEN 'F' THEN 'factura' END AS doc_tipo,
      NULL::text AS forma_pago, NULL::text AS forma_pago_desc,
      NULL::boolean AS forma_pago_credito, NULL::boolean AS forma_pago_tarjeta,
      sl.vendedor, sl.cajero, sl.caja, sl.product_id
    FROM wincaja.v_sales_lines sl
    LEFT JOIN LATERAL (
      SELECT ar.unidad_venta FROM wincaja.articulos ar
      WHERE ar.tenant_id = sl.tenant_id AND ar.articulo = sl.sku
      ORDER BY (ar.source_branch = sl.source_branch) DESC, ar.source_dataset DESC
      LIMIT 1
    ) a ON true
    WHERE sl.sale_channel = 'preventa_vecinal' AND sl.source_branch = '10'
      AND sl.business_date < DATE '${CUTOVER_VEC}'
  `);
  await knex.raw(`GRANT SELECT ON analytics.v_route_sales_lines TO app_runtime`);
};

exports.down = async function down(knex) {
  // Vuelve al contrato de 10 columnas (def. 20260728120000).
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_route_sales_lines`);
  await knex.raw(`
    CREATE VIEW analytics.v_route_sales_lines AS
      SELECT tenant_id, source_branch, sale_channel, business_date, sku, qty, importe,
             consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines
       WHERE sale_channel = 'ruta_venta'
      UNION ALL
      SELECT tenant_id, route_no AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe, folio AS consecutivo, folio AS doc_ref, cliente
        FROM analytics.route_push_lines
      UNION ALL
      SELECT tenant_id, 'VEC-PH-H'::text AS source_branch, 'ruta_venta'::text AS sale_channel,
             business_date, sku, qty, importe, consecutivo, doc_ref, cliente
        FROM wincaja.v_sales_lines
       WHERE sale_channel = 'preventa_vecinal' AND source_branch = '10'
         AND business_date < DATE '${CUTOVER_VEC}'`);
  await knex.raw(`GRANT SELECT ON analytics.v_route_sales_lines TO app_runtime`);
  // `wincaja.v_sales_lines` se deja con las columnas extra: son aditivas e inertes, y
  // quitarlas requeriría DROP CASCADE de v_sales_daily (regla: no destructivo en down).
  await knex.raw(`DROP INDEX IF EXISTS wincaja.ix_wcj_art_sku`);
};
