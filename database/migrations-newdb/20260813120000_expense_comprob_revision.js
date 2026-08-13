/**
 * GX.8 (rediseño validación) — Comprobación de Gastos por VISION.
 *
 * Se elimina la lectura del PDF/documento Kepler en captura: los datos del gasto
 * vienen de Kepler por folio (analytics.expense_documents). La captura solo adjunta
 * la FOTO/EVIDENCIA del gasto → Claude Vision extrae el monto y se valida contra el
 * importe del gasto Kepler:
 *   - cuadra   → status 'validada'  (validada por Claude Vision)
 *   - no cuadra / ilegible / sin OCR → status 'revision' (la ve un humano)
 *
 * Esta migración:
 *   1) relaja el CHECK de status para incluir 'revision'.
 *   2) agrega monto_ocr (total leído de la foto), monto_match (cuadró vs importe),
 *      revision_nota (por qué quedó en revisión).
 * Idempotente. No permisos nuevos.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('finance').hasColumn('expense_comprobaciones', col);

  // 1) status 'revision' — reemplaza el CHECK inline (auto-nombrado *_status_check).
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP CONSTRAINT IF EXISTS expense_comprobaciones_status_check`);
  await knex.raw(`
    ALTER TABLE finance.expense_comprobaciones
      ADD CONSTRAINT expense_comprobaciones_status_check
      CHECK (status IN ('recibida','validada','rechazada','revision'))`);

  // 2) columnas de validación por vision.
  if (!(await has('monto_ocr'))) {
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones ADD COLUMN monto_ocr numeric`);
  }
  if (!(await has('monto_match'))) {
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones ADD COLUMN monto_match boolean`);
  }
  if (!(await has('revision_nota'))) {
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones ADD COLUMN revision_nota text`);
  }
};

exports.down = async function (knex) {
  // No revertimos el CHECK (dejar 'revision' es inocuo); solo quitamos columnas nuevas.
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP COLUMN IF EXISTS monto_ocr`);
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP COLUMN IF EXISTS monto_match`);
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP COLUMN IF EXISTS revision_nota`);
};
