/**
 * Agrega campos de auditoría a daily_assignments:
 *   - updated_at: timestamp de la última modificación (auto)
 *   - updated_by: usuario que aplicó la última modificación
 *
 * Idempotente: verifica existencia antes de crear cada columna.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  const hasUpdatedAt = await knex.schema.hasColumn(
    'daily_assignments',
    'updated_at',
  );
  const hasUpdatedBy = await knex.schema.hasColumn(
    'daily_assignments',
    'updated_by',
  );

  if (!hasUpdatedAt || !hasUpdatedBy) {
    await knex.schema.alterTable('daily_assignments', (table) => {
      if (!hasUpdatedAt) {
        table.timestamp('updated_at').defaultTo(knex.fn.now());
      }
      if (!hasUpdatedBy) {
        table.uuid('updated_by').references('id').inTable('users').nullable();
      }
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  const hasUpdatedAt = await knex.schema.hasColumn(
    'daily_assignments',
    'updated_at',
  );
  const hasUpdatedBy = await knex.schema.hasColumn(
    'daily_assignments',
    'updated_by',
  );

  if (hasUpdatedAt || hasUpdatedBy) {
    await knex.schema.alterTable('daily_assignments', (table) => {
      if (hasUpdatedBy) table.dropColumn('updated_by');
      if (hasUpdatedAt) table.dropColumn('updated_at');
    });
  }
};
