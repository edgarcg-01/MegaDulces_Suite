/**
 * Backfill: otorga ROUTE_TICKET_CAPTURE (apartado "Agregar ticket" del vendedor —
 * subir tickets de venta/carga/combustible para cierre de ruta) a los roles que
 * lo usan en entornos ya sembrados.
 *
 * Contexto: el seed 02_mega_dulces_initial_roles.js ya lo incluye (ALL_PERMS →
 * superadmin/admin; explícito en `vendedor`), pero los role_permissions de prod
 * no se re-siembran. La key quedó AUSENTE del JSONB en todos los roles de prod,
 * así que el item de nav "Agregar ticket" (gateado por ROUTE_TICKET_CAPTURE) no
 * aparecía aunque la feature está deployada y el permiso mapeado en ability.factory.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO usar el operador `?` de JSONB —
 * knex no lo escapa). Solo agrega donde la key está ausente. NO toca `colaborador`
 * (lo tiene explícito en false) ni roles externos (tele_operator/customer_b2b).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles = ['superadmin', 'admin', 'vendedor'];
  const patch = JSON.stringify({ ROUTE_TICKET_CAPTURE: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'ROUTE_TICKET_CAPTURE' IS NULL`,
    { patch, roles },
  );
  console.log(`[add_route_ticket_capture_to_roles] ROUTE_TICKET_CAPTURE otorgado a ${result.rowCount ?? 0} rol(es).`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitarlo rompería el apartado "Agregar ticket" del vendedor.
  console.log('[add_route_ticket_capture_to_roles] down: no-op');
};
