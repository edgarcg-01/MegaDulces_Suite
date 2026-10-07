/**
 * Agrega campos de auditoría a stores:
 *   - updated_at: timestamp de la última modificación
 *   - updated_by: usuario que aplicó la modificación
 *   - deleted_at: timestamp del soft-delete
 *   - deleted_by: usuario que aplicó el soft-delete
 *
 * Idempotente: verifica existencia antes de crear cada columna.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('stores', 'updated_at'),
    knex.schema.hasColumn('stores', 'updated_by'),
    knex.schema.hasColumn('stores', 'deleted_at'),
    knex.schema.hasColumn('stores', 'deleted_by'),
  ]);
  const [hasUpdatedAt, hasUpdatedBy, hasDeletedAt, hasDeletedBy] = cols;

  if (cols.every(Boolean)) return;

  await knex.schema.alterTable('stores', (table) => {
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
    knex.schema.hasColumn('stores', 'updated_at'),
    knex.schema.hasColumn('stores', 'updated_by'),
    knex.schema.hasColumn('stores', 'deleted_at'),
    knex.schema.hasColumn('stores', 'deleted_by'),
  ]);
  const [hasUpdatedAt, hasUpdatedBy, hasDeletedAt, hasDeletedBy] = cols;

  if (!cols.some(Boolean)) return;

  await knex.schema.alterTable('stores', (table) => {
    if (hasDeletedBy) table.dropColumn('deleted_by');
    if (hasDeletedAt) table.dropColumn('deleted_at');
    if (hasUpdatedBy) table.dropColumn('updated_by');
    if (hasUpdatedAt) table.dropColumn('updated_at');
  });
};
