/**
 * Medidas de venta por producto — vista VIVA, DERIVE-NO-COPY.
 *
 * `analytics.product_units` expone, por producto, la ESCALERA de presentaciones
 * (PZA/PAQ/CJA/…) con su factor a la unidad base, derivada de `kepler_ods.kdii`
 * (c11=unidad base; c80/c81=alterna-1 nombre/factor; c83/c84=alterna-2). Es la
 * MISMA escalera validada que usa `analytics.product_volume_tiers` — acá se expone
 * cruda para que el app pueda ofrecer "pedir en pieza / paquete / caja".
 *
 * Prueba de unidad (verificada 2026-09-01, SKU 27031): precio_kdpv / factor colapsa
 * EXACTO al precio por unidad base (PZA $4.60 = PAQ $92/20 = CJA $460/100) → factores
 * y dirección correctos.
 *
 * El factor es "cuántas UNIDADES BASE entran en esa presentación": base=1, PAQ=f_alt1,
 * CJA=f_alt2. El app convierte la entrada del vendedor a base: base_qty = count*factor,
 * y el camino del dinero (`resolvePriceForQty`) sigue corriendo en unidad base.
 *
 * DEDUP sucursal: `mode()` sobre retail 01-06 (excluye CEDIS 00, cotiza/mide distinto),
 *   igual regla que `product_volume_tiers`. Single-tenant + GRANT app_runtime.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.product_units`);
  await knex.raw(`
    CREATE VIEW analytics.product_units AS
    WITH ladder AS (
      SELECT btrim(c1) AS sku,
             mode() WITHIN GROUP (ORDER BY btrim(c11)) AS u_base,
             mode() WITHIN GROUP (ORDER BY btrim(c80)) AS u_alt1,
             mode() WITHIN GROUP (ORDER BY c81::numeric) AS f_alt1,
             mode() WITHIN GROUP (ORDER BY btrim(c83)) AS u_alt2,
             mode() WITHIN GROUP (ORDER BY c84::numeric) AS f_alt2
        FROM kepler_ods.kdii WHERE btrim(sucursal) <> '00' GROUP BY 1
    )
    SELECT '${M}'::uuid AS tenant_id, p.id AS product_id,
           NULLIF(l.u_base, '') AS unit_base,
           NULLIF(l.u_alt1, '') AS unit_alt1, l.f_alt1,
           NULLIF(l.u_alt2, '') AS unit_alt2, l.f_alt2,
           now() AS computed_at
      FROM ladder l
      JOIN catalog.products p
        ON btrim(p.sku) = l.sku AND p.tenant_id = '${M}'::uuid AND p.deleted_at IS NULL
     WHERE NULLIF(l.u_base, '') IS NOT NULL`);
  await knex.raw('GRANT SELECT ON analytics.product_units TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.product_units`);
};
