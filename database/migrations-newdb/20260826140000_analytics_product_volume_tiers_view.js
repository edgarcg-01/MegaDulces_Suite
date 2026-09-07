/**
 * Fix #2 mayoreo — vista VIVA de quiebres por cantidad, DERIVE-NO-COPY.
 *
 * `analytics.product_volume_tiers` deriva el mayoreo REAL de Kepler desde
 * `kepler_ods.kdpv_prod_util` (c7=precio por tier, c4=mínimo, c2=presentación,
 * c3=tier) convertido a unidad base con la escalera de `kdii` (c11 base;
 * c80/c81 y c83/c84 alternas). Sin tabla, sin importer → hereda la frescura del
 * CDC (~seg). Reemplaza las listas P1-P4/MAYOREO congeladas (fuente externa
 * `catalogo_etiquetas`, freeze 2026-08-16) que subcotizaban.
 *
 * Por qué vista y no tabla: ninguna FK apunta a `commercial.product_prices`
 * (las órdenes snapshotean `unit_price` en `order_lines`), y precio/min/unidad
 * son 100% derivables del ODS. La identidad SKU→uuid la aporta `catalog.products`
 * (que sí necesita su importer `sync-product-master`, ya corriendo).
 *
 * DEDUP sucursal: `mode()` de retail 01-06 (el CEDIS 00 cotiza mayoreo más alto),
 *   CEDIS solo como fallback para combos ausentes en retail. Misma regla que
 *   `import-volume-tiers.js` y `repoint-catalog-prices`.
 * UNIDAD: `precio_base = c7/factor`, `min_base = c4*factor`. El ~6.5% de combos
 *   sin equivalencia de unidad se DESCARTAN (no se adivinan).
 * SEGURIDAD DE COBRO: solo se emiten tiers con `min_qty>1 AND price < BASE-MXN`
 *   → cada fila es un descuento real. Elimina los ~108 SKUs con conversión
 *   inflada (nunca podrían sobrecobrar: quedan fuera de la vista). BASE (min1)
 *   sigue de ancla en `product_prices`; `resolvePriceForQty` toma
 *   min(BASE ∪ vista) con `min_qty <= qty`.
 *
 * Mismo patrón de vista viva single-tenant que `analytics.erp_sales_invoices`
 * (mig 20260822140000): tenant hardcodeado, GRANT SELECT a app_runtime.
 */

const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.product_volume_tiers`);
  await knex.raw(`
    CREATE VIEW analytics.product_volume_tiers AS
    WITH ladder AS (
      SELECT btrim(c1) AS sku,
             mode() WITHIN GROUP (ORDER BY btrim(c11)) AS u_base,
             mode() WITHIN GROUP (ORDER BY btrim(c80)) AS u_alt1,
             mode() WITHIN GROUP (ORDER BY c81::numeric) AS f_alt1,
             mode() WITHIN GROUP (ORDER BY btrim(c83)) AS u_alt2,
             mode() WITHIN GROUP (ORDER BY c84::numeric) AS f_alt2
        FROM kepler_ods.kdii WHERE btrim(sucursal) <> '00' GROUP BY 1
    ), retail AS (
      SELECT btrim(c1) AS sku, btrim(c2) AS present, c3::int AS tier,
             mode() WITHIN GROUP (ORDER BY c7::numeric) AS price,
             mode() WITHIN GROUP (ORDER BY c4::numeric) AS min_qty
        FROM kepler_ods.kdpv_prod_util WHERE btrim(sucursal) <> '00' GROUP BY 1,2,3
    ), cedis AS (
      SELECT btrim(c1) AS sku, btrim(c2) AS present, c3::int AS tier,
             c7::numeric AS price, c4::numeric AS min_qty
        FROM kepler_ods.kdpv_prod_util WHERE btrim(sucursal) = '00'
    ), src AS (
      SELECT sku, present, tier, price, min_qty FROM retail
      UNION ALL
      SELECT k.sku, k.present, k.tier, k.price, k.min_qty FROM cedis k
       WHERE NOT EXISTS (SELECT 1 FROM retail r
                          WHERE r.sku = k.sku AND r.present = k.present AND r.tier = k.tier)
    ), conv AS (
      SELECT s.*,
             CASE WHEN s.present = l.u_base                  THEN 1
                  WHEN s.present = l.u_alt1 AND l.f_alt1 > 0 THEN l.f_alt1
                  WHEN s.present = l.u_alt2 AND l.f_alt2 > 0 THEN l.f_alt2 END AS factor
        FROM src s JOIN ladder l ON l.sku = s.sku
    ), unit AS (
      SELECT p.id AS product_id,
             GREATEST(1, round(v.min_qty * v.factor))::int AS min_qty,
             round((v.price / v.factor)::numeric, 4) AS price
        FROM conv v
        JOIN catalog.products p
          ON btrim(p.sku) = v.sku AND p.tenant_id = '${M}'::uuid AND p.deleted_at IS NULL
       WHERE v.factor IS NOT NULL AND v.factor > 0 AND v.price > 0
    ), dedup AS (
      SELECT product_id, min_qty, min(price) AS price FROM unit GROUP BY 1, 2
    )
    SELECT '${M}'::uuid AS tenant_id, d.product_id, d.min_qty, d.price, now() AS computed_at
      FROM dedup d
      JOIN commercial.product_prices bp
        ON bp.product_id = d.product_id AND bp.tenant_id = '${M}'::uuid
       AND bp.deleted_at IS NULL AND bp.min_qty = 1 AND bp.price > 0
      JOIN commercial.price_lists pl
        ON pl.id = bp.price_list_id AND pl.tenant_id = '${M}'::uuid AND pl.code = 'BASE-MXN'
     WHERE d.min_qty > 1 AND d.price < bp.price`);
  await knex.raw('GRANT SELECT ON analytics.product_volume_tiers TO app_runtime');
};

exports.down = async function down(knex) {
  await knex.raw('DROP VIEW IF EXISTS analytics.product_volume_tiers');
};
