/* eslint-disable no-console */
/**
 * `[PV.2]` LO QUE NO SE PUEDE CALCULAR BIEN, NO SE PUBLICA COMO DESCUENTO.
 *
 * `[PV.1]` sacó el regalo del nivel profundo y su candado se puso rojo igual, con DOS fallas que
 * ese arreglo no cubría y que son la **misma causa**: el factor presentación→base
 * (`conv.factor`, que casa `c2` contra `u_base` / `u_alt1` / `u_alt2` de `kdii`) sale mal cuando
 * los rótulos chocan. Medido: **21,496 de 86,802 filas de la escalera tienen el rótulo de la
 * unidad base IGUAL al de la segunda** (24.8 %), así que casar por etiqueta es ambiguo en un
 * cuarto del catálogo.
 *
 * ── Las dos fallas, y por qué sólo UNA es dinero ────────────────────────────────────────────
 *
 *  · **59 quiebres / 36 SKUs por debajo del costo de la ficha.** `03118` publicaba $127.45 con
 *    un costo de $1,575 (−91.9 %); `44174` publicaba $4.37 contra $360.14 (−98.8 %). Éstos SÍ
 *    cobran: `resolvePriceForQty` toma el MÍNIMO aplicable, así que un quiebre roto siempre gana.
 *
 *  · **104 escaleras invertidas** (`40147`: min 3 → $20.48, min 18 → $40.23). Éstas NO cobran de
 *    más: a qty 18 el resolver igual se queda con los $20.48 del quiebre de 3. Son ruido en
 *    pantalla, no fuga. Se retiran igual, porque una escalera que sube es una pantalla que miente.
 *
 * ── El criterio ─────────────────────────────────────────────────────────────────────────────
 * No se inventa un factor ni se "corrige" el precio: se **deja de publicar** el quiebre que no se
 * puede defender. Sin quiebre el cliente paga BASE — que es lo que Kepler le cobra a quien no
 * califica, y nunca es cobrar de menos. Es el mismo criterio con el que la vista ya se niega a
 * emitir cuando `factor IS NULL`.
 *
 * ⚠️ El piso de costo es una cota FLOJA a propósito: el precio publicado lleva impuesto y
 * `costo_estandar` no, así que se compara bruto contra neto. Lo que cae acá está muy abajo, no al
 * borde — no se descarta ningún descuento legítimo por redondeo.
 *
 * ⚠️ Un SKU sin costo en `v_kepler_standard_cost` NO se puede juzgar: se publica igual y queda
 * declarado acá. Es ausencia de medición, no permiso (ADR-056).
 */

const VISTA = 'analytics.product_volume_tiers';

