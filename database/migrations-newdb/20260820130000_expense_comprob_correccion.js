/**
 * GX.8 (Fase 2) — estado `correccion`: el autorizador puede DEVOLVER una comprobación
 * al capturista para que la re-suba (con un motivo), en vez de solo rechazarla en firme.
 * El capturista la ve en "Mis capturas" como "Corrección solicitada" + el motivo, y
 * vuelve a capturar el mismo folio (nueva comprobación que supersede a la anterior).
 *
 * Solo relaja el CHECK de status para incluir 'correccion'. Idempotente. Sin columnas
 * ni permisos nuevos (reusa motivo_rechazo para el texto de la corrección solicitada).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP CONSTRAINT IF EXISTS expense_comprobaciones_status_check`);
  await knex.raw(`
    ALTER TABLE finance.expense_comprobaciones
      ADD CONSTRAINT expense_comprobaciones_status_check
      CHECK (status IN ('recibida','validada','rechazada','revision','correccion'))`);
};

exports.down = async function (knex) {
  // Volver 'correccion' → 'rechazada' antes de re-apretar el CHECK (no deja filas huérfanas).
  await knex.raw(`UPDATE finance.expense_comprobaciones SET status='rechazada' WHERE status='correccion'`);
  await knex.raw(`ALTER TABLE finance.expense_comprobaciones DROP CONSTRAINT IF EXISTS expense_comprobaciones_status_check`);
  await knex.raw(`
    ALTER TABLE finance.expense_comprobaciones
      ADD CONSTRAINT expense_comprobaciones_status_check
      CHECK (status IN ('recibida','validada','rechazada','revision'))`);
};
