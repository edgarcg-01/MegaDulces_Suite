'use strict';
/**
 * `[MCP.3.13]` — Pedido agrupado: un pedido del vendedor que se surte en VARIAS sucursales de su zona.
 *
 * Decisión de David (2026-10-23): en la toma de pedido cada producto elige de qué sucursal de la zona
 * se surte; para el vendedor y el cliente sigue siendo UN pedido. Diseño elegido («B · pedido
 * agrupado»): al MANDAR el pedido, los renglones de otra sucursal se mueven a una PARTE (otra fila de
 * `commercial.orders`, con su propia `warehouse_id`) y todas las partes apuntan al pedido principal.
 * Así cada parte se surte, se cobra en el Kepler de su sucursal y se recoge como cualquier pedido de
 * hoy (una sucursal por pedido), sin tocar los candados de surtido, ticket y guía.
 *
 * ── Lo que agrega ────────────────────────────────────────────────────────────────────────────
 *  · `order_lines.source_warehouse_id` — de qué sucursal se surte el renglón MIENTRAS es borrador.
 *    `NULL` = la del pedido (todo lo de hoy). Al separar, la parte queda con esa sucursal.
 *  · `orders.group_id` — el pedido principal del grupo (el del vendedor). `NULL` = pedido suelto
 *    (todo lo de hoy). El principal se apunta a sí mismo cuando tiene partes.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-23) ────────────────────────────────────────
 *  · `commercial.stock` vivo para las 8 sucursales centrales (actualizado 13:05).
 *  · `commercial.warehouses.purchase_zone` = la agrupación de David (La Piedad: 01–04 · Zamora:
 *    05, 06 · Morelia: 07, 08 · CEDIS «Corporativo»).
 *
 * Aditiva y nullable: el código de hoy no la lee. El código nuevo SÍ: aplicarla ANTES de desplegar.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasColumn('order_lines', 'source_warehouse_id'))) {
    await knex.schema.withSchema('commercial').alterTable('order_lines', (t) => {
      t.uuid('source_warehouse_id').nullable();
    });
    await knex.raw(`
      ALTER TABLE commercial.order_lines
        ADD CONSTRAINT order_lines_source_wh_fk
        FOREIGN KEY (tenant_id, source_warehouse_id) REFERENCES commercial.warehouses(tenant_id, id)`);
    await knex.raw(`COMMENT ON COLUMN commercial.order_lines.source_warehouse_id IS
      'MCP.3.13 — de qué sucursal de la zona se surte el renglón mientras el pedido es borrador. NULL = la del pedido. Al mandar el pedido, los renglones de otra sucursal se mueven a una parte (orders.group_id).'`);
  }

  if (!(await knex.schema.withSchema('commercial').hasColumn('orders', 'group_id'))) {
    await knex.schema.withSchema('commercial').alterTable('orders', (t) => {
      t.uuid('group_id').nullable();
    });
    await knex.raw(`
      ALTER TABLE commercial.orders
        ADD CONSTRAINT orders_group_fk
        FOREIGN KEY (tenant_id, group_id) REFERENCES commercial.orders(tenant_id, id)`);
    await knex.raw(`COMMENT ON COLUMN commercial.orders.group_id IS
      'MCP.3.13 — pedido principal del grupo (el del vendedor). Las partes de otras sucursales apuntan a él y él a sí mismo. NULL = pedido suelto.'`);
  }
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_orders_group
      ON commercial.orders (tenant_id, group_id) WHERE group_id IS NOT NULL`);

  // ── COMPUERTA ────────────────────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(`
    SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'commercial' AND table_name = 'order_lines' AND column_name = 'source_warehouse_id') AS linea,
      EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'commercial' AND table_name = 'orders' AND column_name = 'group_id') AS grupo`);
  if (!rows[0]?.linea || !rows[0]?.grupo) throw new Error('[MCP.3.13] no quedaron las columnas del pedido agrupado.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS commercial.idx_orders_group');
  await knex.raw('ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS orders_group_fk');
  await knex.raw('ALTER TABLE commercial.orders DROP COLUMN IF EXISTS group_id');
  await knex.raw('ALTER TABLE commercial.order_lines DROP CONSTRAINT IF EXISTS order_lines_source_wh_fk');
  await knex.raw('ALTER TABLE commercial.order_lines DROP COLUMN IF EXISTS source_warehouse_id');
};
