/**
 * Helper canónico (post K-debt 2026-05-27): columna `activo BOOLEAN GENERATED
 * ALWAYS AS (deleted_at IS NULL) STORED` en las tablas multi-tenant que usan
 * soft-delete via `deleted_at`.
 *
 * Originalmente nació como compatibility shim para código legacy (Catalogs/
 * Reports/Visits) que usaba `WHERE activo=true`. El refactor K-debt eliminó
 * todos los WRITES al campo `activo` (ahora se escriben `deleted_at` directo)
 * y dejó esta columna como **helper de lectura permanente**: queries de
 * dashboards y joins pueden filtrar por boolean sin tener que envolver en
 * expresión `IS NULL`.
 *
 * **Semántica obligatoria**:
 *   - `activo` es READ-ONLY (GENERATED ALWAYS — Postgres rechaza UPDATEs).
 *   - Para soft-delete: `UPDATE x SET deleted_at = NOW()`.
 *   - Para reactivar: `UPDATE x SET deleted_at = NULL`.
 *   - `activo` se calcula automáticamente.
 *
 * **Sincronía con prod (`.245`)**: aplicar esta misma migración allá cuando
 * se sincronice. Si la columna ya existe, la migración es idempotente.
 *
 * Postgres 12+ requirement. Verificado en pg18.4.
 *
 * @param { import("knex").Knex } knex
 */
const TABLES = [
  'catalogs',
  'daily_assignments',
  'daily_captures',
  'exhibition_photos',
  'exhibitions',
  'role_permissions',
  'rubric_levels',
  'scoring_config',
  'scoring_config_versions',
  'scoring_weights',
  'visits',
  'zones',
];

exports.up = async function (knex) {
  for (const table of TABLES) {
    // Skip si la tabla no existe (defensa contra dropped schema en algún env).
    const exists = await knex.schema.hasTable(table);
    if (!exists) {
      // eslint-disable-next-line no-console
      console.warn(`[activo_virtual] tabla ${table} no existe, skip`);
      continue;
    }

    // Skip si ya tiene columna `activo` (algunos schemas pueden tenerla
    // legacy como BOOLEAN normal — no queremos rompérsela).
    const hasActivo = await knex.schema.hasColumn(table, 'activo');
    if (hasActivo) {
      // eslint-disable-next-line no-console
      console.log(`[activo_virtual] ${table} ya tiene activo, skip`);
      continue;
    }

    // Skip si la tabla NO tiene deleted_at (no podemos generar la columna).
    const hasDeletedAt = await knex.schema.hasColumn(table, 'deleted_at');
    if (!hasDeletedAt) {
      // eslint-disable-next-line no-console
      console.warn(`[activo_virtual] ${table} no tiene deleted_at, skip`);
      continue;
    }

    await knex.raw(`
      ALTER TABLE ${table}
        ADD COLUMN activo BOOLEAN GENERATED ALWAYS AS (deleted_at IS NULL) STORED
    `);
    // eslint-disable-next-line no-console
    console.log(`[activo_virtual] ${table}.activo agregado`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  for (const table of TABLES) {
    const exists = await knex.schema.hasTable(table);
    if (!exists) continue;
    const hasActivo = await knex.schema.hasColumn(table, 'activo');
    if (!hasActivo) continue;
    // Solo dropea si es GENERATED — no queremos borrar un `activo` legacy
    // que pudo haber sido restaurado a mano.
    const isGenerated = await knex.raw(
      `SELECT is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name=? AND column_name='activo'`,
      [table],
    );
    if (isGenerated.rows[0]?.is_generated === 'ALWAYS') {
      await knex.raw(`ALTER TABLE ${table} DROP COLUMN activo`);
    }
  }
};
