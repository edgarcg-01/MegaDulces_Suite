/**
 * Fase LM-K.0 — `commercial.payments` acepta cobros ligados a un folio de Kepler.
 *
 * El cobro COD de un ticket Kepler (que NO materializa commercial.orders) debe
 * entrar al MISMO ledger para que el arqueo/liquidación (LM.5) lo cuadre. Por eso:
 *   - order_id → NULLABLE (el pago puede no tener orden commercial).
 *   - customer_id → NULLABLE (venta Kepler CONTADO = walk-in sin cliente commercial).
 *   - kepler_folio / kepler_serie / kepler_warehouse_code: identidad del ticket.
 *   - CHECK: el pago referencia una orden O un folio Kepler (al menos uno).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.payments ALTER COLUMN order_id DROP NOT NULL`);
  await knex.raw(`ALTER TABLE commercial.payments ALTER COLUMN customer_id DROP NOT NULL`);

  const add = async (col, ddl) => {
    if (!(await knex.schema.hasColumn('commercial.payments', col))) {
      await knex.raw(`ALTER TABLE commercial.payments ADD COLUMN ${ddl}`);
    }
  };
  await add('kepler_folio', 'kepler_folio VARCHAR(40)');
  await add('kepler_serie', 'kepler_serie VARCHAR(40)');
  await add('kepler_warehouse_code', 'kepler_warehouse_code VARCHAR(10)');

  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_origin_check`);
  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT commercial_payments_origin_check
      CHECK (order_id IS NOT NULL OR kepler_folio IS NOT NULL)
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_commercial_payments_kepler
      ON commercial.payments (tenant_id, kepler_warehouse_code, kepler_serie, kepler_folio)
      WHERE kepler_folio IS NOT NULL
  `);

  await knex.raw(`
    COMMENT ON COLUMN commercial.payments.kepler_folio IS
      'Fase LM-K: folio del ticket Kepler cobrado COD (cuando no hay commercial.orders). Alimenta el arqueo.'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commercial_payments_kepler`);
  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_origin_check`);
  for (const col of ['kepler_warehouse_code', 'kepler_serie', 'kepler_folio']) {
    await knex.raw(`ALTER TABLE commercial.payments DROP COLUMN IF EXISTS ${col}`);
  }
  // No re-imponemos NOT NULL en down: podría haber filas Kepler sin order_id/customer_id.
};
