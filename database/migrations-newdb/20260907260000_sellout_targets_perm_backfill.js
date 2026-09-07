/**
 * BI.9 — reparte COMMERCIAL_SELLOUT_TARGETS_GESTIONAR. Capturar metas es management:
 * se ancla a quien YA tiene COMMERCIAL_ANALYTICS_VER (los perfiles que ven la analitica
 * completa / command center), no a todo el que ve Sell-Out. El resto queda en false.
 *
 * Idempotente (`-> 'KEY' IS NULL`). Frontend gatea por JWT -> re-login. Verificar en prod:
 *   select role_name from role_permissions where permissions->'COMMERCIAL_SELLOUT_TARGETS_GESTIONAR' = 'true'::jsonb;
 *
 * @param { import("knex").Knex } knex
 */
const KEY = 'COMMERCIAL_SELLOUT_TARGETS_GESTIONAR';
const ANCHOR = 'COMMERCIAL_ANALYTICS_VER';

exports.up = async function (knex) {
  const bf = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('${KEY}',
              COALESCE((permissions->>'${ANCHOR}')::boolean, false))
      WHERE permissions -> '${KEY}' IS NULL`,
  );
  console.log(`[sellout_targets_perm_backfill] up (<- ${ANCHOR}): filas = ${bf.rowCount ?? 0}`);
};

exports.down = async function (knex) {
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions - '${KEY}' WHERE permissions -> '${KEY}' IS NOT NULL`,
  );
  console.log('[sellout_targets_perm_backfill] down: clave removida');
};
