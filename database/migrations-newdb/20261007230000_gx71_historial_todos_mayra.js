/**
 * `[GX.71]` — **Mayra Gutiérrez ve el historial de gastos de ella y de todos.**
 *
 * Pedido del usuario (2026-10-07): *«al usuario de mayra_gutierrez dale el permiso de que pueda
 * ver el historial de ella y de todos»*.
 *
 * El historial de toda la empresa (pestaña «Todos» de `/finanzas/gastos-historial`, más
 * `GET /finance/expenses/proofs` y el calendario con `alcance=todos`) es **sólo god-mode**
 * desde `[GX.26]`. Para abrírselo a ella sin hacerla superadmin nace la llave
 * `FINANCE_EXPENSES_HISTORIAL_TODOS`, que esta migración le da **a ella sola**.
 *
 * ## ⚠️ Por qué va por PERSONA y no por rol
 * Mismo criterio que `[GX.17]` (la firma de Jesús Carrillo): su rol lo comparten otras
 * personas, y darle la llave al rol les abriría el gasto de toda la empresa a gente que nadie
 * nombró. `identity.user_permissions` es el mecanismo para esto.
 *
 * ⛔ **No se crea alcance nuevo para nadie más.** `FINANCE_EXPENSES_VER` sigue sin abrir el
 * historial de todos; la regla vive en `puedeVerHistorialDeTodos()` (contrato).
 *
 * Idempotente: `ON CONFLICT DO NOTHING` sobre la PK. **No** pisa un `allow = false` puesto a
 * mano desde `/admin/usuarios` — si alguien se lo quitó a propósito, se respeta.
 *
 * ⚠️ El backend lee los permisos frescos en cada petición (`RolesGuard`, caché de 30 s); la
 * pestaña en pantalla puede pedir **re-login** de Mayra si su sesión trae el mapa del token.
 *
 * @param { import("knex").Knex } knex
 */

const USERNAME = 'mayra_gutierrez';
const CLAVE = 'FINANCE_EXPENSES_HISTORIAL_TODOS';

exports.up = async function (knex) {
  // La tabla llegó con `[ID.21]`. Si el entorno es anterior, no se inventa nada: se avisa.
  const hay = await knex.schema.withSchema('identity').hasTable('user_permissions');
  if (!hay) {
    console.log('[gx71_historial_todos] identity.user_permissions no existe — nada que hacer');
    return;
  }

  const u = await knex('users').where({ username: USERNAME }).whereNull('deleted_at')
    .first('id', 'tenant_id', 'nombre', 'role_name');
  if (!u) {
    // No se falla: un entorno puede no tener a esta persona (local, una copia vieja). Lo que
    // no se hace es fingir que se aplicó.
    console.log(`[gx71_historial_todos] no existe el usuario ${USERNAME} en este entorno — se omite`);
    return;
  }

  const res = await knex.raw(
    `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota)
     VALUES (?, ?, ?, true, ?)
     ON CONFLICT (tenant_id, user_id, permission_key) DO NOTHING`,
    [u.tenant_id, u.id, CLAVE,
      '[GX.71] Ver el historial de gastos de ella y de todos. Por persona y no por su rol: sólo ella fue nombrada.'],
  );
  console.log(`[gx71_historial_todos] up: ${CLAVE} → ${u.nombre} (${USERNAME}, rol ${u.role_name}) · filas = ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  const hay = await knex.schema.withSchema('identity').hasTable('user_permissions');
  if (!hay) return;
  const u = await knex('users').where({ username: USERNAME }).first('id', 'tenant_id');
  if (!u) return;
  await knex('identity.user_permissions')
    .where({ tenant_id: u.tenant_id, user_id: u.id, permission_key: CLAVE })
    .del();
  console.log(`[gx71_historial_todos] down: ${CLAVE} retirado de ${USERNAME}`);
};
