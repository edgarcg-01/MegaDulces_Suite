/**
 * `[ETQ-PROMO.6]` La etiqueta imprime la promo AUNQUE el saldo esté en cero.
 *
 * Reemplaza la vista de `20260918250000` (que exigía `c10 > 0`). Decisión de Edgar 2026-09-19:
 * "mostremos aunque esté agotada".
 *
 * ── POR QUÉ EXISTÍA EL FILTRO, Y POR QUÉ NO ALCANZABA ───────────────────────────────────────
 * `c10` = "Saldo x Vender". La vista original lo exigía positivo con el argumento de que "la
 * promo se agota". Eso se midió en la plaza 05 y ahí es cierto, pero **no generaliza**: el filtro
 * borraba en silencio a una sucursal entera.
 *
 * Medido en prod (`current_database() = railway`) el 2026-09-19, promos VIGENTES por tienda:
 *
 *   tienda   vigentes   declara c9 (Cant Max)   agotada real   sin control de saldo   con saldo
 *     01         4              4                    3                 0                 1
 *     02         5              5                    1                 0                 4
 *     05       452            405                    0                47               405
 *     06        35             35                    0                 0                35
 *   ⭐ 08       117              0                    0               117                 0
 *
 * ⭐ La sucursal **08 es una instalación NUEVA de Kepler** (sus primeros documentos son del
 * 2026-09-18, y son traspasos de entrada `N-A-44`, no ventas). **No llena `c9` ni `c10` en
 * NINGUNA de sus 5,333 filas**: el cero no significa "agotada", significa "no lleva ese control".
 * Con el filtro viejo sus 117 promos vigentes —las 117 ubicables en una presentación, 88 en la
 * base y 29 en `unidad2`— desaparecían sin que nada lo dijera.
 *
 * ── ⚠️ LO QUE EL DATO ADVIERTE, Y QUE ESTA VISTA YA NO DECIDE ────────────────────────────────
 * En la plaza 05, que SÍ lleva saldo, las 47 promos vigentes con `c9 = 0 AND c10 = 0` casi no se
 * cobran. Medido sobre `U-D-10` 2026-08-20→09-18 con `kdm2.c66 > 0`:
 *
 *   grupo                          renglones   reciben descuento   CASAN con el % declarado
 *   con saldo (c10 > 0)              1,730          79.8%              916  (53%)
 *   sin control (c9=0, c10=0)        1,183          52.0%                9  (0.8%)
 *
 * Ese 52% es consistente con la escalera de mayoreo sola (el control sin promo da 18.2%), no con
 * la promo. O sea que para ESE grupo la etiqueta va a imprimir un descuento que el mostrador
 * probablemente no dé.
 *
 * ⛔ Por eso la vista **no filtra pero tampoco calla**: publica `saldo` y `saldo_estado`
 * (`con_saldo` | `agotada` | `sin_control`) para que el consumidor pueda declararlo o decidir.
 * Un filtro escondido en un `WHERE` no se puede auditar desde la pantalla; una columna sí
 * (ADR-056: lo que no se puede afirmar se DECLARA, no se dibuja ni se borra).
 *
 * ⛔ NO se puede afirmar todavía si la caja de la 08 honra estas promos: esa tienda **no tiene un
 * solo ticket de mostrador** (`U-D-10`) y su `kdm2.c66` viene en 0 en los 10,702 renglones que
 * existen. Se sabrá con su primera venta.
 *
 * El resto del decode no cambia — sigue valiendo lo de `20260918250000`: `c6` es un PORCENTAJE,
 * `c1` es la TIENDA (no `sucursal`, que es de qué base se replicó la fila), y `aplica_a` se
 * DECLARA contra las tres presentaciones de `kdii`, NULL cuando no se puede ubicar.
 */
