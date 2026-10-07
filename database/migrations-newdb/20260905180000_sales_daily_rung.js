/**
 * U.5 — el hecho de venta PERSISTE el peldaño que se cobró. Hoy lo calcula y lo tira.
 *
 * ── El defecto ─────────────────────────────────────────────────────────────────────────────
 * `database/importers/kepler/import-sales-fact.js:150` llama a `toCanonicalPriced(...)`, que
 * identifica por PRECIO en qué peldaño de la escalera se vendió cada renglón y devuelve
 * `{ qty, ok }`. La linea 151 hace `if (!conv.ok) unconv++;` — o sea el veredicto se cuenta en
 * un `console.log` y se DESCARTA, junto con el factor elegido. Una fila que resolvio su peldaño
 * y otra que no se suman IDENTICAS en `sales_daily.units`, y ningun consumidor puede
 * distinguirlas despues.
 *
 * Peor: `unit-normalization.js:60-61` deja que `packF` y `boxF` caigan LOS DOS a
 * `catalog.products.factor_sale`, que es justamente la fuente que la investigacion probo que no
 * tiene unidad (mitad piezas, un tercio paquetes). Cuando colapsan al mismo numero,
 * `pickPriceTier` esta eligiendo entre dos factores identicos: el peldaño que "identifica" no
 * lleva informacion.
 *
 * ── Lo que eso cuesta, medido en prod 2026-09-05 ───────────────────────────────────────────
 * A grano (SKU x almacen), sobre 90 dias y arbitrando por el precio realizado contra
 * `analytics.v_product_unit_ladder`:
 *
 *   peldaño cobrado    celdas   SKUs    venta          %
 *   ----------------   ------   -----   ------------   -----
 *   base               33,818   5,453   $126,113,957   90.4%
 *   PAQUETE             1,308     299   $  8,647,158    6.2%
 *   CAJA                  136      51   $  1,389,321    1.0%
 *   fuera de banda        419     225   $  2,585,823    1.9%
 *   sin escalera          852     355   $    837,521    0.6%
 *
 * Y **311 SKUs se venden en DOS peldaños a la vez: $17,449,457 = 12.8% de la venta de 90 dias**.
 * La razon entre sus precios unitarios es el factor de PAQUETE, no un descuento — 88045 da 25.1
 * contra f2=25 · 02693 17.6/20 · 08057 15.2/16 · 65124 12.1/12 · 70031 17.0/16.
 *
 * ⚠️ PRECISION IMPORTANTE, medida y no supuesta: esa mezcla vive ENTRE CELDAS — el mismo SKU en
 * un almacen cobrado en piezas y en otro en paquetes — NO dentro de una misma fila del fact. El
 * dry-run del importer sobre 695,127 filas de origen dio **cero** filas con peldaño mezclado. O
 * sea `rung_factor` va a quedar poblado en practicamente todas las filas, y `rung_mixed` nace
 * como CANDADO: el dia que deje de ser cero, una fila esta sumando dos peldaños y hay que mirarla.
 * Lo que rompe es agregar entre almacenes sin mirar el peldaño de cada uno.
 *
 * ⚠️ Y agregando por SKU (sin almacen) el no-base baja de 7.2% a 0.7%: **el grano grueso lo
 * escondia 8x**. Por eso nadie lo habia visto.
 *
 * ── Que agrega ─────────────────────────────────────────────────────────────────────────────
 * Tres columnas ADITIVAS y nullables. Cero impacto para quien ya lee el fact: nada cambia de
 * valor, solo aparece con que declararse.
 *
 *   · `rung_factor`      el factor aplicado, SOLO cuando todos los buckets de esa fila usaron
 *                        el mismo. Con peldaños distintos queda NULL (ver `rung_mixed`).
 *   · `rung_mixed`       la fila absorbio DOS O MAS peldaños. El importer agrega por
 *                        (producto, almacen, canal, dia) y colapsa los buckets de `unidad`, asi
 *                        que una sola fila puede traer piezas y paquetes sumados. Declararlo es
 *                        lo unico honesto: convertirlo aca seria inventar el reparto.
 *   · `units_unresolved` la parte de `units` que se sumo SIN poder identificar su peldaño
 *                        (`conv.ok === false`). Es lo que hoy vive en un console.log.
 *
 * ⛔ NO se normaliza `units`. Es el numerador de todo /compras/pedido y de la rentabilidad, y
 * convertirlo es exactamente el movimiento que ya se revirtio una vez (mig 20260902200000, que
 * dejo la cobertura en 534-900 dias y el motor dejo de pedir). Primero se DECLARA; convertir es
 * una decision aparte, con su propia validacion.
 *
 * @param { import("knex").Knex } knex
 */
// Las tres columnas son ADD COLUMN con default: en PG 11+ eso es metadata, no reescribe las 4.46M
// filas ni bloquea al importer de forma apreciable.
exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'rung_factor'))) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (tb) => {
      tb.decimal('rung_factor', 14, 4).nullable()
        .comment('U.5 - Factor del peldano realmente cobrado (1 = unidad base). Solo se llena cuando TODOS los buckets de unidad que formaron esta fila usaron el mismo; con peldanos distintos queda NULL y rung_mixed = true. Sale de toCanonicalPriced (el peldano se identifica por el PRECIO realizado contra kdii.c90/c91/c92, no por el rotulo).');
    });
  }

  if (!(await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'rung_mixed'))) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (tb) => {
      tb.boolean('rung_mixed').notNullable().defaultTo(false)
        .comment('U.5 - CANDADO: la fila absorbio DOS O MAS peldanos distintos (p.ej. piezas y paquetes del mismo SKU el mismo dia y almacen). Medido 2026-09-05 sobre 695,127 filas de origen: CERO. Se espera cero; si deja de serlo, units esta sumando dos unidades y hay que mirar esa fila. La mezcla que SI existe es entre celdas -- 311 SKUs / $17.4M = 12.8% de la venta 90d cobrados en dos peldanos en almacenes distintos -- y eso se ve comparando rung_factor entre filas, no con esta bandera.');
    });
  }

  if (!(await knex.schema.withSchema('analytics').hasColumn('sales_daily', 'units_unresolved'))) {
    await knex.schema.withSchema('analytics').alterTable('sales_daily', (tb) => {
      tb.decimal('units_unresolved', 18, 3).nullable()
        .comment('U.5 - Parte de units que se sumo SIN poder identificar su peldano por precio (conv.ok = false en el importer). Hasta hoy este dato solo existia como un contador en un console.log. NULL = el importer todavia no lo escribe para esa fila.');
    });
  }

  // ⚠️ El indice parcial NO va aca. Se intento con CREATE INDEX CONCURRENTLY y en esta base es
  // una trampa: espera a TODAS las transacciones mas viejas, y habia una consulta de analitica de
  // 1h54m corriendo, asi que el build se sento 575 s en Lock/virtualxid encolando detras dos
  // ANALYZE del propio importer. Vive en 20260905190000, sin CONCURRENTLY y con lock_timeout.
};

exports.down = async function down(knex) {
  for (const col of ['rung_factor', 'rung_mixed', 'units_unresolved']) {
    if (await knex.schema.withSchema('analytics').hasColumn('sales_daily', col)) {
      await knex.schema.withSchema('analytics').alterTable('sales_daily', (tb) => tb.dropColumn(col));
    }
  }
};
