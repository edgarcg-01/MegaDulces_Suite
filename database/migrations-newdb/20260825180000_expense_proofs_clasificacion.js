/**
 * `finance.expense_proofs` — clasificación del gasto para hacer la EVIDENCIA condicional.
 *
 * El bug de origen: el archivo `comprobante_1` (la evidencia fotográfica: factura/ticket)
 * era obligatorio SIEMPRE. Pero no todos los gastos llevan evidencia:
 *   - `fiscal`                → tiene CFDI/factura → evidencia obligatoria.
 *   - `no_fiscal_comprobable` → hay ticket/recibo → evidencia obligatoria.
 *   - `no_comprobable`        → no hay con qué comprobarlo → SIN evidencia, con motivo.
 *
 * (La comprobación XA1001 vive SIEMPRE en Kepler y no es lo que se sube aquí; lo que varía
 * es la evidencia documental que adjuntamos. Ver `tiene_comprobacion`, que queda dormante:
 * era una pregunta sobre el XA1001, no sobre la evidencia.)
 *
 * Regla derivada: la evidencia es obligatoria salvo cuando `clasificacion='no_comprobable'`,
 * caso en que se exige el motivo (se reusa `comprobacion_nota` como "por qué no comprobable").
 *
 * `NULL` = expedientes previos a este campo (legacy) o sin clasificar todavía.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const t = 'expense_proofs';
  if (!(await knex.schema.withSchema('finance').hasTable(t))) return;

  if (!(await knex.schema.withSchema('finance').hasColumn(t, 'clasificacion'))) {
    await knex.raw(`ALTER TABLE finance.${t} ADD COLUMN clasificacion text
      CHECK (clasificacion IN ('fiscal','no_fiscal_comprobable','no_comprobable'))`);
    await knex.raw(`COMMENT ON COLUMN finance.${t}.clasificacion IS
      'Naturaleza del gasto para condicionar la evidencia: fiscal (factura) / no_fiscal_comprobable (ticket) / no_comprobable (sin evidencia, con motivo). NULL = legacy o sin clasificar.'`);
  }

  // El tablero pregunta seguido: ¿qué quedó sin clasificar, y qué no_comprobable falta revisar?
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_ep_clasificacion
    ON finance.${t} (tenant_id, clasificacion, status)`);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS finance.ix_fin_ep_clasificacion');
  // La columna NO se tira: llevaría clasificación declarada por una persona.
};
