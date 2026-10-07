/**
 * Columnas canónicas (post K-debt 2026-05-27): originalmente shim de
 * compatibilidad, ahora promovidas a columnas de primera clase del schema
 * multi-tenant. El refactor K-debt confirmó que vale la pena mantenerlas:
 *
 * - `zones.is_system` (BOOLEAN, default false): flag para distinguir zonas
 *   semilla del sistema (no renombrables, no eliminables) de zonas creadas
 *   por usuarios. En el seed actual `is_system=false` para todas; se setea
 *   a `true` manualmente cuando Mega Dulces designa una zona crítica.
 *   `CatalogsService` lo usa en `update()` y `delete()` para bloquear ops.
 *
 * - `daily_captures.captured_by_username` (VARCHAR): **snapshot denormalizado**
 *   del nombre del usuario al momento de la captura. Útil para audit:
 *   si el usuario se renombra después, los reportes históricos preservan
 *   el nombre original (vs. JOIN que mostraría el nombre actual).
 *   Mantenido por VisitsService.checkIn y captures/daily-captures inserts.
 *   Backfill inicial desde `users.username`.
 *
 * Idempotente.
 *
 * **Sincronía con prod (`.245`)**: aplicar esta migración allá también.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── zones.is_system ──────────────────────────────────────────────────
  if (await knex.schema.hasTable('zones')) {
    const has = await knex.schema.hasColumn('zones', 'is_system');
    if (!has) {
      await knex.raw(
        `ALTER TABLE zones ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false`,
      );
      // eslint-disable-next-line no-console
      console.log('[legacy_cols] zones.is_system agregado (default false)');
    }
  }

  // ── daily_captures.captured_by_username ──────────────────────────────
  if (await knex.schema.hasTable('daily_captures')) {
    const has = await knex.schema.hasColumn(
      'daily_captures',
      'captured_by_username',
    );
    if (!has) {
      await knex.raw(
        `ALTER TABLE daily_captures ADD COLUMN captured_by_username VARCHAR(150)`,
      );
      // Backfill desde users (1:N, daily_captures.user_id → users.id).
      const result = await knex.raw(`
        UPDATE daily_captures dc
        SET captured_by_username = u.username
        FROM users u
        WHERE u.id = dc.user_id AND dc.captured_by_username IS NULL
      `);
      // eslint-disable-next-line no-console
      console.log(
        `[legacy_cols] daily_captures.captured_by_username agregado + backfill (${result.rowCount} rows)`,
      );
    }
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  if (await knex.schema.hasTable('daily_captures')) {
    const has = await knex.schema.hasColumn(
      'daily_captures',
      'captured_by_username',
    );
    if (has) {
      await knex.raw(
        `ALTER TABLE daily_captures DROP COLUMN captured_by_username`,
      );
    }
  }
  if (await knex.schema.hasTable('zones')) {
    const has = await knex.schema.hasColumn('zones', 'is_system');
    if (has) {
      await knex.raw(`ALTER TABLE zones DROP COLUMN is_system`);
    }
  }
};
