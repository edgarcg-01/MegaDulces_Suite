'use strict';
/**
 * `[PGP.122]` S.17 (DS31) — **La información de pago de la solicitud: a dónde se paga y a quién se manda el
 * comprobante.** Francisco, 2026-11-16: «al final la forma de pago, el plazo y, en caso, un (+) Agregar información de
 * pago para agregar la cuenta y el correo a enviar». Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_SOLICITUD_DE_GASTO.md` §15.
 *
 * Tres columnas en el vale (`finance.expense_proofs`, ADR-056: la solicitud ES el vale, no se inventa otra tabla), las
 * tres opcionales:
 *  · `payee_account` — CLABE (18, con su dígito de control revisado por el contrato), tarjeta o número de cuenta: SÓLO
 *    dígitos, de 10 a 19 (`cuentaDePago`). El CHECK repite la forma: lo que llega por otro camino tampoco entra mal.
 *  · `payee_bank` — el banco, como lo escribió la persona (≤ 40). No se deduce de la CLABE: no hay catálogo de bancos.
 *  · `payee_email` — el correo al que se manda el comprobante del pago (≤ 120, una sola dirección).
 *
 * El plazo (DS30) NO pide columna: es la fecha de pago, que ya viaja en `needed_by` → `kdm1.c18`.
 *
 * ── Lo medido antes (prod, sólo lectura, system_identifier 7688376744939610156, 2026-11-16) ──
 *  · La CLABE de los acreedores de gasto no está en ningún catálogo: `kdxd` no tiene una columna con 18 dígitos y
 *    `commercial.supplier_payment_accounts` tiene 0 filas. El correo, Kepler lo tiene en 16 de 342 (`kdxd.c11`).
 *  · El 9.3 % de las X-A-15 de 90 días se paga por transferencia (361, de 75 acreedores).
 *  · `finance.expense_proofs` no tiene ninguna columna `payee_*`.
 *
 * Columnas nulas sin DEFAULT: `ADD COLUMN` es sólo metadatos (PG ≥ 11) y ningún camino de inserción cambia (regla 14:
 * no hay NOT NULL). Los CHECK validan las filas que ya existen, todas con las columnas en NULL.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pgp122_s17_informacion_de_pago]';
const CHECKS = [
  ['expense_proofs_payee_account_ck', `payee_account IS NULL OR payee_account ~ '^[0-9]{10,19}$'`],
  ['expense_proofs_payee_bank_ck', `payee_bank IS NULL OR char_length(payee_bank) BETWEEN 1 AND 40`],
  ['expense_proofs_payee_email_ck', `payee_email IS NULL OR (char_length(payee_email) <= 120 AND payee_email ~ '^[^[:space:]@,;]+@[^[:space:]@,;]+[.][^[:space:]@,;.]{2,}$')`],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const col of ['payee_account', 'payee_bank', 'payee_email']) {
    if (!(await knex.schema.withSchema('finance').hasColumn('expense_proofs', col))) {
      await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => t.text(col));
      console.log(`${TAG} + finance.expense_proofs.${col}`);
    }
  }
  for (const [nombre, regla] of CHECKS) {
    const hay = (await knex.raw(`SELECT 1 FROM pg_constraint WHERE conrelid = 'finance.expense_proofs'::regclass AND conname = ?`, [nombre])).rows.length;
    if (!hay) {
      await knex.raw(`ALTER TABLE finance.expense_proofs ADD CONSTRAINT ${nombre} CHECK (${regla})`);
      console.log(`${TAG} + ${nombre}`);
    }
  }
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.payee_account IS '[PGP.122] S.17: CLABE, tarjeta o cuenta a donde se paga, sólo dígitos (opcional)'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.payee_bank IS '[PGP.122] S.17: el banco, como lo escribió quien pidió (opcional)'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.payee_email IS '[PGP.122] S.17: a dónde se manda el comprobante del pago (opcional)'`);
};

/**
 * Quita los CHECK y DEJA las columnas: lo capturado en ellas es lo que la persona escribió (la cuenta del proveedor) y
 * un `down` no lo tira (mismo criterio que G.6 y S.13). Re-aplicar el `up` las encuentra y vuelve a poner los CHECK.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [nombre] of CHECKS) await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS ${nombre}`);
  console.log(`${TAG} down: sin los CHECK; las columnas payee_* se conservan con lo capturado`);
};
