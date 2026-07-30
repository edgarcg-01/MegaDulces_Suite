/**
 * SM.9 — Incidencia tipificada en el arqueo ciego.
 *
 * Cierra el lazo /tienda/arqueo → /almacen/cuadre: al capturar, la cajera puede
 * marcar el MOTIVO cualitativo del descuadre (faltante justificado, billete falso,
 * robo, error de cobro). Viaja al supervisor como evidencia del descuadre que el
 * autolineado genera. Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;
  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'incidencia_tipo'))) {
    await knex.raw(`
      ALTER TABLE reconciliation.blind_counts
        ADD COLUMN incidencia_tipo text
        CHECK (incidencia_tipo IN ('faltante_justificado','billete_falso','robo','error_cobro','otro'))
    `);
  }
};

exports.down = async function () { /* aditiva; no drop */ };
