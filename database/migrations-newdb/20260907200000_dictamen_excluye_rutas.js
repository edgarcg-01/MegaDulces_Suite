/**
 * D.1 fix — el dictamen se separó de la vista canónica, y su candado no podía verlo.
 *
 * ── Qué pasó ───────────────────────────────────────────────────────────────────────────────
 * La mig 20260907130000 (U.6) llenó `commercial.warehouses.wincaja_source_branch` en 7 almacenes
 * `RUTA-*` para cerrar el hueco de cobertura del resolvedor de unidad. Efecto no previsto: el CTE
 * `win` de `analytics.v_existencia_dictamen` une por esa misma columna, así que esos 7 almacenes
 * de CAMIONETA entraron al dictamen. Pasó de **52,421 a 122,117 celdas** (16 almacenes).
 *
 * La vista canónica `analytics.v_erp_stock_on_hand` NO los tiene, y a propósito: su pierna de
 * Wincaja termina en `AND v.warehouse_code NOT LIKE 'RUTA-%'`. El stock de una camioneta no es
 * stock de bodega para efectos de reabasto, y alguien ya lo había decidido.
 *
 * Eso rompe la promesa central del dictamen — *"la EXPLICA, no la reemplaza"*. Si el dictamen
 * publica 122,117 celdas y la canónica 52,553, hay dos verdades del inventario.
 *
 * ── ⚠️ Y por qué el candado no lo atrapó ───────────────────────────────────────────────────
 * `test-newdb-existencia-dictamen.js` afirmaba "el dictamen cubre el mismo universo que la
 * canónica" comparando `count(*)` del **JOIN** contra `count(*)` de la canónica. El JOIN sólo
 * empareja los almacenes que están en LAS DOS, así que da 52,553 = 52,553 y pasa en verde
 * mientras el dictamen tiene 69,564 filas de más.
 *
 * Es una aserción de **un solo lado**: probaba `canónica ⊆ dictamen` y se leía como igualdad.
 * La lección, que ya apareció tres veces en esta fase con otra cara: **una comparación que sólo
 * mira la intersección no puede ver lo que sobra.** El candado se corrige junto con esto para
 * contar los DOS lados.
 *
 * ── El fix ─────────────────────────────────────────────────────────────────────────────────
 * Mismo filtro que la canónica en el CTE `win`. No se toca nada más de la vista.
 *
 * ⚠️ Se usa `CREATE OR REPLACE VIEW` (no DROP): el dictamen YA tiene consumidores desde el batch
 * 281 y un DROP revienta con 0A000 si alguien lo tiene en un plan cacheado. Por eso el orden de
 * las columnas no cambia — `CREATE OR REPLACE` sólo admite agregar al final.
 *
 * ⚠️ Y se re-aplica `security_invoker` explícitamente: es la regla que salió de U.7, donde un
 * `CREATE OR REPLACE VIEW` se llevó la reloption y la vista dejó de filtrar por tenant.
 *
 * SIN BACKTICKS en los comentarios SQL: van dentro de un template literal de JS.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_existencia_dictamen AS
    WITH conteos AS (
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
         -- ⭐ MISMO recorte que analytics.v_erp_stock_on_hand. El stock de una CAMIONETA no es
         -- stock de bodega, y el dictamen EXPLICA a la canonica: si publicara almacenes que ella
         -- no tiene, habria dos verdades del inventario. Entraron solos cuando U.6 mapeo
         -- wincaja_source_branch en 7 rutas (52,421 -> 122,117 celdas).
         AND w.code NOT LIKE 'RUTA-%'
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

  // Regla de U.7: CREATE OR REPLACE no hereda la reloption ni el grant.
  await knex.raw('ALTER VIEW analytics.v_existencia_dictamen SET (security_invoker = true)');
  await knex.raw('GRANT SELECT ON analytics.v_existencia_dictamen TO app_runtime');

  // Auto-verificacion: el dictamen tiene que cubrir EXACTAMENTE el universo de la canonica.
  const r = await knex.raw(`
    SELECT (SELECT count(*) FROM analytics.v_existencia_dictamen) AS dictamen,
           (SELECT count(*) FROM analytics.v_erp_stock_on_hand)   AS canonica`);
  const { dictamen, canonica } = r.rows[0];
  console.log(`  dictamen=${dictamen} canonica=${canonica}`);
  if (String(dictamen) !== String(canonica)) {
    throw new Error(`el dictamen sigue divergiendo: ${dictamen} vs ${canonica}`);
  }
};

exports.down = async function down() {
  // No-op: revertir seria volver a publicar dos universos de inventario.
};
