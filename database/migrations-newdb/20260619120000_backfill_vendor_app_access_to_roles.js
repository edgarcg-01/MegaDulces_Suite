/**
 * Backfill: otorga VENDOR_APP_ACCESS a los roles que deben entrar a la app de
 * vendedor standalone (apps/vendor). Sin esto, la key queda AUSENTE del JSONB
 * en roles sembrados antes de este permiso → el vendorGuard niega acceso una
 * vez retirado el fallback por role_name (incidente conocido: permiso nuevo que
 * nunca llega a prod porque el seed no se vuelve a correr).
 *
 * Roles otorgados:
 *   superadmin, admin → acceso total / soporte
 *   supervisor        → override gerencial
 *   vendedor, colaborador → vendedores de campo (toman pedidos)
 *
 * jefe_marketing / tele_operator / customer_b2b NO lo reciben (análisis, su
 * propia app de televenta, y portal B2B respectivamente).
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?` — knex no lo
 * escapa). Requiere RE-LOGIN para que el permiso entre al JWT del usuario.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const key = 'VENDOR_APP_ACCESS';
  const roles = ['superadmin', 'admin', 'supervisor', 'vendedor', 'colaborador'];
  const patch = JSON.stringify({ [key]: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> :key IS NULL`,
    { patch, roles, key },
  );
  console.log(
    `[backfill_vendor_app_access] ${key} otorgado a ${result.rowCount ?? 0} rol(es).`,
  );
};

exports.down = async function () {
  console.log('[backfill_vendor_app_access] down: no-op');
};
