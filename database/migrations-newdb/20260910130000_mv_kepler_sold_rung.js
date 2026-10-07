/**
 * KX.5 — EL PELDAÑO COBRADO, PERSISTIDO. Y con él se cierran los 2 inequívocos.
 *
 * Pedido de Edgar (2026-09-10): *"armalo"*, sobre el límite que quedó declarado en KX.4.
 *
 * ── Por qué hace falta materializar ─────────────────────────────────────────────────────────
 *
 * KX.4 cerró 33 de 41 contradicciones cambiando la precedencia, con costo cero. Quedaron 8, de
 * las cuales **2 son inequívocas**: `box_factor = 1` —o sea *"este producto no viene en caja"*—
 * contra un ERP que vendió bultos de **20**. Eso no admite lectura benigna.
 *
 * Y no se podían cerrar con lo que había:
 *
 *   · la cadena entera (`c84` / etiquetera / `factor_sale`) da **1** en los dos: son `default`;
 *   · **`analytics.sales_daily.rung_factor` dice `1.0000` en los 8** — el fact deduce el peldaño
 *     por PRECIO (`pickPriceTier`) y no lo ve, aunque el renglón de Kepler lo trae ESCRITO en
 *     `c58` con `c9 = c56 × c58` al **99.99%**;
 *   · y agregar `kdm2` dentro de una vista caliente cuesta **29.5 s** sobre 4M renglones, lo que
 *     mataría `v_product_box_factor` — que la leen la existencia, compras y el sell-out.
 *
 * Materializar por COSTO es legítimo (GOTCHAS §19). Lo que no es legítimo es materializar un
 * valor inventado: esto es un agregado directo del ODS, sin transformación.
 *
 * ── Grano y ventana, decididos a propósito ──────────────────────────────────────────────────
 *
 * Grano **sucursal × SKU**: el peldaño es local: la misma referencia se vende por pieza en una
 * plaza y por bulto en otra. Agregarlo a grano producto perdería eso (es la lección de ADR-055 y
 * la del `sin_metodo` que el grano grueso escondía 8×).
 *
 * Ventana **365 días**, y es una decisión con costo declarado: un divisor que se recalcula sobre
 * 90 días **cambia solo** cuando una plaza deja de vender el bulto por un trimestre, y un divisor
 * inestable es peor que uno viejo. A 365 días el peldaño sobrevive a la estacionalidad. ⚠️ El
 * costo es real y hay que decirlo: si dejan de vender ese bulto **más de un año**, el peldaño
 * desaparece y el factor vuelve a 1. Por eso la MV guarda `ultimo_visto`.
 *
 * ── La regla de uso: SÓLO donde es inequívoco ───────────────────────────────────────────────
 *
 * ⛔ El peldaño **NO se usa como factor de caja en general**, y es la trampa que este archivo
 * existe para no pisar: **un peldaño vendido mayor que la caja no prueba que la caja esté mal** —
 * prueba que existe una presentación mayor. Si la caja trae 6 y el ERP vendió un paquete de 12,
 * `bf = 6` es correcto. Medido: la mediana de `c58 / box_factor` es **0.0667 = 1/15** y en 15,587
 * de 19,787 pares el peldaño es MENOR, porque el mostrador vende piezas. Usarlo de frente
 * marcaría 15,587 pares sanos (el falso positivo de ADR-055, tercera vez que aparece).
 *
 * Así que el piso se aplica **sólo cuando el factor publicado es 1**: ahí "no hay caja" contra
 * "vendí bultos de 20" es una contradicción y no una convivencia. Los **6 ambiguos** (bf entre 6
 * y 20 con un peldaño mayor) **se siguen declarando**, no se tocan.
 *
 * ⚠️ Y sólo aplica a almacenes **Kepler**: la MV sale de `kdm2`. Wincaja no declara peldaño y su
 * NULL sigue declarado como hueco.
 *
 * ⚠️ `CREATE INDEX CONCURRENTLY` es una trampa en esta base (espera TODAS las transacciones más
 * viejas, incluso ajenas; una migración se sentó 575 s en `Lock/virtualxid`). Acá va el índice
 * normal, dentro de la migración.
 *
 * @param { import("knex").Knex } knex
 */

