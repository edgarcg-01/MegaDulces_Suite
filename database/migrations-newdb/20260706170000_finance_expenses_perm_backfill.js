/**
 * Proyecto Finanzas — permiso FINANCE_EXPENSES_VER + backfill.
 *
 * Egresos contables sale del proyecto Ventas (/comercial/egresos →
 * /finanzas/egresos) y deja de gatearse con COMMERCIAL_ANALYTICS_VER: un rol
 * contable no debe arrastrar permisos comerciales. Para NO perder acceso en el
 * cambio de gate, todo rol que hoy tiene COMMERCIAL_ANALYTICS_VER hereda
 * FINANCE_EXPENSES_VER con el mismo valor. `customer_b2b` (externo) queda fuera.
 *
 * Idempotente: escribe la clave sólo si no existe (`-> 'KEY' IS NULL`, NO el
 * operador `?` que knex no escapa). Frontend gatea por JWT → requiere re-login.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('FINANCE_EXPENSES_VER',
              CASE WHEN role_name = 'customer_b2b' THEN false
                   ELSE COALESCE((permissions->>'COMMERCIAL_ANALYTICS_VER')::boolean, false) END)
      WHERE permissions -> 'FINANCE_EXPENSES_VER' IS NULL`,
  );
  console.log(`[finance_expenses_perm_backfill] up: filas actualizadas = ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions - 'FINANCE_EXPENSES_VER'
      WHERE permissions -> 'FINANCE_EXPENSES_VER' IS NOT NULL`,
  );
  console.log('[finance_expenses_perm_backfill] down: clave removida');
};
