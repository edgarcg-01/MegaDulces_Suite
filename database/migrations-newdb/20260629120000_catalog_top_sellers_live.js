/**
 * Tabla `catalog.top_sellers_live` — best-sellers alimentados por la VENTA REAL
 * consolidada de las 6 sucursales Kepler (feed on-prem
 * import-top-sellers-from-consolidado.js, ventana 90d), en reemplazo del ranking
 * stale del ERP. La lee el endpoint `commercial-pricing.listTopSellers` (portal
 * home/catálogo).
 *
 * Aditiva: NO toca el MV/tabla viejo `catalog.products_top_sellers` (queda como
 * estaba). Mismo shape de columnas que ese objeto para swap transparente.
 * Idempotente. Solo schema `catalog`.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('catalog').hasTable('top_sellers_live')) return;
  await knex.raw(`
    CREATE TABLE catalog.top_sellers_live (
      id          uuid,
      tenant_id   uuid NOT NULL,
      sku         varchar,
      nombre      varchar,
      brand_id    uuid,
      barcode     varchar,
      category_id uuid,
      cost_base   numeric,
      image_url   text,
      units_sold  numeric,
      revenue     numeric,
      cases_sold  bigint,
      units_total numeric,
      sales_rank  int
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS top_sellers_live_pk ON catalog.top_sellers_live (tenant_id, id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_top_sellers_live_rank ON catalog.top_sellers_live (tenant_id, sales_rank)`);
  // app_runtime escribe (feed on-prem usa postgres; runtime solo lee, pero
  // dejamos los privilegios alineados con products_top_sellers).
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON catalog.top_sellers_live TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('catalog').dropTableIfExists('top_sellers_live');
};
