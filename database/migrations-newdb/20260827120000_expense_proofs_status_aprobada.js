/**
 * GX.7 — Ciclo de vida en DOS momentos: separa la CAPTURA de la solicitud (firmada +
 * clasificación) de la SUBIDA de la evidencia, que ahora va DESPUÉS de aprobar.
 *
 *   recibida  → capturista subió la solicitud firmada + clasificó (esperando aprobación)
 *   aprobada  → el aprobador la aprobó; si es comprobable, falta que el capturista suba la evidencia
 *   validada  → evidencia subida y cuadra, o gasto no comprobable aprobado
 *   revision  → evidencia subida pero no cuadra (la valida un humano)
 *   rechazada → devuelta a corregir
 *
 * Esta migración sólo relaja el CHECK de `status` para admitir 'aprobada'. Idempotente.
 * No columnas nuevas, no permisos nuevos.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_status_check`);
  await knex.raw(`
    ALTER TABLE finance.expense_proofs
      ADD CONSTRAINT expense_proofs_status_check
      CHECK (status IN ('recibida','aprobada','validada','rechazada','revision'))`);
};

exports.down = async function (knex) {
  // No revertimos: dejar 'aprobada' en el dominio del CHECK es inocuo y evita romper filas
  // que ya estén en ese estado. (Mismo criterio que la migración de 'revision'.)
};
