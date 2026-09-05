/**
 * `[PREVENTA]` — promotor_ruta toma pedidos: rol incoherente corregido.
 *
 * promotor_ruta tenía COMMERCIAL_ORDERS_CONFIRMAR/FULFILL/CANCELAR pero NO CREAR ni VER
 * (no podía crear ni ver el pedido que sí podía confirmar/entregar) → 403 al tomar pedido,
 * Thot, sugerencias, nba y el sync offline de pedidos. Decisión de Edgar 2026-09-04: el
 * promotor SÍ vende. Se le conceden ORDERS_CREAR + ORDERS_VER + WAREHOUSES_VER (stock).
 *
 * Merge JSONB idempotente (`||`): re-correr deja los mismos valores. Solo toca promotor_ruta.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE identity.role_permissions
       SET permissions = permissions
             || '{"COMMERCIAL_ORDERS_CREAR":true,"COMMERCIAL_ORDERS_VER":true,"COMMERCIAL_WAREHOUSES_VER":true}'::jsonb,
           updated_at = now()
     WHERE role_name = 'promotor_ruta'`);
};

exports.down = async function down(knex) {
  await knex.raw(`
    UPDATE identity.role_permissions
       SET permissions = permissions
             - 'COMMERCIAL_ORDERS_CREAR' - 'COMMERCIAL_ORDERS_VER' - 'COMMERCIAL_WAREHOUSES_VER',
           updated_at = now()
     WHERE role_name = 'promotor_ruta'`);
};
