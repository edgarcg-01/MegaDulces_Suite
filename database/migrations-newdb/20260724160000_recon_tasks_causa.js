/**
 * MA.11 — `finance.recon_tasks.causa` / `.causa_label`.
 *
 * Guarda el diagnóstico dominante de la tarea (calculado en buildTasks vía
 * movementFlow) para que la LISTA muestre de un vistazo dónde está el error
 * (o si no es error de Kepler): pago_en_102 | factura_sin_pago | revisar_cadena |
 * capturar_desde_cero. Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('recon_tasks'))) return;
  if (!(await knex.schema.withSchema('finance').hasColumn('recon_tasks', 'causa'))) {
    await knex.schema.withSchema('finance').alterTable('recon_tasks', (t) => { t.text('causa'); });
  }
  if (!(await knex.schema.withSchema('finance').hasColumn('recon_tasks', 'causa_label'))) {
    await knex.schema.withSchema('finance').alterTable('recon_tasks', (t) => { t.text('causa_label'); });
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('recon_tasks'))) return;
  await knex.schema.withSchema('finance').alterTable('recon_tasks', (t) => { t.dropColumn('causa'); t.dropColumn('causa_label'); });
};
