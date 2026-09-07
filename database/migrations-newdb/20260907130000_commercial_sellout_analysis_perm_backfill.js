/**
 * BI.0 — COMMERCIAL_SELLOUT_ANALYSIS_VER: permiso propio del sub-modulo "Analisis"
 * (Sell-Out BI). El sub-modulo lee el MISMO SellOutReport que el reporte base;
 * su permiso se reparte a quien YA puede ver Sell-Out para que el BI llegue por
 * default a los mismos roles, sin abrir el resto de la analitica.
 *
 * Reparto (calcado al hermano del mismo proyecto, receta de permisos): todo rol
 * con COMMERCIAL_SELLOUT_VER=true recibe COMMERCIAL_SELLOUT_ANALYSIS_VER=true.
 * El resto queda en false. Se ancla al hermano leido del estado vivo (no una
 * lista de roles inventada).
 *
 * Idempotente: solo escribe si la clave no existe (`-> 'KEY' IS NULL`, NO el
 * operador `?` que knex no escapa). Frontend gatea por JWT -> re-login requerido.
 *
 * OJO (gotcha /admin/roles): si alguien salvo un rol despues de declarar la clave
 * en el enum, esa clave aterriza en `false` y el backfill `IS NULL` la respeta a
 * proposito (no pisa decisiones manuales). Verificar en prod con:
 *   select role_name from role_permissions where permissions->'COMMERCIAL_SELLOUT_ANALYSIS_VER' = 'true'::jsonb;
 *
 * @param { import("knex").Knex } knex
 */
const KEY = 'COMMERCIAL_SELLOUT_ANALYSIS_VER';
const ANCHOR = 'COMMERCIAL_SELLOUT_VER';

exports.up = async function (knex) {
  const bf = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('${KEY}',
              COALESCE((permissions->>'${ANCHOR}')::boolean, false))
      WHERE permissions -> '${KEY}' IS NULL`,
  );
  console.log(`[sellout_analysis_perm_backfill] up backfill (<- ${ANCHOR}): filas = ${bf.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions - '${KEY}' WHERE permissions -> '${KEY}' IS NOT NULL`,
  );
  console.log('[sellout_analysis_perm_backfill] down: clave removida');
};
