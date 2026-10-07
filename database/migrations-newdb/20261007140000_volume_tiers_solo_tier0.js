/* eslint-disable no-console */
/**
 * `[PV.1]` EL MAYOREO SE COBRABA AL NIVEL MÁS PROFUNDO, A TODO EL MUNDO.
 *
 * ── Qué estaba mal ──────────────────────────────────────────────────────────────────────────
 * `kepler_ods.kdpv_prod_util` tiene DOS ejes y esta vista los aplastaba en uno:
 *
 *     c2 = presentación (PAQ / CJA / …)
 *     c3 = NIVEL DE PRECIO DEL CLIENTE  → toma exactamente 0, 1, 2 y 3 en todo el catálogo
 *     c4 = cantidad mínima
 *     c7 = precio
 *
 * El `dedup` hacía `GROUP BY product_id, min_qty` con `min(price)`: agrupaba sólo por CANTIDAD
 * y se quedaba con el precio más barato, **descartando el nivel**. O sea que cualquier cliente
 * que alcanzara la cantidad mínima se llevaba el precio reservado al nivel más profundo.
 *
 * ── El arbitraje, con dinero (ADR-059) ──────────────────────────────────────────────────────
 * SKU 83652 (RICOLINO PANDITAS BOO SOBRE 33). Lo que la ficha ofrece por nivel:
 *
 *     PAQ  tier 0 min  3 -> 71.15      CJA  tier 0 min  3 -> 705.06  (70.51/PAQ)
 *          tier 1 min  3 -> 58.26           tier 1 min  3 -> 649.97  (65.00/PAQ)
 *          tier 2 min  6 -> 56.58           tier 2 min  6 -> 647.01  (64.70/PAQ)
 *          tier 3 min 10 -> 54.66           tier 3 min 10 -> 644.05  (64.41/PAQ)
 *
 * Lo que Kepler COBRÓ de verdad (analytics.erp_sales_invoice_lines, universo completo del SKU):
 *
 *     qty 1-2 -> 77.25 (BASE)   ·   qty 5 -> 71.15   ·   qty 10 -> 71.15   ·   qty 30 -> 70.51
 *
 * ⭐ **Nadie pagó nunca 58.26, 56.58 ni 54.66.** La escalera real es monótona y es **tier 0**.
 * Los niveles 1-3 son del cliente, no del volumen. La vista publicaba 54.66 a qty 10 donde
 * Kepler cobra 71.15: **23.2% por debajo**, y 15.0% por debajo del costo de la ficha (59.51).
 *
 * ── El arreglo ──────────────────────────────────────────────────────────────────────────────
 * Se emite **sólo el nivel 0**, que es el precio de mayoreo del cliente sin nivel asignado.
 *
 * ⛔ NO se intenta resolver el nivel del cliente: **no está decodificada la columna de Kepler
 * que se lo asigna**. Se descartaron las conocidas de `kdud` (c17 descuento %, c16 días de
 * crédito, c15 límite, c14 zona). Publicar los niveles 1-3 a todos es inventar un descuento;
 * mientras no se sepa a quién le tocan, el estándar es el 0. Queda declarado, no adivinado.
 *
 * ⚠️ Alcance medido: 5,107 SKUs conservan su mayoreo; **4,550 no tienen nivel 0** y pierden el
 * quiebre. De esos, sólo **201 (4.4%)** registran alguna venta por debajo de su precio de lista
 * — al otro 95.6% nunca se le dio ese descuento: se lo estábamos regalando nosotros. El que
 * pierde el quiebre paga BASE, que es lo que Kepler le cobra.
 *
 * ⚠️ `min()` se CONSERVA dentro del nivel 0: si PAQ y CJA caen en la misma cantidad, el cliente
 * puede comprar por cualquiera de las dos, así que quedarse con la más barata es correcto.
 *
 * ── Por qué ningún candado lo atrapó ────────────────────────────────────────────────────────
 * `test-newdb-fiq3-volume-pricing.js` dice textualmente que "replica EXACTAMENTE la selección
 * que hace resolvePriceForQty" y afirma que lo correcto es "el MEJOR (menor) tier". Compara
 * nuestro SQL contra nuestro JS: dos implementaciones de la misma regla equivocada, las dos de
 * acuerdo. El candado nuevo (`test-newdb-volume-tiers-vs-cobrado.js`) arbitra contra lo que
 * Kepler COBRÓ, que es un testigo independiente.
 */

const VISTA = 'analytics.product_volume_tiers';

