/**
 * Fase LM-K.0 — backfill del permiso `LOGISTICS_HOME_DISPATCH` + roles de tienda.
 *
 * El seed 02_mega_dulces_initial_roles.js ya lo incluye para setups frescos; los
 * role_permissions de prod/local no se re-siembran solos.
 *
 * 1. Otorga LOGISTICS_HOME_DISPATCH a superadmin/admin/encargado_sucursal.
 * 2. Inserta los roles `jefe_de_tienda`, `auxiliar_de_tienda`, `gerente_de_zona`
 *    (aún sin usuarios) con el set mínimo para capturar folio + despachar.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` + onConflict do-nothing.
 * Recordatorio: el permiso vive en el JWT → re-login de los afectados.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

  const patch = JSON.stringify({ LOGISTICS_HOME_DISPATCH: true });
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'LOGISTICS_HOME_DISPATCH' IS NULL`,
    { patch, roles: ['superadmin', 'admin', 'encargado_sucursal'] },
  );
  console.log(`[lmk_backfill] LOGISTICS_HOME_DISPATCH otorgado a ${res.rowCount ?? 0} rol(es).`);

  const store = {
    STORE_LIVE_VER: true,
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_ORDERS_VER: true,
    LOGISTICS_SHIPMENTS_VER: true,
    LOGISTICS_GUIDES_VER: true,
    LOGISTICS_GUIDES_GESTIONAR: true,
    LOGISTICS_HOME_DISPATCH: true,
  };
  const jefe = { ...store, LOGISTICS_FLEET_VER: true, ROUTE_CONTROL_VER: true };
  const gerente = {
    ...jefe,
    REPORTES_VER_EQUIPO: true,
    REPORTES_EXPORTAR: true,
  };

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);
    const rows = [
      ['jefe_de_tienda', jefe],
      ['auxiliar_de_tienda', store],
      ['gerente_de_zona', gerente],
    ];
    for (const [role_name, permissions] of rows) {
      await trx('role_permissions')
        .insert({
          tenant_id: MEGA_DULCES_TENANT_ID,
          role_name,
          permissions: JSON.stringify(permissions),
        })
        .onConflict(['tenant_id', 'role_name'])
        .ignore();
      console.log(`[lmk_backfill] Rol '${role_name}' asegurado.`);
    }
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  console.log('[lmk_backfill] down: no-op');
};
