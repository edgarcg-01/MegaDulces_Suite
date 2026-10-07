/**
 * `finance.expense_proofs` — la persona que autoriza declara si el gasto tiene comprobación.
 *
 * Hay solicitudes que legítimamente NO generan comprobación (XA1001), y hasta ahora eso no
 * se registraba en ningún lado: quien revisaba la evidencia validaba y el dato se perdía.
 * Después, mirando el tablero, no había forma de distinguir «todavía no llega la
 * comprobación» de «esta nunca va a tener», que son dos cosas muy distintas para quien
 * persigue el rezago.
 *
 * Se declara AL VALIDAR, que es el momento en que alguien tiene el expediente delante.
 * `NULL` = validaciones anteriores a este campo, o solicitudes sin validar todavía.
 *
 * Nombres en español a propósito: la tabla ya es toda española (`solicitante`,
 * `motivo_rechazo`, `revision_nota`) y «comprobación» es el término del dominio Kepler.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const t = 'expense_proofs';
  if (!(await knex.schema.withSchema('finance').hasTable(t))) return;

  if (!(await knex.schema.withSchema('finance').hasColumn(t, 'tiene_comprobacion'))) {
    await knex.raw(`ALTER TABLE finance.${t} ADD COLUMN tiene_comprobacion boolean`);
    await knex.raw(`COMMENT ON COLUMN finance.${t}.tiene_comprobacion IS
      'Lo declara quien valida: ¿este gasto genera comprobación (XA1001)? NULL = sin declarar (validaciones previas al campo).'`);
  }
  if (!(await knex.schema.withSchema('finance').hasColumn(t, 'comprobacion_nota'))) {
    await knex.raw(`ALTER TABLE finance.${t} ADD COLUMN comprobacion_nota text`);
    await knex.raw(`COMMENT ON COLUMN finance.${t}.comprobacion_nota IS
      'Por qué no lleva comprobación, o el folio de la que le corresponde. Lo escribe quien valida.'`);
  }

  // Para la pregunta que va a hacerse siempre: ¿qué validado quedó SIN comprobación?
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_ep_tiene_comp
    ON finance.${t} (tenant_id, tiene_comprobacion) WHERE status = 'validada'`);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS finance.ix_fin_ep_tiene_comp');
  // Las columnas NO se tiran: llevarían dato declarado por una persona.
};
