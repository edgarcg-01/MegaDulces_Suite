'use strict';
/**
 * `[VEX.8]` (segunda parte) — `analytics.product_volume_tiers`: el costo y el dedup como CTE
 * MATERIALIZED, para que el filtro «no publicar mayoreo bajo costo» deje de ser un nested loop.
 *
 * POR QUÉ: `20261106142200` quitó el anti-join del CEDIS (11.7 s → 0.25 s en ese nodo), pero ya
 * aplicada la vista tardó 3.6–4.4 s, no 1.4 s: aquella medición fue con `count(*)` y la consulta del
 * catálogo pide columnas con ORDER BY (corregido aquí). EXPLAIN ANALYZE en prod: el
 * `LEFT JOIN costo c ON c.sku = d.sku` de `defendible` corre como Nested Loop Left Join
 * (8,271 × 9,554 por texto) y se lleva ~4.8 s; el planificador estima muy pocas filas de `dedup`.
 *
 * El cambio: `dedup` y `costo` pasan a `AS MATERIALIZED`. Nada más cambia.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-06, la consulta del catálogo con ORDER BY) ──
 *  · Actual 4.0–4.4 s (8.1 s en una corrida con carga); con MATERIALIZED 1.25–1.7 s (5 corridas alternadas).
 *  · 7,702 filas en ambas; `EXCEPT ALL` en los dos sentidos sobre (product_id, min_qty, price): 0 y 0.
 *  · ACL: postgres=arwdDxtm, app_runtime=r, dev_ro=r. CREATE OR REPLACE VIEW la conserva.
 *
 * Idempotente (CREATE OR REPLACE con las mismas columnas).
 *
 * @param { import("knex").Knex } knex
 */

