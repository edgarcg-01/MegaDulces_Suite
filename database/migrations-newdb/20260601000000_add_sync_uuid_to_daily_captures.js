/**
 * Agrega sync_uuid a daily_captures para idempotencia end-to-end offline → server.
 *
 * El cliente offline genera un UUID v4 al crear la visita en Dexie. Lo envía
 * con el payload al sincronizar. El backend valida unicidad con UNIQUE constraint
 * — si un POST llega duplicado (p.ej. el cliente reintentó tras un 504 que sí
 * había escrito), retornamos la fila existente sin re-procesar Cloudinary.
 *
 * Esta es la MISMA migration que vivía en `database/migrations/` bajo el
 * knexfile legacy. Acá la replicamos para el knexfile-newdb (post-cutover),
 * porque en prod el knex_migrations sólo trackea las del directorio -newdb.
 *
 * NULL permitido para mantener compatibilidad con capturas creadas online
 * (no offline) que no envían sync_uuid.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasColumn = await knex.schema.hasColumn('public.daily_captures', 'sync_uuid');
  if (hasColumn) return;

  await knex.schema.withSchema('public').alterTable('daily_captures', (table) => {
    table.uuid('sync_uuid').nullable();
  });

  // UNIQUE parcial (sólo cuando sync_uuid no es NULL) — evita conflictos con
  // capturas online sin sync_uuid (todas NULL).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_daily_captures_sync_uuid
    ON public.daily_captures (sync_uuid)
    WHERE sync_uuid IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS uniq_daily_captures_sync_uuid');
  const hasColumn = await knex.schema.hasColumn('public.daily_captures', 'sync_uuid');
  if (hasColumn) {
    await knex.schema.withSchema('public').alterTable('daily_captures', (table) => {
      table.dropColumn('sync_uuid');
    });
  }
};