const MV = `
CREATE MATERIALIZED VIEW analytics.mv_kepler_sold_rung AS
SELECT d.sucursal,
       btrim(d.c8)                                              AS sku,
       max(NULLIF(btrim(d.c58::text), '')::numeric)             AS rung_max,
       mode() WITHIN GROUP (ORDER BY NULLIF(btrim(d.c58::text), '')::numeric) AS rung_modal,
       count(DISTINCT NULLIF(btrim(d.c58::text), '')::numeric)  AS peldanos,
       count(*)                                                 AS renglones,
       sum(d.c13::numeric)                                      AS importe,
       min(h.c9)::date                                          AS primer_visto,
       max(h.c9)::date                                          AS ultimo_visto
  FROM kepler_ods.kdm2 d
  JOIN kepler_ods.kdm1 h
    ON h.sucursal = d.sucursal AND h.c2 = d.c2 AND h.c3 = d.c3
   AND h.c4 = d.c4 AND h.c6 = d.c6
 WHERE d.c2 = 'U' AND d.c3 = 'D'
   AND btrim(d.c4::text) IN ('8','10','12')
   AND h.c9 >= current_date - 365
   AND d.sucursal = btrim(d.c1)
   AND NULLIF(btrim(d.c58::text), '')::numeric > 0
 GROUP BY 1, 2`;

// `v_warehouse_box_factor` con el piso. El grano de la MV (sucursal x SKU) coincide exactamente
// con el de esta vista (almacen x producto), asi que no hay que agregar nada de mas.
const VIEW = `
CREATE OR REPLACE VIEW analytics.v_warehouse_box_factor AS
WITH wh AS (
  SELECT tenant_id, id, code, kepler_code, wincaja_source_branch
    FROM commercial.warehouses
   WHERE deleted_at IS NULL
     AND (kepler_code IS NOT NULL OR wincaja_source_branch IS NOT NULL)
), wcf AS (
  SELECT w_1.tenant_id, w_1.id AS warehouse_id, a.articulo AS sku,
         a.factor_venta AS fv, a.unidad_venta AS unidad
    FROM wh w_1
    JOIN wincaja.articulos a
      ON a.tenant_id = w_1.tenant_id
     AND a.source_branch = w_1.wincaja_source_branch
     AND a.source_dataset = 'actual'
   WHERE w_1.kepler_code IS NULL
     AND (a.factor_venta > 1::numeric
          OR a.factor_venta = 1::numeric AND btrim(upper(a.unidad_venta)) = 'CJA')
)
SELECT w.tenant_id,
       w.id                        AS warehouse_id,
       w.code                      AS warehouse_code,
       p.id                        AS product_id,
       p.sku,
       -- KX.5: el piso del peldano vendido, SOLO cuando el factor publicado es 1. Ver la nota
       -- del encabezado: un peldano mayor que la caja no prueba que la caja este mal, salvo
       -- cuando la caja dice que NO EXISTE.
       CASE WHEN GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) = 1::numeric
                 AND w.kepler_code IS NOT NULL
                 AND sr.rung_max > 1::numeric
            THEN sr.rung_max
            ELSE GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric)
       END                         AS box_factor,
       CASE WHEN GREATEST(COALESCE(wcf.fv, bfx.box_factor, 1::numeric), 1::numeric) = 1::numeric
                 AND w.kepler_code IS NOT NULL
                 AND sr.rung_max > 1::numeric
            THEN 'kepler_peldano_vendido'
            WHEN wcf.fv IS NOT NULL THEN 'wincaja_factor_venta'
            ELSE COALESCE(bfx.source, 'none')
       END                         AS factor_source,
       CASE WHEN w.kepler_code IS NOT NULL THEN 'kepler' ELSE 'wincaja' END AS erp,
       lad.u3_label                AS box_label,
       COALESCE(wcf.unidad, lad.u1_label) AS base_label,
       COALESCE(bfx.is_weight, false)          AS is_weight,
       COALESCE(bfx.is_master_suspect, false)  AS is_master_suspect
  FROM wh w
  JOIN catalog.products p ON p.tenant_id = w.tenant_id AND p.deleted_at IS NULL
  LEFT JOIN analytics.v_product_box_factor bfx
         ON bfx.tenant_id = p.tenant_id AND bfx.product_id = p.id
  LEFT JOIN analytics.v_supplier_cost_ladder lad ON lad.sku = p.sku::text
  LEFT JOIN wcf ON wcf.warehouse_id = w.id AND wcf.sku = p.sku::text
  LEFT JOIN analytics.mv_kepler_sold_rung sr
         ON sr.sucursal = w.kepler_code AND sr.sku = p.sku::text`;

