/**
 * Agrega tracking de último login a `public.users` para que el admin pueda
 * verificar quién está usando la app y cuándo fue su última entrada.
 *
 * Columnas nuevas (todas nullable — usuarios existentes quedan en NULL hasta
 * que vuelvan a loguearse):
 *   - `last_login_at`        TIMESTAMPTZ  fecha/hora del último login exitoso
 *   - `last_login_ip`        VARCHAR(45)  IP (v4 o v6 max 39 chars + margen)
 *   - `last_login_user_agent` TEXT        User-Agent del request
 *
 * Idempotente: hasColumn antes de addColumn (convención del proyecto).
 *
 * Sin migration de data: prefer dejar NULL a inventar timestamps. La UI
 * muestra "Nunca" cuando es NULL.
 *
 * Index parcial sobre `last_login_at` para queries de tipo "usuarios
 * inactivos hace más de N días" — sólo indexa filas no-NULL.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const cols = await Promise.all([
    knex.schema.hasColumn('public.users', 'last_login_at'),
    knex.schema.hasColumn('public.users', 'last_login_ip'),
    knex.schema.hasColumn('public.users', 'last_login_user_agent'),
  ]);

  await knex.schema.withSchema('public').alterTable('users', (table) => {
    if (!cols[0]) table.timestamp('last_login_at', { useTz: true }).nullable();
    if (!cols[1]) table.string('last_login_ip', 45).nullable();
    if (!cols[2]) table.text('last_login_user_agent').nullable();
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_last_login_at
    ON public.users (tenant_id, last_login_at DESC)
    WHERE last_login_at IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS public.idx_users_last_login_at');
  await knex.schema.withSchema('public').alterTable('users', (table) => {
    table.dropColumn('last_login_user_agent');
    table.dropColumn('last_login_ip');
    table.dropColumn('last_login_at');
  });
};
