/**
 * CP.2 (Fase CP, ADR-035) — Crosswalk cuenta de banco CB ↔ cuenta contable ContPAQi.
 *
 * Agrega a `finance.bank_accounts` el enlace a la cuenta `102xxxxxxx` de ContPAQi
 * (analytics.contpaqi_bank_movements), para conciliar el workbook/estado de cuenta contra
 * los LIBROS reales (verdad fiscal) en vez del proxy "Kepler 102" + matcher token-name.
 * Lo autopobla `FinanceBankService.linkContpaqi()` (match por familia de banco + account_label
 * contenido en el nombre de la cuenta ContPAQi). Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = async (c) => knex.schema.withSchema('finance').hasColumn('bank_accounts', c);
  if (!(await has('contpaqi_cuenta'))) {
    await knex.schema.withSchema('finance').alterTable('bank_accounts', (t) => {
      t.text('contpaqi_cuenta');          // '102xxxxxxx' de ContPAQi
      t.text('contpaqi_cuenta_nombre');   // 'SANTANDER 65503932169'
    });
  }
};

exports.down = async function (knex) {
  const has = async (c) => knex.schema.withSchema('finance').hasColumn('bank_accounts', c);
  if (await has('contpaqi_cuenta')) {
    await knex.schema.withSchema('finance').alterTable('bank_accounts', (t) => {
      t.dropColumn('contpaqi_cuenta');
      t.dropColumn('contpaqi_cuenta_nombre');
    });
  }
};
