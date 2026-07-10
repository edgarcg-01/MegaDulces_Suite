/**
 * COMMERCIAL_SELLOUT_VER — permiso dedicado para el reporte Sell-Out por empresa
 * (RS), separado de COMMERCIAL_ANALYTICS_VER para poder dar acceso SOLO a ese
 * reporte sin abrir el resto de la analítica (command-center/salidas/360/etc.).
 *
 * Backfill (no-regresión): todo rol que hoy tiene COMMERCIAL_ANALYTICS_VER=true
 * recibe también COMMERCIAL_SELLOUT_VER=true (podían ver sell-out vía el gate
 * compartido; lo conservan). El resto queda en false.
 *
 * Grant de negocio: el rol `Auxiliar_mercadotecnia` recibe SELLOUT_VER=true
 * (su única superficie) de forma explícita, tenga o no analytics.
 *
 * Idempotente: el backfill sólo escribe si la clave no existe (`-> 'KEY' IS NULL`,
 * NO el operador `?` que knex no escapa). El grant al rol es un set incondicional
 * a true (re-ejecutar = no-op). Frontend gatea por JWT → re-login requerido.
 *
 * @param { import("knex").Knex } knex
 */
const KEY = 'COMMERCIAL_SELLOUT_VER';
const ANCHOR = 'COMMERCIAL_ANALYTICS_VER';
// role_name canónico en minúscula snake_case (los usuarios lo tienen así). La
// fila en prod se creó como 'Auxiliar_mercadotecnia' (mayúscula) → mismatch con
// el lookup case-sensitive del guard = 0 permisos. La mig 20260710150000 la
// renombra a minúscula; aquí ya usamos la forma canónica.
const SELLOUT_ROLE = 'auxiliar_mercadotecnia';

exports.up = async function (knex) {
  const bf = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('${KEY}',
              COALESCE((permissions->>'${ANCHOR}')::boolean, false))
      WHERE permissions -> '${KEY}' IS NULL`,
  );
  console.log(`[sellout_perm_backfill] up backfill (← ${ANCHOR}): filas = ${bf.rowCount ?? 0}`);

  const grant = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('${KEY}', true)
      WHERE role_name = ?`,
    [SELLOUT_ROLE],
  );
  console.log(`[sellout_perm_backfill] up grant "${SELLOUT_ROLE}": filas = ${grant.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(
    `UPDATE role_permissions SET permissions = permissions - '${KEY}' WHERE permissions -> '${KEY}' IS NOT NULL`,
  );
  console.log('[sellout_perm_backfill] down: clave removida');
};
