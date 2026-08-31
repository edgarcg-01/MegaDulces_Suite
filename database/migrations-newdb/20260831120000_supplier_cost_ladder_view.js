/**
 * RA-PRO.46 — `analytics.v_supplier_cost_ladder`: la ESCALERA DE UNIDADES del costo, derivada de
 * `kepler_ods` (derivar-no-copiar, sin importer ni tabla espejo).
 *
 * Kepler no guarda "un" costo por producto: guarda hasta TRES peldaños, y el costo existe en cada
 * uno. El monto vive en `kdpv_prov_prod` (la pantalla "Costos por Proveedor por Productos"); el
 * ROTULO del peldaño, en el maestro `kdii`:
 *
 *     peldaño │ monto                 │ rótulo      │ 00303 cerillos │ 99029 azúcar
 *     ────────┼───────────────────────┼─────────────┼────────────────┼──────────────
 *     uni1    │ kdpv_prov_prod.c8     │ kdii.c11    │ PZA   $11.08   │ 500  $8.30
 *     uni2    │ kdpv_prov_prod.c9     │ kdii.c80    │ PAQ   $55.40   │ KG   $16.60
 *     uni3    │ kdpv_prov_prod.c10    │ kdii.c83    │ CJA  $553.97   │ BTO $415.00
 *
 * `c4` (Costo Uni Mayor) repite el peldaño más alto que esté lleno = el costo de UNA CAJA.
 *
 * POR QUE EXISTE ESTA VISTA: el plan calculaba `caja_cost = costo_unitario × bf`, pero el costo
 * unitario (lo que realmente pagamos, de `purchase_velocity`) NO siempre está en el mismo peldaño
 * que asume `bf`. En el azúcar 99029 lo pagado está en KG y `bf=50` es el factor 500g→costal:
 * multiplicar dos peldaños distintos daba $798.57 por un costal que cuesta $455 (+76%). Con la
 * escalera, el multiplicador correcto sale de los datos (`box_cost / peldaño`), no de `bf`.
 * Medido: 98.5% de los productos no cambian, 110 con el bug bajan >50%, −$520k de costo fantasma.
 *
 * Ver `docs/ERP_KEPLER.md` §2.1 y §5 regla 0 (nunca adivinar la fuente: probar la unidad).
 *
 * Agregación: MEDIANA entre sucursales (la escalera es igual en todas; la mediana absorbe capturas
 * sueltas). La sucursal Kepler '00' NO se excluye: acá el costo es del PROVEEDOR (mismo catálogo
 * replicado en las 7 — medianas $554.63–$555.56), no de valuación, así que no sesga.
 *
 * ⚠️ OJO CON EL NOMBRE: la sucursal Kepler '00' es **OFICINAS**, no el CEDIS. No vende (cero líneas
 * de mostrador U-D-10) y centraliza compra/tránsito/contabilidad. El **CEDIS real es BPIRAPUATO
 * (Irapuato) y vive en WINCAJA**, no en Kepler. El nombre "Cedis Oficinas" de nuestro almacén '00'
 * y los comentarios "CEDIS '00'" repartidos por los importers arrastran esa confusión. Ver
 * docs/ERP_KEPLER.md §2.3.
 */
exports.up = async function up(knex) {
  // Cómo se resolvió el costo de caja de cada fila. Se DECLARA, no se esconde:
  //   'escalera_ok'      → la escalera confirma el factor de caja (el 98.5% de los casos)
  //   'escalera_corrige' → la escalera y `bf` discrepan; manda la escalera (acá vivía el bug)
  //   'bf'               → el SKU no tiene escalera; se asume `bf` (puede mezclar peldaños)
  const hasCol = await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', 'cost_source');
  if (!hasCol) {
    await knex.schema.withSchema('analytics').alterTable('replenishment_plan', (t) => {
      t.text('cost_source');
    });
  }

  const hasSrc = await knex.schema.withSchema('kepler_ods').hasTable('kdpv_prov_prod');
  if (!hasSrc) {
    // Entorno sin ODS (dev local sin feeds): vista vacía tipada, para que los JOIN no exploten.
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.v_supplier_cost_ladder AS
      SELECT NULL::text AS sku, NULL::numeric AS box_cost,
             NULL::numeric AS u1_cost, NULL::numeric AS u2_cost, NULL::numeric AS u3_cost,
             NULL::text AS u1_label, NULL::text AS u2_label, NULL::text AS u3_label,
             NULL::numeric AS units_per_box, NULL::int AS sucursales
      WHERE false`);
    await knex.raw('GRANT SELECT ON analytics.v_supplier_cost_ladder TO app_runtime');
    return;
  }

  await knex.raw(`
    CREATE OR REPLACE VIEW analytics.v_supplier_cost_ladder AS
    WITH montos AS (
      SELECT btrim(c2::text) AS sku,
             NULLIF(c4::numeric,  0) AS box_cost,
             NULLIF(c8::numeric,  0) AS u1,
             NULLIF(c9::numeric,  0) AS u2,
             NULLIF(c10::numeric, 0) AS u3
        FROM kepler_ods.kdpv_prov_prod
       WHERE NULLIF(c4::numeric, 0) IS NOT NULL
         AND btrim(coalesce(c2::text, '')) <> ''
    ),
    agg AS (
      SELECT sku,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY box_cost) AS box_cost,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY u1)       AS u1_cost,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY u2)       AS u2_cost,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY u3)       AS u3_cost,
             count(*)::int                                          AS sucursales
        FROM montos GROUP BY sku
    ),
    -- Rótulos: se toma el MODO entre sucursales (son idénticos salvo captura suelta).
    rot AS (
      SELECT btrim(c1::text) AS sku,
             mode() WITHIN GROUP (ORDER BY NULLIF(btrim(c11::text), '')) AS u1_label,
             mode() WITHIN GROUP (ORDER BY NULLIF(btrim(c80::text), '')) AS u2_label,
             mode() WITHIN GROUP (ORDER BY NULLIF(btrim(c83::text), '')) AS u3_label
        FROM kepler_ods.kdii
       WHERE btrim(coalesce(c1::text, '')) <> ''
       GROUP BY 1
    )
    SELECT a.sku, a.box_cost, a.u1_cost, a.u2_cost, a.u3_cost,
           r.u1_label, r.u2_label, r.u3_label,
           -- Unidades del peldaño BASE por caja. Es el factor REAL del proveedor; sirve de
           -- cross-check independiente de analytics.v_product_box_factor (no lo reemplaza).
           CASE WHEN a.u1_cost > 0 THEN a.box_cost / a.u1_cost END AS units_per_box,
           a.sucursales
      FROM agg a
      LEFT JOIN rot r ON r.sku = a.sku`);

  await knex.raw('GRANT SELECT ON analytics.v_supplier_cost_ladder TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_supplier_cost_ladder IS
    'RA-PRO.46 — escalera de unidades del costo por SKU (montos kdpv_prov_prod.c4/c8/c9/c10 + rotulos kdii.c11/c80/c83). Resuelve en que peldano esta un costo unitario para convertirlo a costo de caja sin mezclar unidades. Ver docs/ERP_KEPLER.md 2.1'`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.v_supplier_cost_ladder');
  const hasCol = await knex.schema.withSchema('analytics').hasColumn('replenishment_plan', 'cost_source');
  if (hasCol) {
    await knex.schema.withSchema('analytics').alterTable('replenishment_plan', (t) => {
      t.dropColumn('cost_source');
    });
  }
};