exports.up = async function up(knex) {
  // Cuánto se estaba regalando, ANTES de tocar nada. Si esto da 0 el arreglo ya no hace falta.
  const antes = (await knex.raw(`
    WITH s AS (
      SELECT btrim(c1::text) AS sku, btrim(c2::text) AS present, c3::int AS tier,
             mode() WITHIN GROUP (ORDER BY c7) AS price,
             mode() WITHIN GROUP (ORDER BY c4) AS min_qty
        FROM kepler_ods.kdpv_prod_util
       WHERE btrim(sucursal) <> '00'
       GROUP BY 1, 2, 3)
    SELECT count(DISTINCT sku)::int AS skus
      FROM (SELECT sku, present, min_qty FROM s WHERE price > 0
             GROUP BY 1, 2, 3 HAVING count(DISTINCT tier) > 1) x`)).rows[0];

  await knex.raw(`
    CREATE OR REPLACE VIEW ${VISTA} AS
    WITH ladder AS (
      SELECT btrim(k.c1) AS sku,
             mode() WITHIN GROUP (ORDER BY btrim(k.c11)) AS u_base,
             mode() WITHIN GROUP (ORDER BY btrim(k.c80)) AS u_alt1,
             mode() WITHIN GROUP (ORDER BY k.c81)        AS f_alt1,
             mode() WITHIN GROUP (ORDER BY btrim(k.c83)) AS u_alt2,
             mode() WITHIN GROUP (ORDER BY k.c84)        AS f_alt2
        FROM kepler_ods.kdii k
       WHERE btrim(k.sucursal) <> '00'
       GROUP BY btrim(k.c1)
    ), retail AS (
      -- [PV.1] c3 = 0: el nivel del cliente SIN nivel. Los 1-3 son listas nominativas y no
      -- sabemos a quien le tocan, asi que publicarlas a todos es regalar precio.
      SELECT btrim(p.c1) AS sku, btrim(p.c2) AS present, p.c3::integer AS tier,
             mode() WITHIN GROUP (ORDER BY p.c7) AS price,
             mode() WITHIN GROUP (ORDER BY p.c4) AS min_qty
        FROM kepler_ods.kdpv_prod_util p
       WHERE btrim(p.sucursal) <> '00' AND p.c3::integer = 0
       GROUP BY btrim(p.c1), btrim(p.c2), p.c3::integer
    ), cedis AS (
      SELECT btrim(p.c1) AS sku, btrim(p.c2) AS present, p.c3::integer AS tier,
             p.c7 AS price, p.c4 AS min_qty
        FROM kepler_ods.kdpv_prod_util p
       WHERE btrim(p.sucursal) = '00' AND p.c3::integer = 0
    ), src AS (
      SELECT sku, present, tier, price, min_qty FROM retail
      UNION ALL
      SELECT k.sku, k.present, k.tier, k.price, k.min_qty
        FROM cedis k
       WHERE NOT EXISTS (SELECT 1 FROM retail r
                          WHERE r.sku = k.sku AND r.present = k.present AND r.tier = k.tier)
    ), conv AS (
      SELECT s.sku, s.present, s.tier, s.price, s.min_qty,
             CASE WHEN s.present = l.u_base                            THEN 1::numeric
                  WHEN s.present = l.u_alt1 AND l.f_alt1 > 0::numeric  THEN l.f_alt1
                  WHEN s.present = l.u_alt2 AND l.f_alt2 > 0::numeric  THEN l.f_alt2
                  ELSE NULL::numeric END AS factor
        FROM src s JOIN ladder l ON l.sku = s.sku
    ), unit AS (
      SELECT p.id AS product_id,
             GREATEST(1::numeric, round(v.min_qty * v.factor))::integer AS min_qty,
             round(v.price / v.factor, 4) AS price
        FROM conv v
        JOIN catalog.products p
          ON btrim(p.sku::text) = v.sku
         AND p.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
         AND p.deleted_at IS NULL
       WHERE v.factor IS NOT NULL AND v.factor > 0::numeric AND v.price > 0::numeric
    ), dedup AS (
      -- [PV.1] min() se conserva: dentro del nivel 0, si PAQ y CJA caen en la misma cantidad el
      -- cliente puede comprar por cualquiera de las dos y le toca la mejor.
      SELECT product_id, min_qty, min(price) AS price
        FROM unit GROUP BY product_id, min_qty
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           d.product_id, d.min_qty, d.price, now() AS computed_at
      FROM dedup d
      JOIN commercial.product_prices bp
        ON bp.product_id = d.product_id
       AND bp.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
       AND bp.deleted_at IS NULL AND bp.min_qty = 1 AND bp.price > 0::numeric
      JOIN commercial.price_lists pl
        ON pl.id = bp.price_list_id
       AND pl.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
       AND pl.code::text = 'BASE-MXN'::text
     WHERE d.min_qty > 1 AND d.price < bp.price`);

  // ⚠️ No se heredan en un CREATE OR REPLACE: hay que re-aplicarlos (ADR-057).
  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  // Prueba de que el filtro se aplicó de verdad. Sin esto la migración "pasa" igual.
  const d = (await knex.raw(`
    SELECT count(*)::int AS filas, count(DISTINCT product_id)::int AS productos
      FROM ${VISTA}`)).rows[0];
  const inv = (await knex.raw(`
    SELECT count(*)::int AS n FROM (
      SELECT product_id, price,
             lag(price) OVER (PARTITION BY product_id ORDER BY min_qty) AS prev
        FROM ${VISTA}) x
     WHERE prev IS NOT NULL AND price > prev`)).rows[0];

  console.log('  [PV.1] ' + antes.skus + ' SKUs tenian varios niveles compitiendo en la misma '
            + 'cantidad (el mas profundo ganaba).');
  console.log('  [PV.1] vista ahora: ' + d.filas + ' filas / ' + d.productos + ' productos · '
            + inv.n + ' quiebres NO monotonos (suben al subir la cantidad).');
  if (Number(d.filas) === 0) throw new Error('[PV.1] la vista quedo VACIA: el filtro c3=0 borro todo');
};

exports.down = async function down(knex) {
  console.log('  [PV.1] down: re-aplicar la definicion previa (20260826140000). '
            + 'OJO: volver atras reinstala el regalo del nivel mas profundo.');
  void knex;
};
