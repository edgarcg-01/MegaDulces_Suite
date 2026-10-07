/**
 * Audit + soft-delete a la tabla `catalogs`.
 *
 * Motivación: borrar un ítem de scoring (concepto/ubicacion/nivel)
 * referenciado por capturas históricas o por la versión activa de scoring_config
 * rompe los reports y el cálculo de score_máximo. Esta migración:
 *
 *   - Agrega `activo` para soft-delete (mantener referencias intactas).
 *   - Agrega `updated_at`, `created_by`, `updated_by` para auditoría.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasActivo = await knex.schema.hasColumn('catalogs', 'activo');
  const hasUpdatedAt = await knex.schema.hasColumn('catalogs', 'updated_at');
  const hasCreatedBy = await knex.schema.hasColumn('catalogs', 'created_by');
  const hasUpdatedBy = await knex.schema.hasColumn('catalogs', 'updated_by');

  await knex.schema.alterTable('catalogs', (table) => {
    if (!hasActivo) {
      table.boolean('activo').notNullable().defaultTo(true);
    }
    if (!hasUpdatedAt) {
      table.timestamp('updated_at').defaultTo(knex.fn.now());
    }
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
  });

  // Índice combinado para acelerar el filtro habitual
  // `WHERE catalog_id = ? AND activo = true`.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_catalogs_type_activo ON catalogs (catalog_id, activo)',
  );
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_catalogs_type_activo');
  await knex.schema.alterTable('catalogs', (table) => {
    table.dropColumn('updated_by');
    table.dropColumn('created_by');
    table.dropColumn('updated_at');
    table.dropColumn('activo');
  });
};
