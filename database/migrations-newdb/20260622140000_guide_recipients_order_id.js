/**
 * J12.0.x — logistics.guide_recipients.order_id.
 *
 * Liga cada destinatario de una guía con la orden comercial que se le entrega.
 * Permite itemizar las mercancías de la Carta Porte en repartos multi-drop
 * (unión de order_lines de las órdenes a bordo), en vez de depender del
 * shipments.order_id (1:1) que no representa un reparto real.
 *
 * Composite FK (tenant_id, order_id) → commercial.orders(tenant_id, id).
 * Idempotente. RLS heredada de la tabla.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('logistics').hasColumn('guide_recipients', 'order_id');
  if (!has) {
    await knex.raw(`ALTER TABLE logistics.guide_recipients ADD COLUMN order_id UUID`);
    await knex.raw(`
      ALTER TABLE logistics.guide_recipients
        ADD CONSTRAINT fk_logistics_guide_recipients_order
        FOREIGN KEY (tenant_id, order_id)
        REFERENCES commercial.orders(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_logistics_guide_recipients_tenant_order
        ON logistics.guide_recipients (tenant_id, order_id)
    `);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE logistics.guide_recipients DROP CONSTRAINT IF EXISTS fk_logistics_guide_recipients_order`);
  await knex.raw(`DROP INDEX IF EXISTS logistics.idx_logistics_guide_recipients_tenant_order`);
  await knex.raw(`ALTER TABLE logistics.guide_recipients DROP COLUMN IF EXISTS order_id`);
};
