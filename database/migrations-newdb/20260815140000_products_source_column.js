/**
 * NORMALIZACIÓN — PRODUCTO (clase A). Paso 1: columna `source` en catalog.products.
 *
 * Prerequisito del feed único `sync-product-master`: para reconciliar bajas de forma
 * SEGURA hay que saber de qué fuente vino cada producto. Sin esto, un reconcile a ciegas
 * (soft-delete de lo ausente en kepler_ods.kdii) borraría 1448 productos wincaja-only +
 * 1156 manuales/huérfanos que NO son bajas. Con `source`, el feed toca SOLO 'kepler'.
 *
 *   'kepler'  → sku vive en kepler_ods.kdii (verdad del ERP; el feed lo mantiene + reconcilia)
 *   'wincaja' → sku vive en wincaja.articulos (POS-only 30/32/50; NO se borra por el feed Kepler)
 *   'manual'  → curado a mano / huérfano (NUNCA auto-borrar)
 *
 * ADITIVO (columna nullable). Backfill en script aparte (backfill-products-source.js).
 * Idempotente (hasColumn). down() real.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('catalog').hasColumn('products', 'source'))) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.text('source'); // kepler | wincaja | manual (nullable hasta backfill)
    });
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS products_source_idx ON catalog.products (tenant_id, source)`);
  await knex.raw(`COMMENT ON COLUMN catalog.products.source IS
    'Origen del producto: kepler (kepler_ods.kdii) / wincaja (POS-only) / manual. Gobierna el reconcile del feed sync-product-master: solo source=kepler se auto-actualiza/soft-deletea.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS catalog.products_source_idx`);
  if (await knex.schema.withSchema('catalog').hasColumn('products', 'source')) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => t.dropColumn('source'));
  }
};
