/**
 * CS.3 — `finance.cash_ledger.origen_tipo` admite `'caos'`.
 *
 * La captura de Caja General se autorellena desde CAOS (la caja fuerte): un depósito/dispensación de
 * la máquina se registra en el libro con `origen_tipo='caos'` y `origen_ref='device|external_id'`, y
 * el arqueo precargado con las denominaciones que contó la máquina.
 *
 * El CHECK original (`20260918150000:134`) sólo permitía cfdi|recepcion|pago_proveedor|cobro|banco|
 * manual. Se recrea incluyendo 'caos'. Migración de seguimiento (no edita la aplicada). Idempotente.
 *
 * ⚠️ `origen_tipo='caos'` NO ancla a un documento (no está en `ORIGEN_ANCLADO`): el monto sale del
 * arqueo, no se relee de Kepler. El candado `ux_cash_ledger_origen_vivo (tenant_id, origen_tipo,
 * origen_ref)` (mig 20260921170000) garantiza que un movimiento de CAOS se capture UNA vez.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_origen_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_origen_chk CHECK (
      origen_tipo IS NULL OR origen_tipo IN
      ('cfdi','recepcion','pago_proveedor','cobro','banco','manual','caos')
    )`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_origen_chk`);
  await knex.raw(`
    ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_origen_chk CHECK (
      origen_tipo IS NULL OR origen_tipo IN
      ('cfdi','recepcion','pago_proveedor','cobro','banco','manual')
    )`);
};