const VIEW = `
CREATE OR REPLACE VIEW analytics.v_label_promotions AS
WITH vig AS (
  SELECT DISTINCT ON (btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)))
         btrim(d.c1)                AS sucursal,
         btrim(d.c2)                AS sku,
         upper(btrim(d.c3))         AS unidad,
         d.c5::numeric              AS min_qty,
         d.c6::numeric              AS pct,
         d.c7::date                 AS valid_from,
         d.c8::date                 AS valid_to,
         d.c10::numeric             AS saldo,
         -- El estado viaja como DATO, no como filtro. 'sin_control' NO es lo mismo que
         -- 'agotada': la primera es una sucursal que no lleva la columna (medido: la 08 tiene
         -- c9=0 en sus 5,333 filas), la segunda es una promo que declaró un maximo y lo gasto.
         CASE WHEN d.c10::numeric > 0 THEN 'con_saldo'
              WHEN d.c9::numeric  > 0 THEN 'agotada'
              ELSE 'sin_control' END AS saldo_estado
    FROM kepler_ods.kdpv_descuxq d
   WHERE d.c7 <= now() AND d.c8 >= now()
     AND d.c6::numeric > 0
     AND btrim(coalesce(d.c1,'')) <> '' AND btrim(coalesce(d.c2,'')) <> ''
   ORDER BY btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)),
            (btrim(d.sucursal::text) = btrim(d.c1)) DESC, d.c8 DESC
)
SELECT v.sucursal, v.sku, v.unidad, v.min_qty, v.pct, v.valid_from, v.valid_to,
       v.saldo, v.saldo_estado,
       CASE WHEN v.unidad = upper(btrim(coalesce(k.c11,''))) THEN 'base'
            WHEN v.unidad = upper(btrim(coalesce(k.c80,''))) THEN 'unidad2'
            WHEN v.unidad = upper(btrim(coalesce(k.c83,''))) THEN 'unidad3'
       END AS aplica_a
  FROM vig v
  LEFT JOIN kepler_ods.kdii k
         ON btrim(k.c1) = v.sku AND btrim(k.sucursal::text) = v.sucursal`;

exports.up = async function up(knex) {
  // `CREATE OR REPLACE` no sirve si cambia la LISTA de columnas (aca se suma `saldo_estado`):
  // Postgres exige que las viejas queden identicas y en el mismo orden. Se dropea primero.
  await knex.raw('DROP VIEW IF EXISTS analytics.v_label_promotions');
  await knex.raw(VIEW);
  await knex.raw('GRANT SELECT ON analytics.v_label_promotions TO app_runtime');
  await knex.raw(`COMMENT ON VIEW analytics.v_label_promotions IS
    'derive-no-copy sobre kepler_ods.kdpv_descuxq: descuento por cantidad VIGENTE por tienda (c1, no sucursal) y por presentacion. pct = %. NO filtra por saldo (decision 2026-09-19): publica saldo_estado con_saldo/agotada/sin_control para que el consumidor declare. La sucursal 08, instalacion nueva, no llena c9/c10 en ninguna de sus 5333 filas: el filtro viejo le borraba sus 117 promos en silencio. aplica_a NULL = la promo apunta a una unidad que el producto no tiene.'`);
};

exports.down = async function down(knex) {
  // Vuelve a la version de 20260918250000, con el filtro de saldo y sin `saldo_estado`.
  await knex.raw('DROP VIEW IF EXISTS analytics.v_label_promotions');
  await knex.raw(`
CREATE VIEW analytics.v_label_promotions AS
WITH vig AS (
  SELECT DISTINCT ON (btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)))
         btrim(d.c1) AS sucursal, btrim(d.c2) AS sku, upper(btrim(d.c3)) AS unidad,
         d.c5::numeric AS min_qty, d.c6::numeric AS pct,
         d.c7::date AS valid_from, d.c8::date AS valid_to, d.c10::numeric AS saldo
    FROM kepler_ods.kdpv_descuxq d
   WHERE d.c7 <= now() AND d.c8 >= now()
     AND d.c6::numeric > 0 AND d.c10::numeric > 0
     AND btrim(coalesce(d.c1,'')) <> '' AND btrim(coalesce(d.c2,'')) <> ''
   ORDER BY btrim(d.c1), btrim(d.c2), upper(btrim(d.c3)),
            (btrim(d.sucursal::text) = btrim(d.c1)) DESC, d.c8 DESC
)
SELECT v.sucursal, v.sku, v.unidad, v.min_qty, v.pct, v.valid_from, v.valid_to, v.saldo,
       CASE WHEN v.unidad = upper(btrim(coalesce(k.c11,''))) THEN 'base'
            WHEN v.unidad = upper(btrim(coalesce(k.c80,''))) THEN 'unidad2'
            WHEN v.unidad = upper(btrim(coalesce(k.c83,''))) THEN 'unidad3'
       END AS aplica_a
  FROM vig v
  LEFT JOIN kepler_ods.kdii k
         ON btrim(k.c1) = v.sku AND btrim(k.sucursal::text) = v.sucursal`);
  await knex.raw('GRANT SELECT ON analytics.v_label_promotions TO app_runtime');
};
