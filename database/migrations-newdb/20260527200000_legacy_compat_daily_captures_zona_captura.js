/**
 * Compat shim: agrega `zona_captura` a `daily_captures` para que el service
 * legacy (`apps/api/src/modules/daily-captures/`) pueda insertar sin
 * refactorear el código.
 *
 * El schema multi-tenant nuevo (migración 20260526000007_captures.js) eliminó
 * esta columna por audit 1.12 (zona se obtiene del store/user). Pero el
 * código legacy sigue mandándola en el INSERT. Agregar la columna como
 * NULL-able mantiene la denormalización para filtros downstream sin romper
 * inserts existentes.
 *
 * tenant_id NO necesita default: el trigger `auto_populate_tenant_id` lo
 * llena desde `current_tenant_id()` cuando el TenantContextInterceptor abre
 * el trx con SET LOCAL.
 *
 * Idempotente: ADD COLUMN IF NOT EXISTS + UPDATE solo donde es NULL.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('daily_captures', 'zona_captura');
  if (!has) {
    await knex.schema.alterTable('daily_captures', (t) => {
      t.string('zona_captura', 100).nullable();
    });
  }

  // Backfill desde users.zona_id → zones.name (best-effort, ignora si zona_id
  // del user es NULL).
  await knex.raw(`
    UPDATE daily_captures dc
    SET zona_captura = COALESCE(z.name, 'SIN_ZONA')
    FROM users u
    LEFT JOIN zones z ON z.id = u.zona_id
    WHERE dc.user_id = u.id AND dc.zona_captura IS NULL
  `);

  // GRANT explícito por si el ALTER no propagó default privileges.
  await knex.raw(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON daily_captures TO app_runtime',
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('daily_captures', 'zona_captura');
  if (has) {
    await knex.schema.alterTable('daily_captures', (t) => {
      t.dropColumn('zona_captura');
    });
  }
};