const NUEVA = `WITH ladder AS (
         SELECT btrim(k.c1) AS sku,
            mode() WITHIN GROUP (ORDER BY (btrim(k.c11))) AS u_base,
            mode() WITHIN GROUP (ORDER BY (btrim(k.c80))) AS u_alt1,
            mode() WITHIN GROUP (ORDER BY k.c81) AS f_alt1,
            mode() WITHIN GROUP (ORDER BY (btrim(k.c83))) AS u_alt2,
            mode() WITHIN GROUP (ORDER BY k.c84) AS f_alt2
           FROM kepler_ods.kdii k
          WHERE btrim(k.sucursal) <> '00'::text
          GROUP BY (btrim(k.c1))
        ), retail AS (
         SELECT btrim(p.c1) AS sku,
            btrim(p.c2) AS present,
            p.c3::integer AS tier,
            mode() WITHIN GROUP (ORDER BY p.c7) AS price,
            mode() WITHIN GROUP (ORDER BY p.c4) AS min_qty
           FROM kepler_ods.kdpv_prod_util p
          WHERE btrim(p.sucursal) <> '00'::text AND p.c3::integer = 0
          GROUP BY (btrim(p.c1)), (btrim(p.c2)), (p.c3::integer)
        ), cedis AS (
         SELECT btrim(p.c1) AS sku,
            btrim(p.c2) AS present,
            p.c3::integer AS tier,
            p.c7 AS price,
            p.c4 AS min_qty
           FROM kepler_ods.kdpv_prod_util p
          WHERE btrim(p.sucursal) = '00'::text AND p.c3::integer = 0
        ), src AS (
         SELECT DISTINCT ON (x.sku, x.present, x.tier) x.sku,
            x.present,
            x.tier,
            x.price,
            x.min_qty
           FROM ( SELECT retail.sku,
                    retail.present,
                    retail.tier,
                    retail.price,
                    retail.min_qty,
                    0 AS prioridad
                   FROM retail
                UNION ALL
                 SELECT cedis.sku,
                    cedis.present,
                    cedis.tier,
                    cedis.price,
                    cedis.min_qty,
                    1 AS prioridad
                   FROM cedis) x
          ORDER BY x.sku, x.present, x.tier, x.prioridad
        ), conv AS (
         SELECT s.sku,
            s.present,
            s.price,
            s.min_qty,
                CASE
                    WHEN s.present = l.u_base THEN 1::numeric
                    WHEN s.present = l.u_alt1 AND l.f_alt1 > 0::numeric THEN l.f_alt1
                    WHEN s.present = l.u_alt2 AND l.f_alt2 > 0::numeric THEN l.f_alt2
                    ELSE NULL::numeric
                END AS factor
           FROM src s
             JOIN ladder l ON l.sku = s.sku
        ), unit AS (
         SELECT p.id AS product_id,
            btrim(p.sku::text) AS sku,
            GREATEST(1::numeric, round(v.min_qty * v.factor))::integer AS min_qty,
            round(v.price / v.factor, 4) AS price
           FROM conv v
             JOIN catalog.products p ON btrim(p.sku::text) = v.sku AND p.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND p.deleted_at IS NULL
          WHERE v.factor IS NOT NULL AND v.factor > 0::numeric AND v.price > 0::numeric
        ), dedup AS MATERIALIZED (
         SELECT unit.product_id,
            unit.sku,
            unit.min_qty,
            min(unit.price) AS price
           FROM unit
          GROUP BY unit.product_id, unit.sku, unit.min_qty
        ), costo AS MATERIALIZED (
         SELECT btrim(v_kepler_standard_cost.sku) AS sku,
            max(v_kepler_standard_cost.costo_estandar) AS costo
           FROM analytics.v_kepler_standard_cost
          WHERE v_kepler_standard_cost.costo_estandar > 0::numeric
          GROUP BY (btrim(v_kepler_standard_cost.sku))
        ), defendible AS (
         SELECT d.product_id,
            d.min_qty,
            d.price
           FROM dedup d
             LEFT JOIN costo c ON c.sku = d.sku
          WHERE c.costo IS NULL OR d.price >= c.costo
        ), monotono AS (
         SELECT z.product_id,
            z.min_qty,
            z.price
           FROM ( SELECT defendible.product_id,
                    defendible.min_qty,
                    defendible.price,
                    min(defendible.price) OVER (PARTITION BY defendible.product_id ORDER BY defendible.min_qty ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS mejor_antes
                   FROM defendible) z
          WHERE z.mejor_antes IS NULL OR z.price < z.mejor_antes
        )
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    m.product_id,
    m.min_qty,
    m.price,
    now() AS computed_at
   FROM monotono m
     JOIN commercial.product_prices bp ON bp.product_id = m.product_id AND bp.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND bp.deleted_at IS NULL AND bp.min_qty = 1 AND bp.price > 0::numeric
     JOIN commercial.price_lists pl ON pl.id = bp.price_list_id AND pl.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND pl.code::text = 'BASE-MXN'::text
  WHERE m.min_qty > 1 AND m.price < bp.price`;

