/**
 * [PQ.13] En los almacenes de Kepler, el factor de caja ES el de la ficha de Kepler (D20).
 *
 * El PM (2026-10-26): *«no quiero nada de información inventada o importada, necesito que
 * sigamos la misma fórmula de Kepler y que nos entregue los mismos resultados»* → *«necesito un
 * 100 %»*.
 *
 * ── Lo medido ANTES de escribir esto (prod, sólo lectura, `d20-medir3.js`/`d20-100.js`) ───────
 *
 * Árbitro: el `c58` (unidades por caja) de las órdenes de compra REALES de Kepler (`X-A-35`,
 * 90 días, 19,291 líneas con `c58`).
 *
 *   · 19,023 líneas (98.61 %) llevan EXACTAMENTE la etiqueta y el factor de la ficha del ERP
 *     (`kdii` de esa sucursal: `c80/c81` unidad dos, `c83/c84` unidad tres).
 *   · 162 (0.84 %) llevan el factor de la ficha con otra etiqueta (la ficha renombró la unidad
 *     base `PAQ`→`PZA` después de la OC; el factor es 1 en los dos lados).
 *   · 106 (0.55 %) se capturaron en una unidad que la ficha NO tiene (el comprador eligió `PZA`
 *     a 96 por caja en un producto cuya ficha dice `PAQ` 12 por caja). El costo de la línea
 *     cuadra con su propio `c58` en las 106: es una elección del comprador en Kepler, no un dato
 *     de producto. Ninguna ficha —ni la nuestra ni la de Kepler— las reproduce.
 *
 * O sea: **la fórmula de Kepler para una línea nueva es la ficha de esa sucursal**, y contra la
 * ficha el 100 % se alcanza POR CONSTRUCCIÓN leyéndola y nada más. Contra las líneas históricas
 * ningún catálogo pasa de 99.45 %; eso se declara (§12.3 del plan PQ) y no se persigue.
 *
 * ── Lo que cambia ─────────────────────────────────────────────────────────────────────────────
 *
 * `analytics.v_warehouse_box_factor` resolvía con esta precedencia para almacenes Kepler:
 *
 *     wincaja → v_product_box_factor (override > etiquetera > c84 agregado > factor_sale) →
 *     peldaño vendido → escalera de Kepler SOLO si todo lo anterior dio 1
 *
 * Ahora, para un almacén con `kepler_code`, **si la ficha de ESA sucursal tiene factor, manda la
 * ficha**; las demás fuentes sólo entran donde la ficha no dice nada (y conservan su nombre de
 * fuente, que es lo que las pantallas ya cuentan como «sin testigo de Kepler»). Wincaja no cambia.
 *
 * Medido contra `mv_warehouse_box_factor` (169,920 celdas de almacenes Kepler):
 *
 *     fuente previa   celdas   = ficha   ≠ ficha (cambian)   ficha sin factor (se quedan)
 *     etiquetera      78,645   46,995        119              0        (31,531 sin ficha)
 *     kepler_c84      38,160   22,723        136              0        (15,301 sin ficha)
 *     factor_sale     14,670      561        312            285
 *     override         3,975    1,926        299            160
 *     default         28,238        0          0          1,844
 *
 *   → **867 celdas cambian de valor (0.51 %)**; 2,289 quedan declaradas con su fuente previa
 *     porque la ficha no trae factor; 73,000 no tienen ficha en esa sucursal (SKU fuera de
 *     `kdii`) y no se tocan.
 *
 * ⚠️ `override` deja de ganarle a Kepler en 299 celdas. Es exactamente lo que pide la regla del
 * PM: el override queda como testigo donde Kepler calla, no como corrección de Kepler.
 *
 * ⚠️⚠️ **El cambio más grande no es un factor distinto: es un factor que pasa a 1.** 568 celdas
 * (281 `override` + 287 `factor_sale`) tenían una caja (>1) y la ficha de Kepler dice
 * `unidad_unica` —sin Unidad Dos ni Tres, sin costo superior—, que para Kepler ES un dato
 * (UN.2). Pasan a 1 con fuente `kepler_unidad_unica`. Si alguien capturó ese override porque la
 * ficha está incompleta, el lugar de corregirlo es la ficha de Kepler, no nuestra tabla.
 *
 * Cuerpo de la vista EJERCIDO en prod en sólo lectura con el texto exacto de este archivo
 * (`d20-despues.js`, 2026-10-26): 249,216 filas antes y después; las 867 celdas de arriba
 * cuadran una por una por fuente (10 + 116 + 18 + 18 + 281 + 287 + 109 + 20 + 7 + 1).
 * La migración en sí NO se ejecutó contra ninguna base (sin base de pruebas en la máquina).
 *
 * ── Qué NO hace ───────────────────────────────────────────────────────────────────────────────
 * No toca `v_product_box_factor` (7 dependientes, ADR-057) ni `v_unit_truth`. No agrega columnas
 * (el materializado `mv_warehouse_box_factor` fija su lista al crearse; sólo cambia lo que
 * devuelve al refrescar). El renglón que se ESCRIBE en Kepler (`c11`/`c55`/`c58`) es de KR.
 *
 * Idempotente: `CREATE OR REPLACE VIEW` con la misma lista de columnas. Al final refresca el
 * materializado (3 s medidos en EX-PERF.2) para que el número aterrice con la migración.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA = `
    CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS
    WITH wh AS (
      SELECT w.tenant_id, w.id, w.code, w.kepler_code, w.wincaja_source_branch
        FROM commercial.warehouses w
       WHERE w.deleted_at IS NULL
         AND (w.kepler_code IS NOT NULL OR w.wincaja_source_branch IS NOT NULL)
    ),
    wcf AS (
      SELECT w.tenant_id, w.id AS warehouse_id, a.articulo AS sku,
             a.factor_venta AS fv, a.unidad_venta AS unidad
        FROM wh w
        JOIN wincaja.articulos a
          ON a.tenant_id = w.tenant_id
         AND a.source_branch = w.wincaja_source_branch
         AND a.source_dataset = 'actual'
       WHERE w.kepler_code IS NULL
         AND (a.factor_venta > 1 OR (a.factor_venta = 1 AND btrim(upper(a.unidad_venta)) = 'CJA'))
    ),
    base AS (
      SELECT w.tenant_id, w.id AS warehouse_id, w.code AS warehouse_code, w.kepler_code,
             p.id AS product_id, p.sku,
             GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1), 1) AS f_previo,
             wcf.fv AS wcf_fv, wcf.unidad AS wcf_unidad,
             bfx.source AS bfx_source, bfx.is_weight, bfx.is_master_suspect,
             sr.rung_max,
             kul.factor_caja AS kul_factor, kul.factor_source AS kul_source,
             lad.u3_label AS lad_u3, lad.u1_label AS lad_u1
        FROM wh w
        JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
        LEFT JOIN analytics.v_product_box_factor bfx ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
        LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku::text
        LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku::text
        LEFT JOIN analytics.mv_kepler_sold_rung sr ON sr.sucursal = w.kepler_code AND sr.sku = p.sku::text
        LEFT JOIN analytics.v_kepler_unit_ladder kul ON kul.sucursal = w.kepler_code AND kul.sku = btrim(p.sku::text)
    )
    SELECT tenant_id, warehouse_id, warehouse_code, product_id, sku,
           CASE
             -- [PQ.13] D20: en un almacén de Kepler, si la ficha de esa sucursal tiene factor, manda la ficha.
             WHEN kepler_code IS NOT NULL AND kul_factor IS NOT NULL THEN GREATEST(kul_factor, 1)
             WHEN f_previo = 1 AND kepler_code IS NOT NULL AND rung_max > 1 THEN rung_max
             ELSE f_previo
           END AS box_factor,
           CASE
             WHEN kepler_code IS NOT NULL AND kul_factor IS NOT NULL THEN
               CASE kul_source
                 WHEN 'unidad_unica'                  THEN 'kepler_unidad_unica'
                 WHEN 'derivado_del_costo'            THEN 'kepler_ficha_costo'
                 WHEN 'capturado_contradice_al_costo' THEN 'kepler_ficha_contradice_costo'
                 ELSE 'kepler_ficha'
               END
             WHEN f_previo = 1 AND kepler_code IS NOT NULL AND rung_max > 1 THEN 'kepler_peldano_vendido'
             WHEN wcf_fv IS NOT NULL THEN 'wincaja_factor_venta'
             ELSE COALESCE(bfx_source, 'none')
           END AS factor_source,
           CASE WHEN kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
           lad_u3 AS box_label,
           COALESCE(wcf_unidad, lad_u1) AS base_label,
           COALESCE(is_weight, false) AS is_weight,
           COALESCE(is_master_suspect, false) AS is_master_suspect
      FROM base
`;

exports.VISTA = VISTA;

exports.up = async function up(knex) {
  const hay = await knex.raw(`SELECT to_regclass('analytics.v_warehouse_box_factor') AS v, to_regclass('analytics.v_kepler_unit_ladder') AS k`);
  if (!hay.rows[0].v || !hay.rows[0].k) {
    console.log('[PQ.13] sin v_warehouse_box_factor o sin v_kepler_unit_ladder: nada que cambiar en este entorno');
    return;
  }
  const antes = (await knex.raw(`
    SELECT factor_source, count(*)::int AS filas FROM analytics.v_warehouse_box_factor
     WHERE erp = 'kepler' GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('[PQ.13] ANTES (kepler):', antes.map((r) => `${r.factor_source} ${r.filas}`).join(' · '));

  await knex.raw(VISTA);
  await knex.raw('GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_warehouse_box_factor IS
    'Factor de caja por almacen. [PQ.13] D20 (2026-10-26): en almacenes de Kepler manda la ficha de ESA sucursal (v_kepler_unit_ladder, kdii c81/c84) cuando trae factor; las demas fuentes solo donde Kepler calla y conservan su nombre. Medido contra 19,291 lineas de OC reales: la ficha explica 98.61 % exacto y 99.45 % por factor; el resto son unidades elegidas a mano por el comprador en Kepler. Wincaja sin cambio.'`);

  const despues = (await knex.raw(`
    SELECT factor_source, count(*)::int AS filas FROM analytics.v_warehouse_box_factor
     WHERE erp = 'kepler' GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log('[PQ.13] DESPUÉS (kepler):', despues.map((r) => `${r.factor_source} ${r.filas}`).join(' · '));

  const mv = await knex.raw(`SELECT to_regclass('analytics.mv_warehouse_box_factor') AS t`);
  if (mv.rows[0].t) {
    const cambian = (await knex.raw(`
      SELECT count(*)::int AS n FROM analytics.mv_warehouse_box_factor m
        JOIN analytics.v_warehouse_box_factor v
          ON v.tenant_id = m.tenant_id AND v.warehouse_id = m.warehouse_id AND v.product_id = m.product_id
       WHERE v.box_factor IS DISTINCT FROM m.box_factor`)).rows[0].n;
    console.log(`[PQ.13] celdas cuyo factor cambia al refrescar el materializado: ${cambian}`);
    await knex.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_warehouse_box_factor`);
  }
};

exports.down = async function down() {
  // La definición previa vive en 20260915140000_warehouse_box_factor_usa_escalera_kepler.js.
  // No se revierte sola: cambiar un número hacia atrás también exige su antes/después.
};
