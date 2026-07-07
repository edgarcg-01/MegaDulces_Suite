/**
 * SM.0/SM.1 — permisos RECONCILIATION_VER + RECONCILIATION_GESTIONAR + backfill.
 *
 * Gates del Supervisor de Movimientos (ADR-029). Se heredan de quien ya opera el
 * almacén: VER ← COMMERCIAL_INVENTORY_VER, GESTIONAR ← COMMERCIAL_INVENTORY_SUPERVISAR.
 * `customer_b2b` (externo) queda fuera. Admin con manage:all lo obtiene por RolesGuard.
 *
 * Idempotente: escribe cada clave sólo si no existe (`-> 'KEY' IS NULL`, NO el
 * operador `?` que knex no escapa). Frontend gatea por JWT → re-login.
 *
 * @param { import("knex").Knex } knex
 */
const ANCHOR = {
  RECONCILIATION_VER: 'COMMERCIAL_INVENTORY_VER',
  RECONCILIATION_GESTIONAR: 'COMMERCIAL_INVENTORY_SUPERVISAR',
};

exports.up = async function (knex) {
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[reconciliation_perms_backfill] up ${key} (← ${anchor}): filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of Object.keys(ANCHOR)) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`,
    );
  }
  console.log('[reconciliation_perms_backfill] down: claves removidas');
};