// La definición de prod tras 20261106142200 (pg_get_viewdef), para el down.
const ANTERIOR = `WITH ladder AS (
         SELECT btrim(k.c1) AS sku,
            mode() WITHIN GROUP (ORDER BY (btrim(k.c11))) AS u_base,
            mode() WITHIN GROUP (ORDER BY (btrim(k.c80))) AS u_alt1,
            mode() WITHIN GROUP (ORDER BY k.c81) AS f_alt1,
            mode() WITHIN GROUP (ORDER BY (btrim(k.c83))) AS u_alt2,
            mode() WITHIN GROUP (ORDER BY k.c84) AS f_alt2
           FROM kepler_ods.kdii k
          WHERE btrim(k.sucursal) <> '00'::text
          GROUP BY (btrim(k.c1))
        ), retail AS (
         SELECT btrim(p.c1) AS sku,
            btrim(p.c2) AS present,
            p.c3::integer AS tier,
            mode() WITHIN GROUP (ORDER BY p.c7) AS price,
            mode() WITHIN GROUP (ORDER BY p.c4) AS min_qty
           FROM kepler_ods.kdpv_prod_util p
          WHERE btrim(p.sucursal) <> '00'::text AND p.c3::integer = 0
          GROUP BY (btrim(p.c1)), (btrim(p.c2)), (p.c3::integer)
        ), cedis AS (
         SELECT btrim(p.c1) AS sku,
            btrim(p.c2) AS present,
            p.c3::integer AS tier,
            p.c7 AS price,
            p.c4 AS min_qty
           FROM kepler_ods.kdpv_prod_util p
          WHERE btrim(p.sucursal) = '00'::text AND p.c3::integer = 0
        ), src AS (
         SELECT DISTINCT ON (x.sku, x.present, x.tier) x.sku,
            x.present,
            x.tier,
            x.price,
            x.min_qty
           FROM ( SELECT retail.sku,
                    retail.present,
                    retail.tier,
                    retail.price,
                    retail.min_qty,
                    0 AS prioridad
                   FROM retail
                UNION ALL
                 SELECT cedis.sku,
                    cedis.present,
                    cedis.tier,
                    cedis.price,
                    cedis.min_qty,
                    1 AS prioridad
                   FROM cedis) x
          ORDER BY x.sku, x.present, x.tier, x.prioridad
        ), conv AS (
         SELECT s.sku,
            s.present,
            s.price,
            s.min_qty,
                CASE
                    WHEN s.present = l.u_base THEN 1::numeric
                    WHEN s.present = l.u_alt1 AND l.f_alt1 > 0::numeric THEN l.f_alt1
                    WHEN s.present = l.u_alt2 AND l.f_alt2 > 0::numeric THEN l.f_alt2
                    ELSE NULL::numeric
                END AS factor
           FROM src s
             JOIN ladder l ON l.sku = s.sku
        ), unit AS (
         SELECT p.id AS product_id,
            btrim(p.sku::text) AS sku,
            GREATEST(1::numeric, round(v.min_qty * v.factor))::integer AS min_qty,
            round(v.price / v.factor, 4) AS price
           FROM conv v
             JOIN catalog.products p ON btrim(p.sku::text) = v.sku AND p.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND p.deleted_at IS NULL
          WHERE v.factor IS NOT NULL AND v.factor > 0::numeric AND v.price > 0::numeric
        ), dedup AS (
         SELECT unit.product_id,
            unit.sku,
            unit.min_qty,
            min(unit.price) AS price
           FROM unit
          GROUP BY unit.product_id, unit.sku, unit.min_qty
        ), costo AS (
         SELECT btrim(v_kepler_standard_cost.sku) AS sku,
            max(v_kepler_standard_cost.costo_estandar) AS costo
           FROM analytics.v_kepler_standard_cost
          WHERE v_kepler_standard_cost.costo_estandar > 0::numeric
          GROUP BY (btrim(v_kepler_standard_cost.sku))
        ), defendible AS (
         SELECT d.product_id,
            d.min_qty,
            d.price
           FROM dedup d
             LEFT JOIN costo c ON c.sku = d.sku
          WHERE c.costo IS NULL OR d.price >= c.costo
        ), monotono AS (
         SELECT z.product_id,
            z.min_qty,
            z.price
           FROM ( SELECT defendible.product_id,
                    defendible.min_qty,
                    defendible.price,
                    min(defendible.price) OVER (PARTITION BY defendible.product_id ORDER BY defendible.min_qty ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS mejor_antes
                   FROM defendible) z
          WHERE z.mejor_antes IS NULL OR z.price < z.mejor_antes
        )
 SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
    m.product_id,
    m.min_qty,
    m.price,
    now() AS computed_at
   FROM monotono m
     JOIN commercial.product_prices bp ON bp.product_id = m.product_id AND bp.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND bp.deleted_at IS NULL AND bp.min_qty = 1 AND bp.price > 0::numeric
     JOIN commercial.price_lists pl ON pl.id = bp.price_list_id AND pl.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid AND pl.code::text = 'BASE-MXN'::text
  WHERE m.min_qty > 1 AND m.price < bp.price`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.product_volume_tiers AS ` + NUEVA);
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la definición anterior, tal cual. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE OR REPLACE VIEW analytics.product_volume_tiers AS ` + ANTERIOR);
};
