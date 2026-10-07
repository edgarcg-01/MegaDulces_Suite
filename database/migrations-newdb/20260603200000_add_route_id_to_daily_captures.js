/**
 * Ruta self-service en /captures — etiqueta cada captura con la ruta en la que
 * el colaborador/vendedor estaba al momento de capturar.
 *
 * `route_id` → FK COMPUESTA `(tenant_id, route_id)` a `catalogs (tenant_id, id)`
 * (filas con catalog_id='rutas'), igual que `daily_assignments.route_id` y
 * `stores.ruta_id` (ver 20260526000005_field_operations). Nullable + SET NULL:
 * borrar una ruta del catálogo NO debe orfanar capturas históricas; nullable
 * para compat con todas las capturas existentes.
 *
 * IMPORTANTE (search_path): el search_path de la DB es
 *   `identity, catalog, field_ops, scoring, commercial, logistics, public`
 * así que `daily_captures` sin calificar resuelve a la VIEW
 * `field_ops.daily_captures` (passthrough creada en 20260603130000), no a la
 * tabla. El app (user postgres) lee/escribe vía esa vista. Por eso:
 *   1. ALTER se hace sobre `public.daily_captures` (la tabla real).
 *   2. Se RECREA la vista `field_ops.daily_captures` para que exponga la nueva
 *      columna (las views `SELECT *` fijan sus columnas al crearse → no pickean
 *      columnas nuevas automáticamente).
 *
 * Idempotente: guard hasColumn. RLS column-agnostic → sin cambios de policy.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema
    .withSchema('public')
    .hasColumn('daily_captures', 'route_id');
  if (!has) {
    await knex.schema.withSchema('public').alterTable('daily_captures', (table) => {
      table.uuid('route_id'); // FK compuesta a catalogs(tenant_id, id), catalog_id='rutas'
      table
        .foreign(['tenant_id', 'route_id'], 'fk_daily_captures_tenant_route')
        .references(['tenant_id', 'id'])
        .inTable('public.catalogs')
        .onDelete('SET NULL');
      table.index(['tenant_id', 'route_id'], 'idx_daily_captures_tenant_route');
    });
  }

  // Recrear la VIEW passthrough para que exponga route_id (idempotente).
  await knex.raw(`DROP VIEW IF EXISTS field_ops.daily_captures`);
  await knex.raw(
    `CREATE VIEW field_ops.daily_captures AS SELECT * FROM public.daily_captures`,
  );
  await knex.raw(`GRANT SELECT ON field_ops.daily_captures TO app_runtime`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // La vista depende de la columna (SELECT * la expande explícitamente) → hay
  // que dropearla antes de quitar la columna, y recrearla después sin route_id.
  await knex.raw(`DROP VIEW IF EXISTS field_ops.daily_captures`);

  const has = await knex.schema
    .withSchema('public')
    .hasColumn('daily_captures', 'route_id');
  if (has) {
    await knex.schema.withSchema('public').alterTable('daily_captures', (table) => {
      table.dropForeign(['tenant_id', 'route_id'], 'fk_daily_captures_tenant_route');
      table.dropIndex(['tenant_id', 'route_id'], 'idx_daily_captures_tenant_route');
      table.dropColumn('route_id');
    });
  }

  await knex.raw(
    `CREATE VIEW field_ops.daily_captures AS SELECT * FROM public.daily_captures`,
  );
  await knex.raw(`GRANT SELECT ON field_ops.daily_captures TO app_runtime`);
};
