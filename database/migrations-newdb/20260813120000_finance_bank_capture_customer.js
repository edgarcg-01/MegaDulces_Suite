/**
 * Fase CBW.6 (ADR-042) — Cobranza dura: liga el depósito por WhatsApp al CLIENTE.
 *
 * Los remitentes autorizados NO son solo encargados internos: son los CLIENTES de
 * telemarketing (grupo Kepler 1M001, ~80) que pagan por depósito/transferencia y
 * mandan su ficha. El teléfono los identifica → atribuimos el depósito al cliente
 * (clave Kepler + RFC) para cobranza. La clave Kepler (`customer_code`) es el join
 * a `analytics.erp_collections.cliente_code` (cobros UA0501, Fase CC).
 *
 * Agrega (idempotente):
 *   - bank_capture_senders: customer_code (clave Kepler, ej C1002), rfc.
 *   - bank_capture_inbox:   customer_code, rfc (denormalizados en la captura).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const addCol = async (table, col, ddl) => {
    if (!(await knex.schema.withSchema('finance').hasColumn(table, col))) {
      await knex.raw(`ALTER TABLE finance.${table} ADD COLUMN ${ddl}`);
    }
  };
  await addCol('bank_capture_senders', 'customer_code', 'customer_code text');
  await addCol('bank_capture_senders', 'rfc', 'rfc text');
  await addCol('bank_capture_inbox', 'customer_code', 'customer_code text');
  await addCol('bank_capture_inbox', 'rfc', 'rfc text');
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_bci_customer ON finance.bank_capture_inbox (tenant_id, customer_code)`);
};

exports.down = async function (knex) {
  const dropCol = async (table, col) => {
    if (await knex.schema.withSchema('finance').hasColumn(table, col)) {
      await knex.raw(`ALTER TABLE finance.${table} DROP COLUMN ${col}`);
    }
  };
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_bci_customer`);
  await dropCol('bank_capture_inbox', 'rfc');
  await dropCol('bank_capture_inbox', 'customer_code');
  await dropCol('bank_capture_senders', 'rfc');
  await dropCol('bank_capture_senders', 'customer_code');
};