exports.up = async function up(knex) {
  const ya = (await knex.raw(`SELECT to_regclass('analytics.mv_kepler_sold_rung') t`)).rows[0].t;
  if (!ya) {
    const t0 = Date.now();
    await knex.raw(MV);
    // UNIQUE es requisito de REFRESH ... CONCURRENTLY. Sin CONCURRENTLY (ver el encabezado).
    await knex.raw(`CREATE UNIQUE INDEX mv_kepler_sold_rung_pk
                      ON analytics.mv_kepler_sold_rung (sucursal, sku)`);
    await knex.raw(`ANALYZE analytics.mv_kepler_sold_rung`);
    const n = (await knex.raw(`SELECT count(*)::int n, count(*) FILTER (WHERE rung_max > 1)::int mayor
                                 FROM analytics.mv_kepler_sold_rung`)).rows[0];
    console.log(`  [sold-rung] ${n.n} pares sucursal×SKU (${n.mayor} con peldaño > 1)`
      + ` en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  await knex.raw(`GRANT SELECT ON analytics.mv_kepler_sold_rung TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW analytics.mv_kepler_sold_rung IS
    'KX.5: el peldano COBRADO por sucursal x SKU (max kdm2.c58, ventana 365 d). Materializada por COSTO: el agregado cuesta ~30 s y no puede vivir dentro de una vista caliente. NO es el factor de caja: solo se usa como piso cuando el factor publicado es 1. Refresca AnalyticsRefreshService (job analytics_refresh_sold_rung).'`);

  // ── El antes/después de la cifra que se muestra ──
  const antes = (await knex.raw(
    `SELECT count(*)::int n FROM analytics.v_warehouse_box_factor
      WHERE factor_source = 'kepler_peldano_vendido'`)).rows[0].n
    .toString().replace('NaN', '0');

  await knex.raw(VIEW);
  await knex.raw(`GRANT SELECT ON analytics.v_warehouse_box_factor TO app_runtime`);

  const d = (await knex.raw(
    `SELECT count(*) FILTER (WHERE factor_source = 'kepler_peldano_vendido')::int piso,
            count(*)::int total
       FROM analytics.v_warehouse_box_factor`)).rows[0];
  console.log(`  [box-factor] con piso del peldaño vendido: ${antes} -> ${d.piso} de ${d.total} filas`);

  // ── Auto-verificación: tiene que MORDER, y morder POCO ──
  if (d.piso < 1) {
    throw new Error('el piso no aplicó a ninguna fila: la MV está vacía o el join no pega');
  }
  if (d.piso > 400) {
    throw new Error(`el piso aplicó a ${d.piso} filas: son muchas más que las esperadas — revisar antes de seguir`);
  }
  // Y NO puede tocar Wincaja: la MV es de Kepler.
  const win = (await knex.raw(
    `SELECT count(*)::int n FROM analytics.v_warehouse_box_factor
      WHERE factor_source = 'kepler_peldano_vendido' AND erp <> 'kepler'`)).rows[0].n;
  if (win > 0) throw new Error(`el piso tocó ${win} filas de Wincaja: la MV es de Kepler`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_kepler_sold_rung CASCADE`);
};
