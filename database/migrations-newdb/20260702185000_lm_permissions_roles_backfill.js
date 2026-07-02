/**
 * Fase LM.0 — backfill de permisos + roles nuevos (entornos ya sembrados).
 *
 * El seed 02_mega_dulces_initial_roles.js ya incluye esto para setups frescos,
 * pero los role_permissions de prod/local no se re-siembran solos.
 *
 * 1. Otorga los 3 permisos LM (PAYMENTS_VERIFICAR/REVERSAR + RIDER_LIQUIDATION_
 *    GESTIONAR) a superadmin/admin (drift-safety; el god-mode es por rol pero se
 *    mantienen explícitos como el resto).
 * 2. Inserta los roles `repartidor` y `encargado_sucursal` si no existen.
 *
 * Idempotente: `permissions -> 'KEY' IS NULL` (NO el operador `?` de JSONB —
 * knex no lo escapa) + onConflict do-nothing para los roles nuevos. Mapa parcial
 * (solo perms en true): las claves ausentes se tratan como no otorgadas.
 *
 * Recordatorio: el permiso vive en el JWT → usuarios afectados deben RE-LOGUEARSE.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const MEGA_DULCES_TENANT_ID = '00000000-0000-0000-0000-00000000d01c';

  // 1) Patch a roles de plataforma.
  const patch = JSON.stringify({
    COMMERCIAL_PAYMENTS_VERIFICAR: true,
    COMMERCIAL_PAYMENTS_REVERSAR: true,
    COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR: true,
  });
  const patchRes = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND permissions -> 'COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR' IS NULL`,
    { patch, roles: ['superadmin', 'admin'] },
  );
  console.log(`[lm_backfill] LM perms otorgados a ${patchRes.rowCount ?? 0} rol(es) de plataforma.`);

  // 2) Roles nuevos (mapa parcial: solo perms en true).
  const repartidor = {
    VENDOR_APP_ACCESS: true,
    LOGISTICS_SHIPMENTS_VER: true,
    LOGISTICS_GUIDES_VER: true,
    LOGISTICS_GUIDES_GESTIONAR: true,
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_PRICING_VER: true,
    COMMERCIAL_ORDERS_VER: true,
    COMMERCIAL_ORDERS_FULFILL: true,
    COMMERCIAL_ORDERS_CANCELAR: true,
    COMMERCIAL_PAYMENTS_REGISTRAR: true,
    ROUTE_TICKET_CAPTURE: true,
  };
  const encargado = {
    REPORTES_VER_EQUIPO: true,
    REPORTES_EXPORTAR: true,
    COMMERCIAL_CUSTOMERS_VER: true,
    COMMERCIAL_CUSTOMERS_GESTIONAR: true,
    COMMERCIAL_WAREHOUSES_VER: true,
    COMMERCIAL_PRICING_VER: true,
    COMMERCIAL_INVENTORY_VER: true,
    COMMERCIAL_ORDERS_VER: true,
    COMMERCIAL_ORDERS_CREAR: true,
    COMMERCIAL_ORDERS_CONFIRMAR: true,
    COMMERCIAL_ORDERS_CANCELAR: true,
    COMMERCIAL_ORDERS_FULFILL: true,
    COMMERCIAL_PAYMENTS_REGISTRAR: true,
    COMMERCIAL_PAYMENTS_VERIFICAR: true,
    COMMERCIAL_PAYMENTS_REVERSAR: true,
    COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR: true,
    COMMERCIAL_PROMOTIONS_VER: true,
    ROUTE_CONTROL_VER: true,
    LOGISTICS_FLEET_VER: true,
    LOGISTICS_SHIPMENTS_VER: true,
    LOGISTICS_SHIPMENTS_GESTIONAR: true,
    LOGISTICS_GUIDES_VER: true,
    LOGISTICS_GUIDES_GESTIONAR: true,
    LOGISTICS_EXPENSES_VER: true,
  };

  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA_DULCES_TENANT_ID}'`);
    for (const [role_name, permissions] of [['repartidor', repartidor], ['encargado_sucursal', encargado]]) {
      await trx('role_permissions')
        .insert({
          tenant_id: MEGA_DULCES_TENANT_ID,
          role_name,
          permissions: JSON.stringify(permissions),
        })
        .onConflict(['tenant_id', 'role_name'])
        .ignore();
      console.log(`[lm_backfill] Rol '${role_name}' asegurado.`);
    }
  });
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: quitar los permisos/roles rompería la operación de última milla.
  console.log('[lm_backfill] down: no-op');
};
