'use strict';
/**
 * Rol `captura_gastos` — "Solicitudes de gasto y comprobación".
 *
 * Para la gente del listado de gastos que NO tenía usuario en el sistema: no
 * necesitan nada más que subir el folio del gasto de Kepler y su comprobante,
 * así que nacen con el rol de menor privilegio posible en vez de colgarse de un
 * rol ancho existente.
 *
 * UN SOLO PERMISO: `FINANCE_EXPENSES_CAPTURAR`. Alcanza para todo
 * `/finanzas/capturar-gasto` — sus 5 endpoints aceptan
 * `RequireAnyPermission(FINANCE_EXPENSES_CAPTURAR, FINANCE_EXPENSES_VER)`.
 * Deliberadamente NO lleva `FINANCE_EXPENSES_VER`, que es el permiso ancho del
 * módulo de gastos (y uno de los 25 revocados en `20260820203000`), ni
 * `FINANCE_EXPENSES_COMPROBAR`, que es la bandeja de revisión.
 *
 * JSONB sparse a propósito: solo la clave que otorga. Mismo criterio que el rol
 * `cajera` (`20260730140000`) — un rol de un permiso no tiene por qué cargar el
 * diccionario completo en false.
 *
 * Idempotente: inserta solo en los tenants activos que aún no lo tienen.
 * Requiere RE-LOGIN (los permisos viajan en el JWT).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const res = await knex.raw(`
    INSERT INTO identity.role_permissions (id, tenant_id, role_name, permissions, created_at, updated_at)
    SELECT gen_random_uuid(), t.id, 'captura_gastos',
           '{"FINANCE_EXPENSES_CAPTURAR":true}'::jsonb, now(), now()
      FROM identity.tenants t
     WHERE t.activo = true
       AND NOT EXISTS (
         SELECT 1 FROM identity.role_permissions rp
          WHERE rp.tenant_id = t.id AND lower(rp.role_name) = 'captura_gastos'
       )
  `);
  console.log(`[role_captura_gastos] rol creado en ${res.rowCount ?? 0} tenant(s)`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  // RESTRICT en fk_users_tenant_role: si algún usuario lo tiene, hay que moverlo antes.
  const usados = await knex.raw(
    `SELECT count(*) n FROM identity.users WHERE lower(role_name) = 'captura_gastos' AND deleted_at IS NULL`,
  );
  if (Number(usados.rows[0].n) > 0) {
    throw new Error(
      `No se puede borrar el rol captura_gastos: ${usados.rows[0].n} usuario(s) lo tienen asignado.`,
    );
  }
  await knex.raw(`DELETE FROM identity.role_permissions WHERE lower(role_name) = 'captura_gastos'`);
};
