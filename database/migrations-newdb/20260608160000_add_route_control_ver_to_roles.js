/**
 * Backfill: otorga ROUTE_CONTROL_VER (vistas admin de "Cierre de ruta" y "Ventas
 * de vendedor" en /comercial) a los roles que lo definen en el seed.
 *
 * Contexto: ROUTE_CONTROL_VER está en ALL_PERMS del seed (→ superadmin/admin),
 * pero la key quedó AUSENTE del JSONB en todos los roles de prod (sembrados antes
 * de que existiera el permiso). Sin esto, ni "Cierre de ruta" ni la nueva pantalla
 * "Ventas de vendedor" aparecen en el nav, aunque la feature está deployada y el
 * permiso mapeado en ability.factory.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB — knex
 * no lo escapa). Solo agrega donde la key está ausente; deja intacto a colaborador
 * (false explícito) y roles externos.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles = ['superadmin', 'admin'];
  const patch = JSON.stringify({ ROUTE_CONTROL_VER: true });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'ROUTE_CONTROL_VER' IS NULL`,
    { patch, roles },
  );
  console.log(`[add_route_control_ver_to_roles] ROUTE_CONTROL_VER otorgado a ${result.rowCount ?? 0} rol(es).`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitarlo oculta las vistas de cierre de ruta / ventas de vendedor.
  console.log('[add_route_control_ver_to_roles] down: no-op');
};
