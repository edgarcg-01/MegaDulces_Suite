/* eslint-disable */
/**
 * `[IC.CEDIS.6]` — **El CEDIS vuelve a tener existencia en pantalla.** Reporte de Edgar:
 * *"/compras/existencia no muestra las existencias en CEDIS"*.
 *
 * ── ⛔ ES UNA REGRESIÓN QUE INTRODUJE YO, AYER ──────────────────────────────────────────────────
 * `analytics.v_erp_stock_on_hand` tiene dos piernas y el almacén `00` se cayó de LAS DOS:
 *   · Kepler : `JOIN ... ON w.kepler_code = k.sucursal AND w.kepler_code <> '00'`  ← exclusión a mano
 *   · Wincaja: `JOIN ... ON w.wincaja_source_branch = v.source_branch AND w.kepler_code IS NULL`
 * El `<> '00'` se escribió cuando se creía que Kepler `00` era **OFICINAS**. Mientras el CEDIS
 * tenía `kepler_code` en NULL caía en la pierna Wincaja y se veía. La mig `20260930140000`
 * (batch 644) le puso `kepler_code='00'` para cerrar la compuerta del feed — y con eso lo sacó
 * de la pierna Wincaja sin meterlo en la de Kepler. **Quedó invisible.**
 *
 * ── LA PREMISA QUE SOSTENÍA LA EXCLUSIÓN ESTÁ REFUTADA, Y ESO ES LO QUE CAMBIA ─────────────────
 * «La 00 de Kepler es OFICINAS y no mueve mercancía» es falso. Medido en prod el 2026-10-01 sobre
 * `kdm1`⋈`kdm2` de `sucursal='00' AND c1='00'`:
 *
 *     mes      docs entrada   docs salida   SKUs
 *     2026-04       2,371           713     2,718
 *     2026-06       2,092           893     3,174
 *     2026-08       2,189         1,568     2,873
 *
 * Recibe y despacha mercancía **todos los meses desde al menos abril**, sobre ~2,900 SKUs. O sea
 * que el CEDIS no «se mudó» a Kepler el 30-sep: **se FUSIONÓ con un almacén que ya existía y ya
 * operaba**. Excluirlo era la anomalía.
 *
 * ── Y EL «35.82× INFLADO» TAMBIÉN ESTÁ REFUTADO ────────────────────────────────────────────────
 * Lo afirmé tres veces y estaba mal: mi consulta leía el SKU en `kdm2.c3`, y el SKU es **`c8`**
 * (`docs/ERP_KEPLER.md` §regla 2). Con la columna correcta, al grano SKU:
 *   · 127 SKUs contados en el `N-A-45`  → `kdil` = **340,077 u = exactamente lo contado (1.00×)**
 *   · 4,526 SKUs sin conteo             → 11,841,613 u, que es el stock que el almacén YA tenía
 *   ·   0 SKUs contados sin saldo
 * La carga cuadra a la unidad. No hay nada que corregir en Kepler. (La compuerta
 * `check-cedis-cutover.js` ya lo había medido y dejado escrito; esta migración lo confirma.)
 *
 * ── POR QUÉ SE PUBLICA COMPLETO Y NO SÓLO LO CONTADO ───────────────────────────────────────────
 * Se consideró publicar sólo los 127 SKUs con testigo físico y declarar el resto (ADR-056). Se
 * descartó **midiendo**: el total NO está concentrado en unas pocas filas basura — los **10 SKUs
 * más grandes son el 9.0%** del total, o sea que está repartido entre miles. Un almacén que
 * recibe 2,000 documentos al mes y cuyo volumen está repartido es un almacén, no un artefacto.
 * Esconderlo es peor que publicarlo: hoy el comprador decide a ciegas sobre el nodo que SURTE
 * A LA RED.
 *
 * ⛔ **HUECO DECLARADO, con número** (ver `docs/VERDAD_ABSOLUTA.md` §17): Kepler tiene DOS
 * columnas de existencia y **se contradicen en las OCHO sucursales**, no sólo en el CEDIS —
 * `kdil` (`c4+c8−c9`, la que publicamos en todos lados) contra `kdik.c6` (que no consume nadie):
 * razones de **0.09× a 5.45×** y ~99% de los SKUs distintos en cada rama. Un testigo que
 * contradice SIEMPRE no arbitra, así que no se usa para juzgar al CEDIS. Esta migración publica
 * el CEDIS **con la misma regla que las otras ocho**: si `kdil` está mal, está mal para todas, y
 * eso es una fase aparte — no un motivo para dejar un almacén en blanco.
 *
 * ⚠️ `security_invoker` y los GRANT **se re-aplican**: un `CREATE OR REPLACE VIEW` NO los hereda
 * (ADR-057 ya perdió uno así, y sólo lo cazó la aserción de metadata del candado).
 */
