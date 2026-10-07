/**
 * Sprint orden — Schema `catalog` agrupa lógicamente las VIEWS y tablas del
 * dominio "catálogo de productos" sin mover las tablas subyacentes.
 *
 * Estrategia: las tablas reales viven en `public.*` (donde tienen sus FKs,
 * triggers, RLS, grants, y donde los ~50 services las consumen). Acá creamos
 * VIEWS read-only en `catalog.*` que apuntan a las mismas tablas — útil para:
 *
 *   1. Navegación mental en DBeaver/pgAdmin (ves el dominio agrupado)
 *   2. Reports/SQL ad-hoc que prefieren `catalog.products` como nombre claro
 *   3. Futuro: si en algún sprint movemos las tablas físicamente, los callers
 *      ya pueden estar acostumbrados al nombre `catalog.X`
 *
 * Las VIEWS son passthrough — los UPDATE/INSERT funcionan automáticamente en
 * pg salvo en MVs (que son read-only). Frontend/backend pueden seguir usando
 * `public.products` exactamente igual.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS catalog`);
  await knex.raw(`GRANT USAGE ON SCHEMA catalog TO app_runtime`);
  await knex.raw(`COMMENT ON SCHEMA catalog IS 'Dominio Catálogo: VIEWS lógicas sobre tablas que viven en public. Las tablas reales NO se movieron — esto es agrupación lógica para navegación y reports.'`);

  // catalog.products — passthrough de public.products (solo no eliminados)
  await knex.raw(`DROP VIEW IF EXISTS catalog.products`);
  await knex.raw(`
    CREATE VIEW catalog.products AS
    SELECT * FROM public.products WHERE deleted_at IS NULL
  `);
  await knex.raw(`COMMENT ON VIEW catalog.products IS 'Todos los productos del catálogo (no eliminados). Source: public.products. Alias del catálogo completo.'`);
  await knex.raw(`GRANT SELECT ON catalog.products TO app_runtime`);

  // catalog.products_active — passthrough de public.products_active (productos activos según ERP)
  await knex.raw(`DROP VIEW IF EXISTS catalog.products_active`);
  await knex.raw(`
    CREATE VIEW catalog.products_active AS
    SELECT * FROM public.products_active
  `);
  await knex.raw(`COMMENT ON VIEW catalog.products_active IS 'Productos comerciales activos según ERP Mega_Dulces.productos_activos. Source: public.products_active.'`);
  await knex.raw(`GRANT SELECT ON catalog.products_active TO app_runtime`);

  // catalog.products_top_sellers — passthrough de la MV
  await knex.raw(`DROP VIEW IF EXISTS catalog.products_top_sellers`);
  await knex.raw(`
    CREATE VIEW catalog.products_top_sellers AS
    SELECT * FROM public.products_top_sellers
  `);
  await knex.raw(`COMMENT ON VIEW catalog.products_top_sellers IS 'Top 1000 productos según ERP Mega_Dulces.ranking_productos. Source: public.products_top_sellers (MATERIALIZED VIEW refrescada @15min).'`);
  await knex.raw(`GRANT SELECT ON catalog.products_top_sellers TO app_runtime`);

  // catalog.brands — passthrough de public.brands (solo no eliminadas)
  await knex.raw(`DROP VIEW IF EXISTS catalog.brands`);
  await knex.raw(`
    CREATE VIEW catalog.brands AS
    SELECT * FROM public.brands WHERE deleted_at IS NULL
  `);
  await knex.raw(`COMMENT ON VIEW catalog.brands IS 'Marcas del catálogo (no eliminadas). Source: public.brands.'`);
  await knex.raw(`GRANT SELECT ON catalog.brands TO app_runtime`);

  // catalog.categories — passthrough de public.categories
  await knex.raw(`DROP VIEW IF EXISTS catalog.categories`);
  await knex.raw(`
    CREATE VIEW catalog.categories AS
    SELECT * FROM public.categories WHERE deleted_at IS NULL
  `);
  await knex.raw(`COMMENT ON VIEW catalog.categories IS 'Categorías de productos (no eliminadas). Source: public.categories.'`);
  await knex.raw(`GRANT SELECT ON catalog.categories TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS catalog.categories`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.brands`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.products_top_sellers`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.products_active`);
  await knex.raw(`DROP VIEW IF EXISTS catalog.products`);
  // No drop schema — puede que otras migraciones futuras lo usen.
};
