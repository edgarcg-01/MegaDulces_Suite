/**
 * Fase CBW (ADR-042) — manejo de errores de la captura bancaria por WhatsApp.
 *
 * Agrega `error_detail` a `finance.bank_capture_inbox`: registra QUÉ salió mal
 * (no se subió la imagen / no es un comprobante válido / no se pudo escribir en el
 * libro) para que la bandeja lo muestre y Crédito y Cobranza pueda intervenir. Se
 * limpia (NULL) cuando la captura se resuelve bien. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasColumn('bank_capture_inbox', 'error_detail'))) {
    await knex.raw(`ALTER TABLE finance.bank_capture_inbox ADD COLUMN error_detail text`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('finance').hasColumn('bank_capture_inbox', 'error_detail')) {
    await knex.raw(`ALTER TABLE finance.bank_capture_inbox DROP COLUMN error_detail`);
  }
};
