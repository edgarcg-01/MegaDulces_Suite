/**
 * FE.5 — Auto-factura al entregar un pedido:
 *   - commercial.customers: datos fiscales del receptor para CFDI nominativa
 *     (rfc y legal_name ya existen; el CP vive en billing_address->>'zip').
 *   - commercial.orders.cfdi_uuid: enlace + idempotencia (no re-facturar).
 *
 * Idempotente (hasColumn). NO destructivo.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('customers', 'regimen_fiscal'))) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => t.text('regimen_fiscal'));
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('customers', 'uso_cfdi'))) {
    await knex.schema.withSchema('commercial').alterTable('customers', (t) => t.text('uso_cfdi'));
  }
  if (!(await knex.schema.withSchema('commercial').hasColumn('orders', 'cfdi_uuid'))) {
    await knex.schema.withSchema('commercial').alterTable('orders', (t) => t.string('cfdi_uuid', 36));
    await knex.raw('CREATE INDEX IF NOT EXISTS ix_commercial_orders_cfdi ON commercial.orders (tenant_id, cfdi_uuid)');
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  // No destructivo: se conservan las columnas (contienen datos fiscales / enlaces CFDI).
};
