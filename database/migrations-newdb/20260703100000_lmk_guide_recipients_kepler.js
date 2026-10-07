/**
 * Fase LM-K.0 — `logistics.guide_recipients` referencia un ticket de Kepler.
 *
 * En el flujo Kepler la venta ya está en el POS (folio); la entrega REFERENCIA el
 * folio (no materializa commercial.orders, no mueve stock). Se guarda:
 *   - kepler_folio / kepler_serie / kepler_warehouse_code: identidad del ticket.
 *   - items_snapshot JSONB: líneas del ticket (qué CARGAR) — snapshot porque
 *     analytics.store_live_tickets tiene retención ~3d.
 *   - collect_on_delivery + amount_to_collect: si el repartidor COBRA (COD) o no
 *     (CONTADO = ya pagado en tienda). Default derivado de forma_pago en la captura.
 *
 * order_id (FK a commercial.orders) sigue existiendo para el flujo de intake propio
 * (LM.2); una parada usa order_id O kepler_folio, no ambos.
 *
 * Idempotente (hasColumn + DROP CONSTRAINT IF EXISTS).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('logistics').hasColumn('guide_recipients', col))) {
      await knex.raw(`ALTER TABLE logistics.guide_recipients ADD COLUMN ${ddl}`);
    }
  };

  await add('kepler_folio', 'kepler_folio VARCHAR(40)');
  await add('kepler_serie', 'kepler_serie VARCHAR(40)');
  await add('kepler_warehouse_code', 'kepler_warehouse_code VARCHAR(10)');
  await add('items_snapshot', 'items_snapshot JSONB');
  await add('collect_on_delivery', 'collect_on_delivery BOOLEAN NOT NULL DEFAULT false');
  await add('amount_to_collect', 'amount_to_collect DECIMAL(14,2)');

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_logistics_guide_recipients_kepler
      ON logistics.guide_recipients (tenant_id, kepler_warehouse_code, kepler_serie, kepler_folio)
      WHERE kepler_folio IS NOT NULL
  `);

  await knex.raw(`
    COMMENT ON COLUMN logistics.guide_recipients.items_snapshot IS
      'Fase LM-K: líneas del ticket Kepler (qué cargar). Snapshot [{sku,nombre,cant,importe}].'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS logistics.idx_logistics_guide_recipients_kepler`);
  for (const col of [
    'amount_to_collect',
    'collect_on_delivery',
    'items_snapshot',
    'kepler_warehouse_code',
    'kepler_serie',
    'kepler_folio',
  ]) {
    await knex.raw(`ALTER TABLE logistics.guide_recipients DROP COLUMN IF EXISTS ${col}`);
  }
};
