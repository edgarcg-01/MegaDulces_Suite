/**
 * `[NORM.3]` `analytics.v_product_box_factor` pasa a leer la vista CONSOLIDADA de etiquetas.
 *
 * ── Por qué hace falta, y por qué es urgente ────────────────────────────────────────────────
 * La vista resuelve el factor de caja canónico y se alimenta, entre otros testigos, de
 * `commercial.product_label_prices.box_size`, así:
 *
 *     LEFT JOIN (SELECT tenant_id, product_id, MAX(box_size) AS bs
 *                  FROM commercial.product_label_prices GROUP BY tenant_id, product_id) lbl
 *
 * Mientras la tabla tenía UNA fila por producto, ese `MAX` era **el valor**. Con el grano por
 * sucursal que introduce `20260911240000`, pasa a ser **el máximo entre ocho plazas** — y el
 * factor de unidad SÍ varía por plaza: medido en prod el 2026-09-11, **793 SKUs tienen `c81`
 * (piezas por paquete) distinto entre tiendas y 795 tienen `c84` (piezas por caja) distinto**.
 *
 * O sea: sin esta migración, el grano por plaza le cambiaría el factor canónico a ~795 SKUs sin
 * que nadie lo pidiera, y de ahí cuelgan **33 objetos** en prod (planes de compra, demanda,
 * valuación). Sería exactamente el defecto de ADR-055 otra vez: un divisor que cambia solo.
 *
 * ── Qué cambia, exactamente ─────────────────────────────────────────────────────────────────
 * Una sola palabra: `product_label_prices` → `v_product_label_prices`. La vista consolidada
 * devuelve la MISMA fila que la moda elegía hasta hoy, así que el `MAX` vuelve a ser sobre una
 * sola fila y el resultado es idéntico al de antes del cambio de grano. Todo lo demás —la
 * escalera de `kdii`, las guardas anti-pallet, `is_master_suspect`, el orden de las columnas— se
 * copia verbatim.
 *
 * ⚠️ `CREATE OR REPLACE VIEW` sólo admite AGREGAR columnas al final: el orden y los tipos de las
 * que ya existen NO se tocan, o Postgres rechaza el reemplazo (y con 33 dependientes un `DROP
 * CASCADE` no es opción).
 *
 * ⚠️ El `GRANT` se re-aplica: no se hereda al reemplazar la vista.
 *
 * ⛔ NO se puede hacer editando `20260829190000_v_product_box_factor_unit_aware.js`: es una
 * migración ya aplicada. Va en una nueva.
 *
 * @param { import("knex").Knex } knex
 */

const CUERPO = `
    CREATE OR REPLACE VIEW analytics.v_product_box_factor AS
    WITH ladder AS (
      -- La escalera del ERP. Excluye CEDIS '00' (trae valuación de prueba) y
      -- consolida con MAX: c84 es estable entre sucursales (3 de 2,419 = 0.12%).
      SELECT c1 AS sku,
             MAX(NULLIF(btrim(c11), '')) AS u_base,
             MAX(c81)                    AS f_paq,
             MAX(c84)                    AS f_caja
        FROM kepler_ods.kdii
       WHERE sucursal <> '00'
       GROUP BY c1
    ), src AS (
      SELECT p.tenant_id, p.id AS product_id,
             COALESCE(p.factor_sale, 1)::numeric AS fs,
             lbl.bs::numeric                     AS etiq,
             kbf.box_factor::numeric             AS c84,
             uov.box_factor::numeric             AS ovr,
             -- Unidad base real del ERP. Los valores que son CANTIDADES y no
             -- unidades ('500', '250', '400', '2KG'…) se anulan: es más honesto
             -- no saber la unidad que afirmar una que no existe.
             CASE WHEN upper(l.u_base) ~ '^[A-Z]{2,4}$' THEN upper(l.u_base) END AS unit_base
        FROM catalog.products p
        -- [NORM.3] LA vista consolidada, no la tabla: la tabla tiene grano por sucursal y este
        -- MAX() tomaría el mayor de ocho plazas (793/795 SKUs tienen factor distinto entre ellas).
        LEFT JOIN (SELECT tenant_id, product_id, MAX(box_size) AS bs
                     FROM commercial.v_product_label_prices
                    GROUP BY tenant_id, product_id) lbl
               ON lbl.tenant_id = p.tenant_id AND lbl.product_id = p.id
        LEFT JOIN analytics.product_box_factor kbf
               ON kbf.tenant_id = p.tenant_id AND kbf.product_id = p.id
        LEFT JOIN commercial.product_unit_overrides uov
               ON uov.tenant_id = p.tenant_id AND uov.product_id = p.id AND uov.deleted_at IS NULL
        LEFT JOIN ladder l ON l.sku = p.sku
       WHERE p.deleted_at IS NULL
    ), r AS (
      SELECT src.*,
             src.fs > 1 AND src.etiq > 1 AND src.fs = src.etiq AS inner_ok,
             GREATEST(CASE WHEN src.fs   > 1 THEN src.fs   ELSE 1 END,
                      CASE WHEN src.etiq > 1 THEN src.etiq ELSE 1 END) AS inner_box,
             src.unit_base IN ('KG', 'KGS') AS is_weight
        FROM src
    ), resolved AS (
      SELECT r.*,
             GREATEST(COALESCE(ovr,
               CASE WHEN inner_ok AND c84 >= 3 * fs THEN fs
                    WHEN c84  > 1 THEN c84
                    WHEN etiq > 1 THEN etiq
                    WHEN fs   > 1 THEN fs
                    ELSE 1 END), 1) AS box_factor,
             CASE WHEN ovr IS NOT NULL THEN 'override'
                  WHEN inner_ok AND c84 >= 3 * fs THEN 'inner_box_guard'
                  WHEN c84  > 1 THEN 'kepler_c84'
                  WHEN etiq > 1 THEN 'etiquetera'
                  WHEN fs   > 1 THEN 'factor_sale'
                  ELSE 'default' END AS source
        FROM r
    )
    SELECT tenant_id, product_id,
           COALESCE(
             (c84 > 1 AND inner_box > 1 AND c84 >= 3 * inner_box)
             OR (is_weight AND box_factor > 1)
             OR box_factor > 1000
             OR (source = 'factor_sale' AND box_factor > 1)
           , FALSE) AS is_master_suspect,
           box_factor, source,
           unit_base, is_weight,
           CASE WHEN source IN ('factor_sale', 'inner_box_guard') THEN 'ambiguous'
                WHEN box_factor > 1 THEN 'pieces'
                ELSE 'n/a' END AS factor_unit
      FROM resolved`;

exports.up = async function up(knex) {
  await knex.raw(CUERPO);
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);
  console.log('[NORM.3] v_product_box_factor lee commercial.v_product_label_prices (consolidada).');
};

exports.down = async function down(knex) {
  // Vuelve a apuntar a la tabla. ⚠️ Sólo es correcto si el grano por sucursal también se revirtió
  // (`20260911240000` down); si no, este `MAX` toma el mayor entre plazas.
  await knex.raw(CUERPO.replace('commercial.v_product_label_prices', 'commercial.product_label_prices'));
  await knex.raw(`GRANT SELECT ON analytics.v_product_box_factor TO app_runtime`);
};
