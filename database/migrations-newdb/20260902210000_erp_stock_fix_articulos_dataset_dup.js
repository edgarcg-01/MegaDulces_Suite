/**
 * ADR-052 — FIX: `analytics.v_erp_stock_on_hand` DUPLICABA la existencia de MD-30/MD-32.
 *
 * `wincaja.articulos` guarda DOS datasets por sucursal — `source_dataset = 'actual'` (15,512 arts)
 * y `'concentrada'` (15,334) — y el LEFT JOIN de la vista sólo empataba por
 * `(tenant, articulo, source_branch)`, sin filtrar el dataset. Cada fila de `wincaja.v_stock`
 * (que sí filtra `source_dataset='actual'`) se emparejaba con las DOS de `articulos`, y el
 * `SUM(v.existencia)` de la vista contaba la existencia **dos veces**.
 *
 * Medido: la vista servía razón **2.000** contra `commercial.stock` en MD-30 y MD-32 (sólo 3.6% y
 * 2.2% de los SKUs coincidían), mientras el CEDIS `00` daba 1.000 — porque `00` sólo tiene el
 * dataset `'actual'`, así que ahí el join nunca duplicó. Esa asimetría fue la pista.
 *
 * El error venía desde la migración original (20260902170000) y sobrevivió al gate estricto y al
 * revert de la conversión de unidad, porque en todas esas verificaciones comparé la vista contra
 * SÍ MISMA o contra la fuente fila-a-fila (donde cada fila individual sí coincide) — nunca contra
 * el TOTAL agregado de la copia. Recién apareció al preparar el paso 4, comparando
 * `qty_stock_units` vs `commercial.stock.quantity` y viendo una razón mediana de 2.000.
 *
 * LECCIÓN: un LEFT JOIN dentro de una vista que AGREGA no es inocuo — si el lado derecho tiene más
 * de una fila por clave, multiplica la métrica. Al escribir la vista hay que probar la cardinalidad
 * de CADA join (`count(*) / count(DISTINCT clave)`), no sólo que las columnas existan. Y al validar
 * un agregado, compararlo contra un total independiente, no fila-a-fila con su propia fuente.
 */
exports.up = async function up(knex) {
  const [{ ok }] = (await knex.raw(
    `SELECT to_regclass('analytics.v_erp_stock_on_hand') IS NOT NULL AS ok`)).rows;
  if (!ok) return;

  // Misma firma que la 20260902200000 — sólo se acota el join a `articulos`. CREATE OR REPLACE basta.
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand WITH (security_invoker = true) AS
    SELECT w.tenant_id,
           w.id                                          AS warehouse_id,
           w.code                                        AS warehouse_code,
           pr.id                                         AS product_id,
           pr.sku,
           GREATEST(SUM(k.c4 + k.c8 - k.c9), 0)::numeric AS qty_stock_units,
           GREATEST(COALESCE(MAX(bfx.box_factor), 1), 1)::numeric AS display_box_factor,
           'kepler'::text                                AS unit_source,
           'kepler_ods'::text                            AS source
      FROM kepler_ods.kdil k
      JOIN commercial.warehouses w
        ON w.kepler_code = k.sucursal
       AND w.kepler_code <> '00'
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = w.tenant_id
       AND pr.sku = btrim(k.c3)
       AND pr.deleted_at IS NULL
      LEFT JOIN analytics.v_product_box_factor bfx
        ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
     WHERE k.sucursal = k.c1
       AND btrim(k.c3) <> ALL (ARRAY['00001', '00002', '00022'])
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku

    UNION ALL

    -- WINCAJA: existencia en su UNIDAD DE VENTA nativa. NO se convierte (la demanda de estos
    -- almacenes viene en la misma unidad; ver mig 20260902200000).
    -- Sin backticks en estos comentarios: van dentro de un template literal de JS.
    SELECT w.tenant_id,
           w.id                                          AS warehouse_id,
           w.code                                        AS warehouse_code,
           pr.id                                         AS product_id,
           pr.sku,
           GREATEST(SUM(v.existencia), 0)::numeric       AS qty_stock_units,
           GREATEST(COALESCE(MAX(CASE WHEN a.factor_venta > 1 THEN a.factor_venta::numeric END),
                             MAX(bfx.box_factor), 1), 1)::numeric AS display_box_factor,
           CASE WHEN MAX(CASE WHEN a.factor_venta > 1 THEN 1 ELSE 0 END) = 1
                THEN 'wincaja_multipack' ELSE 'wincaja' END       AS unit_source,
           'wincaja'::text                               AS source
      FROM wincaja.v_stock v
      JOIN commercial.warehouses w
        ON w.tenant_id = v.tenant_id
       AND w.wincaja_source_branch = v.source_branch
       AND w.kepler_code IS NULL
       AND w.deleted_at IS NULL
      JOIN catalog.products pr
        ON pr.tenant_id = v.tenant_id
       AND pr.sku = v.sku
       AND pr.deleted_at IS NULL
      -- ⚠️ source_dataset='actual' ES OBLIGATORIO: wincaja.articulos guarda 'actual' Y
      -- 'concentrada' por sucursal, y sin este filtro cada fila de v_stock (que ya viene
      -- filtrada a 'actual') empareja con DOS de articulos => el SUM contaba la existencia
      -- DOS VECES en MD-30/MD-32. El CEDIS '00' no lo mostraba porque solo tiene 'actual'.
      LEFT JOIN wincaja.articulos a
        ON a.tenant_id = v.tenant_id
       AND a.articulo = v.sku
       AND a.source_branch = v.source_branch
       AND a.source_dataset = 'actual'
      LEFT JOIN analytics.v_product_box_factor bfx
        ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
     WHERE v.existencia IS NOT NULL
       AND v.warehouse_code NOT LIKE 'RUTA-%'
     GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`);

  await knex.raw('GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime');
};

exports.down = async function down() {
  // Sin rollback: volver atrás re-introduciría la duplicación de existencia en MD-30/MD-32.
};
