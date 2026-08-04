/**
 * RA-PRO.38 — `analytics.v_product_box_factor`: RESOLVEDOR CANÓNICO ÚNICO del factor
 * de caja (piezas por caja) que TODOS los reportes deben leer (compras, sell-out,
 * salidas…). Antes cada uno derivaba con su propia precedencia (compras=c84,
 * sell-out=factor_sale, otros=etiquetera) → divergían y el mismo SKU mostraba cajas
 * distintas. Una sola vista = una sola verdad.
 *
 * Precedencia:  override manual > c84 (Kepler) > etiquetera > factor_sale > 1.
 * GUARDA ANTI-PALLET: si factor_sale>1 Y etiquetera>1 COINCIDEN en una caja interior
 * y c84 es ≥3× esa caja, c84 es probablemente el PALLET/maestra → se usa la caja
 * interior (evita subreportar cajas ×N). `is_master_suspect` marca los casos donde
 * c84 es un múltiplo grande de una caja interior conocida (para revisión humana).
 *
 * Granel/peso NO se resuelve aquí (el factor no aplica): cada reporte gatea
 * unit_kind='weight' por su cuenta (no divide a cajas).
 *
 * Vista (no materializada) → siempre viva, sin feed que se desfase. `c84` viene de
 * `analytics.product_box_factor` (feed import-box-factor.js). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_product_box_factor AS
    WITH src AS (
      SELECT p.tenant_id, p.id AS product_id,
             COALESCE(p.factor_sale, 1)::numeric AS fs,
             lbl.bs::numeric      AS etiq,
             kbf.box_factor::numeric AS c84,
             uov.box_factor::numeric AS ovr
        FROM catalog.products p
        LEFT JOIN (SELECT tenant_id, product_id, max(box_size) bs
                     FROM commercial.product_label_prices GROUP BY 1, 2) lbl
               ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
        LEFT JOIN analytics.product_box_factor kbf
               ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
        LEFT JOIN commercial.product_unit_overrides uov
               ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
       WHERE p.deleted_at IS NULL
    ), r AS (
      SELECT tenant_id, product_id, fs, etiq, c84, ovr,
             -- caja interior corroborada (fs y etiq de acuerdo, ambas > 1)
             (fs > 1 AND etiq > 1 AND fs = etiq) AS inner_ok,
             -- caja interior candidata (la mayor entre fs/etiq > 1)
             GREATEST(CASE WHEN fs > 1 THEN fs ELSE 1 END,
                      CASE WHEN etiq > 1 THEN etiq ELSE 1 END) AS inner_box
        FROM src
    )
    SELECT tenant_id, product_id,
      -- sospecha de pallet: c84 es múltiplo grande (≥3×) de una caja interior conocida
      (c84 > 1 AND inner_box > 1 AND c84 >= 3 * inner_box) AS is_master_suspect,
      GREATEST(COALESCE(
        ovr,                                                      -- 1. override manual (humano)
        CASE
          WHEN inner_ok AND c84 >= 3 * fs THEN fs                 -- guarda anti-pallet → caja interior
          WHEN c84 > 1  THEN c84                                  -- 2. Kepler c84 (ERP)
          WHEN etiq > 1 THEN etiq                                 -- 3. etiquetera
          WHEN fs   > 1 THEN fs                                   -- 4. factor_sale
          ELSE 1 END
      ), 1) AS box_factor,
      CASE
        WHEN ovr IS NOT NULL THEN 'override'
        WHEN inner_ok AND c84 >= 3 * fs THEN 'inner_box_guard'
        WHEN c84 > 1  THEN 'kepler_c84'
        WHEN etiq > 1 THEN 'etiquetera'
        WHEN fs   > 1 THEN 'factor_sale'
        ELSE 'default' END AS source
      FROM r`);
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_product_box_factor`);
};