exports.up = async function up(knex) {
  const antes = (await knex.raw(`
    WITH c AS (SELECT btrim(sku) AS sku, max(costo_estandar) AS costo
                 FROM analytics.v_kepler_standard_cost WHERE costo_estandar > 0 GROUP BY 1)
    SELECT (SELECT count(*) FROM ${VISTA} v
              JOIN catalog.products pr ON pr.id = v.product_id
              JOIN c ON c.sku = btrim(pr.sku::text)
             WHERE v.price < c.costo)::int AS bajo_costo,
           (SELECT count(*) FROM (
              SELECT price, lag(price) OVER (PARTITION BY product_id ORDER BY min_qty) AS prev
                FROM ${VISTA}) x
             WHERE prev IS NOT NULL AND price > prev + 0.0001)::int AS invertidos,
           (SELECT count(*) FROM ${VISTA})::int AS filas`)).rows[0];

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
      -- [PV.1] c3 = 0: el nivel del cliente SIN nivel asignado.
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
      SELECT s.sku, s.present, s.price, s.min_qty,
             CASE WHEN s.present = l.u_base                            THEN 1::numeric
                  WHEN s.present = l.u_alt1 AND l.f_alt1 > 0::numeric  THEN l.f_alt1
                  WHEN s.present = l.u_alt2 AND l.f_alt2 > 0::numeric  THEN l.f_alt2
                  ELSE NULL::numeric END AS factor
        FROM src s JOIN ladder l ON l.sku = s.sku
    ), unit AS (
      SELECT p.id AS product_id, btrim(p.sku::text) AS sku,
             GREATEST(1::numeric, round(v.min_qty * v.factor))::integer AS min_qty,
             round(v.price / v.factor, 4) AS price
        FROM conv v
        JOIN catalog.products p
          ON btrim(p.sku::text) = v.sku
         AND p.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
         AND p.deleted_at IS NULL
       WHERE v.factor IS NOT NULL AND v.factor > 0::numeric AND v.price > 0::numeric
    ), dedup AS (
      SELECT product_id, sku, min_qty, min(price) AS price
        FROM unit GROUP BY product_id, sku, min_qty
    ), costo AS (
      SELECT btrim(sku) AS sku, max(costo_estandar) AS costo
        FROM analytics.v_kepler_standard_cost
       WHERE costo_estandar > 0 GROUP BY 1
    ), defendible AS (
      -- [PV.2] 1a puerta: un quiebre por debajo del costo no es un descuento, es un factor roto.
      -- Sin costo con que juzgar se deja pasar y queda DECLARADO en el comentario de la vista.
      SELECT d.product_id, d.min_qty, d.price
        FROM dedup d
        LEFT JOIN costo c ON c.sku = d.sku
       WHERE c.costo IS NULL OR d.price >= c.costo
    ), monotono AS (
      -- [PV.2] 2a puerta: se conserva solo la envolvente que BAJA. Un quiebre mas caro que otro
      -- de cantidad menor nunca se cobra (el resolver toma el minimo) y en pantalla miente.
      SELECT product_id, min_qty, price
        FROM (SELECT product_id, min_qty, price,
                     min(price) OVER (PARTITION BY product_id
                                      ORDER BY min_qty
                                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS mejor_antes
                FROM defendible) z
       WHERE mejor_antes IS NULL OR price < mejor_antes
    )
    SELECT '00000000-0000-0000-0000-00000000d01c'::uuid AS tenant_id,
           m.product_id, m.min_qty, m.price, now() AS computed_at
      FROM monotono m
      JOIN commercial.product_prices bp
        ON bp.product_id = m.product_id
       AND bp.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
       AND bp.deleted_at IS NULL AND bp.min_qty = 1 AND bp.price > 0::numeric
      JOIN commercial.price_lists pl
        ON pl.id = bp.price_list_id
       AND pl.tenant_id = '00000000-0000-0000-0000-00000000d01c'::uuid
       AND pl.code::text = 'BASE-MXN'::text
     WHERE m.min_qty > 1 AND m.price < bp.price`);

  await knex.raw(`ALTER VIEW ${VISTA} SET (security_invoker = true)`);
  await knex.raw(`GRANT SELECT ON ${VISTA} TO app_runtime`);

  const d = (await knex.raw(`
    WITH c AS (SELECT btrim(sku) AS sku, max(costo_estandar) AS costo
                 FROM analytics.v_kepler_standard_cost WHERE costo_estandar > 0 GROUP BY 1)
    SELECT (SELECT count(*) FROM ${VISTA})::int AS filas,
           (SELECT count(DISTINCT product_id) FROM ${VISTA})::int AS productos,
           (SELECT count(*) FROM ${VISTA} v
              JOIN catalog.products pr ON pr.id = v.product_id
              JOIN c ON c.sku = btrim(pr.sku::text)
             WHERE v.price < c.costo)::int AS bajo_costo,
           (SELECT count(*) FROM (
              SELECT price, lag(price) OVER (PARTITION BY product_id ORDER BY min_qty) AS prev
                FROM ${VISTA}) x
             WHERE prev IS NOT NULL AND price > prev + 0.0001)::int AS invertidos`)).rows[0];

  console.log('  [PV.2] antes: ' + antes.filas + ' filas · ' + antes.bajo_costo + ' bajo costo · '
            + antes.invertidos + ' invertidos');
  console.log('  [PV.2] ahora: ' + d.filas + ' filas / ' + d.productos + ' productos · '
            + d.bajo_costo + ' bajo costo · ' + d.invertidos + ' invertidos');
  if (Number(d.bajo_costo) !== 0) throw new Error('[PV.2] siguen ' + d.bajo_costo + ' quiebres bajo costo');
  if (Number(d.invertidos) !== 0) throw new Error('[PV.2] siguen ' + d.invertidos + ' quiebres invertidos');
  if (Number(d.filas) === 0) throw new Error('[PV.2] la vista quedo VACIA');
};

exports.down = async function down(knex) {
  console.log('  [PV.2] down: re-aplicar 20261007140000. OJO: vuelve a publicar los quiebres '
            + 'bajo costo (59 filas / 36 SKUs al momento de escribir esto).');
  void knex;
};
