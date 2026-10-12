'use strict';
/**
 * `[PF.8]` Los márgenes de cada producto (Compras › Catálogo › Productos), precalculados cada noche para que el
 * panel los muestre al instante.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-09 / 2026-10-12) ───────────────────────────
 *  · El panel los calculaba al abrir el producto con `fn_new_products_movimientos`, que entra por SKU:
 *    1.1–1.5 s con los datos calientes y **14 s** la primera vez.
 *  · Esta consulta ENTRA POR FECHA y junta los 30 días cerrados de TODOS los productos: 15–17 s, 27,315 filas,
 *    4,807 productos. Nocturna, en el worker.
 *  · ⭐ Cruzada contra la función con 5 productos (70001, 17085, 96087, 44238, 20021): **51 celdas (venta y
 *    compras por sucursal) sin una sola diferencia** en venta neta, venta con costo, costo y cantidad.
 *
 * ── Qué es ──────────────────────────────────────────────────────────────────────────────────
 *  · Las piezas de los tres márgenes de `[NP.15]` por (producto, sucursal, peldaño vendido, unidad base): venta
 *    de tienda (U-D 8/10/12, desde el corte de Kepler de cada sucursal) y compras (`X-A-20`) de los últimos 30
 *    días CERRADOS (hasta ayer). Mismas expresiones que la función: venta sin IVA/IEPS, costo del renglón
 *    (`kdm2.c62` por la cantidad del peldaño), compra sin impuesto.
 *  · `desde`/`hasta` viajan en cada fila: la API compara `hasta` con ayer y, si quedó vieja, calcula en vivo
 *    (y lo declara). Materializar por costo (GOTCHAS §19): cada valor sale de `kepler_ods` en cada refresco.
 *  · Nace `WITH NO DATA`: el refresco nocturno la detecta sin poblar y la llena (sin CONCURRENTLY esa vez).
 *  · Sólo el tenant de Mega Dulces, como `mv_erp_margin_daily` (las matvistas no tienen RLS).
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const HOY = `(now() AT TIME ZONE 'America/Mexico_City')::date`;
const DIAS = 30;

/** Numérico de Kepler (texto con formato), preservando NULL. Mismas expresiones que `[NP.15]`. */
const N = (col) => `nullif(regexp_replace(${col}::text, '[^0-9.-]', '', 'g'), '')::numeric`;
const IMPORTE = `round(coalesce(${N('l.c13')}, 0), 2)`;
const DECLARA = `(nullif(btrim(l.c55::text), '') IS NOT NULL AND ${N('l.c56')} <> 0 AND ${N('l.c58')} > 0
                  AND abs(l.c9::numeric - ${N('l.c56')} * ${N('l.c58')}) <= 0.001)`;
const FACTOR = `round(CASE WHEN ${DECLARA} THEN ${N('l.c58')} ELSE 1 END, 4)`;
const UNIDAD_BASE = `coalesce(upper(nullif(btrim(l.c11::text), '')), '?')`;
const NETO_VENTA = `${IMPORTE} / (1 + abs(coalesce(${N('l.c17')}, 0)) / 100 + abs(coalesce(${N('l.c18')}, 0)) / 100)`;
const COSTO_VENTA = `CASE WHEN ${N('l.c62')} > 0 THEN ${N('l.c62')} * coalesce(${N('l.c56')}, l.c9::numeric) END`;

const SELECT = `
  WITH v AS (
    SELECT ${HOY} - ${DIAS} AS desde, ${HOY} - 1 AS hasta
  ), lin AS (
    SELECT btrim(l.c8) AS sku, 'venta'::text AS tipo, btrim(h.sucursal) AS plaza,
           ${FACTOR} AS factor, ${UNIDAD_BASE} AS unidad_base,
           ${NETO_VENTA} AS n, ${COSTO_VENTA} AS c, l.c9::numeric AS q
      FROM v, kepler_ods.kdm1 h
      JOIN kepler_ods.kdm2 l
        ON btrim(l.sucursal) = btrim(h.sucursal) AND btrim(l.c1) = btrim(h.c1)
       AND l.c2 = h.c2 AND l.c3 = h.c3 AND l.c4::integer = h.c4::integer
       AND l.c5::integer = h.c5::integer AND btrim(l.c6) = btrim(h.c6)
     WHERE h.c2 = 'U' AND h.c3 = 'D' AND l.c2 = 'U' AND l.c3 = 'D'
       AND h.c9::date BETWEEN v.desde AND v.hasta
       AND h.c4::integer IN (8, 10, 12)
       AND btrim(h.c1) = btrim(h.sucursal)
       AND coalesce(nullif(btrim(h.c43), ''), '') <> 'C'
       AND coalesce(btrim(l.c11), '') <> 'SER'
       AND abs(coalesce(l.c9::numeric, 0)) > 0
       AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover c
                    WHERE c.tenant_id = '${TENANT}'::uuid AND c.kepler_code = btrim(h.sucursal)
                      AND h.c9::date >= c.cutover_date)
    UNION ALL
    SELECT nullif(btrim(l.c8::text), ''), 'entrada'::text, btrim(h.sucursal::text),
           ${FACTOR}, ${UNIDAD_BASE}, ${IMPORTE}, NULL::numeric, l.c9::numeric
      FROM v, kepler_ods.kdm1 h
      JOIN kepler_ods.kdm2 l
        ON l.sucursal = h.sucursal AND l.c1 = h.c1 AND l.c2 = h.c2 AND l.c3 = h.c3
       AND l.c4 = h.c4 AND l.c5 = h.c5 AND l.c6 = h.c6
     WHERE h.c2 = 'X' AND h.c3 = 'A' AND btrim(h.c4::text) = '20'
       AND h.c9::date BETWEEN v.desde AND v.hasta
       AND btrim(h.c1::text) = h.sucursal::text
       AND btrim(coalesce(h.c43::text, '')) <> 'C'
       AND nullif(btrim(l.c8::text), '') IS NOT NULL
  )
  SELECT '${TENANT}'::uuid AS tenant_id, lin.sku, lin.tipo, lin.plaza, lin.factor, lin.unidad_base,
         round(sum(lin.n), 4) AS n,
         round(coalesce(sum(lin.n) FILTER (WHERE lin.c IS NOT NULL), 0), 4) AS nc,
         round(coalesce(sum(lin.c), 0), 4) AS c,
         round(sum(lin.q), 4) AS q,
         (SELECT desde FROM v) AS desde, (SELECT hasta FROM v) AS hasta, now() AS calculado_at
    FROM lin
   GROUP BY lin.sku, lin.tipo, lin.plaza, lin.factor, lin.unidad_base`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.mv_product_margins_30d AS ${SELECT} WITH NO DATA`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS mv_product_margins_30d_pk
      ON analytics.mv_product_margins_30d (tenant_id, sku, tipo, plaza, factor, unidad_base)`);
  await knex.raw(`GRANT SELECT ON analytics.mv_product_margins_30d TO app_runtime`);
  await knex.raw(`
    COMMENT ON MATERIALIZED VIEW analytics.mv_product_margins_30d IS
      '[PF.8] Piezas de los tres margenes por producto, sucursal, peldano y unidad base: venta de tienda y compras '
      'de los ultimos 30 dias cerrados. Mismas expresiones que fn_new_products_movimientos (cruzado: 51 celdas, 0 '
      'diferencias). Refresco nocturno en el worker (analytics_refresh_product_margins).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS analytics.mv_product_margins_30d`);
};

