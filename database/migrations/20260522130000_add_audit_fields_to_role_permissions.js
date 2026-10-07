/**
 * Audit fields para role_permissions.
 *
 * Cambiar los permisos de un rol es una operación de alto impacto: puede
 * otorgar acceso total a cualquiera, así que necesitamos saber quién/cuándo
 * los modificó.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasUpdatedAt = await knex.schema.hasColumn(
    'role_permissions',
    'updated_at',
  );
  const hasUpdatedBy = await knex.schema.hasColumn(
    'role_permissions',
    'updated_by',
  );

  await knex.schema.alterTable('role_permissions', (table) => {
    if (!hasUpdatedAt) table.timestamp('updated_at').defaultTo(knex.fn.now());
    if (!hasUpdatedBy) {
      table
        .uuid('updated_by')
        .nullable()
        .references('id')
        .inTable('users')
        .onDelete('SET NULL');
    }
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('role_permissions', (table) => {
    table.dropColumn('updated_by');
    table.dropColumn('updated_at');
  });
};
