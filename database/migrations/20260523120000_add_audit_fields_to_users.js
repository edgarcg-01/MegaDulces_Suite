/**
 * Agrega campos de auditoría a users:
 *   - updated_at, updated_by
 *   - deleted_at, deleted_by (para el soft-delete vía activo=false)
 *
 * Idempotente: verifica existencia antes de crear cada columna.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('users', 'updated_at'),
    knex.schema.hasColumn('users', 'updated_by'),
    knex.schema.hasColumn('users', 'deleted_at'),
    knex.schema.hasColumn('users', 'deleted_by'),
  ]);
  const [hasUpdatedAt, hasUpdatedBy, hasDeletedAt, hasDeletedBy] = cols;

  if (cols.every(Boolean)) return;

  await knex.schema.alterTable('users', (table) => {
    if (!hasUpdatedAt) table.timestamp('updated_at').defaultTo(knex.fn.now());
    if (!hasUpdatedBy) {
      table.uuid('updated_by').references('id').inTable('users').nullable();
    }
    if (!hasDeletedAt) table.timestamp('deleted_at').nullable();
    if (!hasDeletedBy) {
      table.uuid('deleted_by').references('id').inTable('users').nullable();
    }
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('users', 'updated_at'),
    knex.schema.hasColumn('users', 'updated_by'),
    knex.schema.hasColumn('users', 'deleted_at'),
    knex.schema.hasColumn('users', 'deleted_by'),
  ]);
  const [hasUpdatedAt, hasUpdatedBy, hasDeletedAt, hasDeletedBy] = cols;

  if (!cols.some(Boolean)) return;

  await knex.schema.alterTable('users', (table) => {
    if (hasDeletedBy) table.dropColumn('deleted_by');
    if (hasDeletedAt) table.dropColumn('deleted_at');
    if (hasUpdatedBy) table.dropColumn('updated_by');
    if (hasUpdatedAt) table.dropColumn('updated_at');
  });
};
