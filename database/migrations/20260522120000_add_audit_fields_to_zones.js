/**
 * Audit + soft-delete + flag de sistema para la tabla `zones`.
 *
 * Motivación:
 *   - Borrar una zona referenciada por users/stores rompe la FK con error
 *     genérico de Postgres → necesitamos soft-delete + mensaje claro.
 *   - Las zonas semilla (LA PIEDAD, ZAMORA, MORELIA, NACIONAL, CANINDO)
 *     son referenciadas por UUID hardcoded en seeds y código; no deben
 *     poder borrarse ni renombrarse.
 *   - Audit para saber quién/cuándo modificó cada zona.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasActivo = await knex.schema.hasColumn('zones', 'activo');
  const hasUpdatedAt = await knex.schema.hasColumn('zones', 'updated_at');
  const hasCreatedBy = await knex.schema.hasColumn('zones', 'created_by');
  const hasUpdatedBy = await knex.schema.hasColumn('zones', 'updated_by');
  const hasIsSystem = await knex.schema.hasColumn('zones', 'is_system');

  await knex.schema.alterTable('zones', (table) => {
    if (!hasActivo) table.boolean('activo').notNullable().defaultTo(true);
    if (!hasUpdatedAt) table.timestamp('updated_at').defaultTo(knex.fn.now());
    if (!hasCreatedBy) {
      table
        .uuid('created_by')
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL');
    }
    if (!hasUpdatedBy) {
      table
        .uuid('updated_by')
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL');
    }
    if (!hasIsSystem) {
      table.boolean('is_system').notNullable().defaultTo(false);
    }
  });

  // Zonas semilla con UUIDs hardcoded en 20260409174829_refactor_zones.js.
  // Estas zonas no deben poder eliminarse ni renombrarse desde la UI.
  const SEED_ZONE_IDS = [
    'fb136f01-5efe-4c9f-b297-48f06574002c', // LA PIEDAD
    'b3e5d1cf-bf7e-419f-9037-b02f070bd2bc', // ZAMORA
    '2107b482-7d3a-4c82-9377-c9f2427e699e', // MORELIA
    'a5f9532e-a836-455c-9c8c-3df906615a5b', // NACIONAL
    'f63125c2-025f-4122-89f0-14f3c80ac0ca', // CANINDO
  ];
  await knex('zones').whereIn('id', SEED_ZONE_IDS).update({ is_system: true });

  // Índice combinado para acelerar el filtro habitual
  // `WHERE activo = true`.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_zones_activo ON zones (activo)',
  );
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_zones_activo');
  await knex.schema.alterTable('zones', (table) => {
    table.dropColumn('is_system');
    table.dropColumn('updated_by');
    table.dropColumn('created_by');
    table.dropColumn('updated_at');
    table.dropColumn('activo');
  });
};
