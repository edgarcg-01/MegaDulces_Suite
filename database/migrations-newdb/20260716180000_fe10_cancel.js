/**
 * FE.10 — Cancelación completa de CFDI (motivo + sustitución + acuse + estatus).
 *
 * Agrega a `fiscal.cfdis` las columnas del ciclo de cancelación SAT:
 *   - cancel_motivo            clave 01–04 del motivo de cancelación
 *   - cancel_sustitucion_uuid  UUID del CFDI que sustituye (obligatorio si motivo 01)
 *   - cancel_reason            nota interna
 *   - cancel_requested_at      cuándo se pidió la cancelación
 *   - cancel_acuse             acuse de cancelación del SAT (XML/base64) que devuelve el PAC
 *
 * `estatus_sat` / `estatus_checked_at` ya existen (almacén CFDI). El estatus pasa a
 * reflejar la respuesta real: vigente | en_proceso_cancelacion | cancelado.
 *
 * Aditiva, idempotente (hasColumn), NO destructiva.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const add = async (col, builder) => {
    if (!(await knex.schema.withSchema('fiscal').hasColumn('cfdis', col))) {
      await knex.schema.withSchema('fiscal').alterTable('cfdis', builder);
    }
  };
  await add('cancel_motivo', (t) => t.string('cancel_motivo', 2));
  await add('cancel_sustitucion_uuid', (t) => t.string('cancel_sustitucion_uuid', 36));
  await add('cancel_reason', (t) => t.text('cancel_reason'));
  await add('cancel_requested_at', (t) => t.timestamp('cancel_requested_at', { useTz: true }));
  await add('cancel_acuse', (t) => t.text('cancel_acuse'));
};

/** @param { import("knex").Knex } knex — down conserva las columnas (no destructivo). */
exports.down = async function () {
  // Columnas cancel_* se conservan.
};
