/**
 * GX.7 (Vision) — Replica la validación por Claude Vision del flujo de comprobación de
 * gastos (GX.8) en las SOLICITUDES DE REEMBOLSO (finance.expense_proofs). Al adjuntar el
 * comprobante, Claude Vision lee el monto de la foto y se valida contra el importe de la
 * solicitud Kepler (XA1501):
 *   - cuadra                         → status 'validada' (por Claude Vision)
 *   - no cuadra / ilegible / sin OCR → status 'revision' (la ve un humano)
 *
 * Esta migración (idéntica a 20260813120000 pero sobre expense_proofs):
 *   1) relaja el CHECK de status para incluir 'revision'.
 *   2) agrega monto_ocr (total leído de la foto), monto_match (cuadró vs importe),
 *      revision_nota (por qué quedó en revisión).
 * Idempotente. No permisos nuevos.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);

  // 1) status 'revision' — reemplaza el CHECK inline (auto-nombrado *_status_check).
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_status_check`);
  await knex.raw(`
    ALTER TABLE finance.expense_proofs
      ADD CONSTRAINT expense_proofs_status_check
      CHECK (status IN ('recibida','validada','rechazada','revision'))`);

  // 2) columnas de validación por vision.
  if (!(await has('monto_ocr'))) {
    await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN monto_ocr numeric`);
  }
  if (!(await has('monto_match'))) {
    await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN monto_match boolean`);
  }
  if (!(await has('revision_nota'))) {
    await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN revision_nota text`);
  }
};

exports.down = async function (knex) {
  // No revertimos el CHECK (dejar 'revision' es inocuo); solo quitamos columnas nuevas.
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS monto_ocr`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS monto_match`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS revision_nota`);
};
