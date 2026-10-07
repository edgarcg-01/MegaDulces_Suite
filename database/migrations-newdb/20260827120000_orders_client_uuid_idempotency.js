/**
 * Integridad preventa Fix #1 — idempotencia de pedidos por `client_uuid`.
 *
 * `commercial.orders` no tenía clave de idempotencia: si el device (app vendedor)
 * hace POST /commercial/orders, el server commitea el draft pero la respuesta se
 * pierde (timeout de red móvil), el device reintenta → SEGUNDO draft huérfano con
 * folio desperdiciado. Mismo patrón `sync_uuid` que ya usan las visitas offline.
 *
 * `client_uuid` = el id local del pedido en Dexie (`PedidoPendiente.id`). El backend
 * deduplica por (tenant_id, client_uuid): si ya existe, devuelve el pedido existente
 * en vez de crear otro. Índice único PARCIAL (solo filas con uuid y vivas) para no
 * chocar entre los pedidos legacy sin uuid (NULL) ni con soft-deletes.
 *
 * Idempotente: ADD COLUMN IF NOT EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.
 */

exports.up = async function up(knex) {
  await knex.raw(`ALTER TABLE commercial.orders ADD COLUMN IF NOT EXISTS client_uuid uuid`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_tenant_client_uuid
      ON commercial.orders (tenant_id, client_uuid)
      WHERE client_uuid IS NOT NULL AND deleted_at IS NULL`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_orders_tenant_client_uuid`);
  await knex.raw(`ALTER TABLE commercial.orders DROP COLUMN IF EXISTS client_uuid`);
};
