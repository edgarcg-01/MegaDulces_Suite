/**
 * `[AU.19.1]` — Re-aplicar `security_invoker` a `v_position_history`.
 *
 * `[AU.19]` la recreó con `CREATE OR REPLACE VIEW` y **perdió la opción**: no se
 * hereda. La vista lee `identity.user_events`, que tiene RLS forzado, así que sin
 * `security_invoker` corre con los permisos del DUEÑO y el RLS no aplica.
 *
 * Es la misma trampa que ADR-057 documenta —y que la migración anterior citaba
 * en su comentario sin aplicarla—. Lo atrapó la aserción de metadata del candado
 * de `[OR.6]`, que existe exactamente para esto.
 */

exports.up = async function up(knex) {
  await knex.raw(`ALTER VIEW identity.v_position_history SET (security_invoker = true)`);

  const { rows } = await knex.raw(
    `SELECT c.reloptions FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'identity' AND c.relname = 'v_position_history'`,
  );
  const opts = rows[0]?.reloptions ?? [];
  if (!opts.some((o) => String(o).replace(/\s/g, '') === 'security_invoker=true')) {
    throw new Error(`[AU.19.1] security_invoker NO quedó puesto. reloptions: ${JSON.stringify(opts)}`);
  }
  console.log(`[AU.19.1] security_invoker verificado: ${JSON.stringify(opts)}`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER VIEW identity.v_position_history RESET (security_invoker)`);
};