const SQL = `
CREATE OR REPLACE VIEW analytics.v_erp_stock_on_hand AS
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(k.c4 + k.c8 - k.c9), 0::double precision)::numeric AS qty_stock_units,
    GREATEST(COALESCE(max(bfx.box_factor), 1::numeric), 1::numeric) AS display_box_factor,
    'kepler'::text AS unit_source,
    'kepler_ods'::text AS source
   FROM kepler_ods.kdil k
     JOIN commercial.warehouses w
       ON w.kepler_code = k.sucursal AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = w.tenant_id AND pr.sku::text = btrim(k.c3) AND pr.deleted_at IS NULL
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE k.sucursal = k.c1
    AND (btrim(k.c3) <> ALL (ARRAY['00001'::text, '00002'::text, '00022'::text]))
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku
UNION ALL
 SELECT w.tenant_id,
    w.id AS warehouse_id,
    w.code AS warehouse_code,
    pr.id AS product_id,
    pr.sku,
    GREATEST(sum(v.existencia), 0::numeric) AS qty_stock_units,
    GREATEST(COALESCE(max(CASE WHEN a.factor_venta > 1::numeric THEN a.factor_venta
                               ELSE NULL::numeric END), max(bfx.box_factor), 1::numeric),
             1::numeric) AS display_box_factor,
    CASE WHEN max(CASE WHEN a.factor_venta > 1::numeric THEN 1 ELSE 0 END) = 1
         THEN 'wincaja_multipack'::text ELSE 'wincaja'::text END AS unit_source,
    'wincaja'::text AS source
   FROM wincaja.v_stock v
     JOIN commercial.warehouses w
       ON w.tenant_id = v.tenant_id AND w.wincaja_source_branch = v.source_branch
      AND w.kepler_code IS NULL AND w.deleted_at IS NULL
     JOIN catalog.products pr
       ON pr.tenant_id = v.tenant_id AND pr.sku::text = v.sku AND pr.deleted_at IS NULL
     LEFT JOIN wincaja.articulos a
       ON a.tenant_id = v.tenant_id AND a.articulo = v.sku
      AND a.source_branch = v.source_branch AND a.source_dataset = 'actual'::text
     LEFT JOIN analytics.v_product_box_factor bfx
       ON bfx.tenant_id = pr.tenant_id AND bfx.product_id = pr.id
  WHERE v.existencia IS NOT NULL AND v.warehouse_code NOT LIKE 'RUTA-%'
  GROUP BY w.tenant_id, w.id, w.code, pr.id, pr.sku`;

exports.up = async function up(knex) {
  await knex.raw(SQL);
  // ⚠️ No se heredan en un CREATE OR REPLACE. Se re-aplican SIEMPRE, no "si hace falta".
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_on_hand SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO dev_ro`);
};

exports.down = async function down(knex) {
  // Vuelve a excluir el almacén 00 de la pierna Kepler (el estado previo al 2026-10-01).
  await knex.raw(SQL.replace(
    `ON w.kepler_code = k.sucursal AND w.deleted_at IS NULL`,
    `ON w.kepler_code = k.sucursal AND w.kepler_code <> '00'::text AND w.deleted_at IS NULL`));
  await knex.raw(`ALTER VIEW analytics.v_erp_stock_on_hand SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO app_runtime`);
  await knex.raw(`GRANT SELECT ON analytics.v_erp_stock_on_hand TO dev_ro`);
};
