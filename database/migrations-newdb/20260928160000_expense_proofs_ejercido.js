/**
 * `[GX.39]` El sello de **ya le avisamos que se ejercio**.
 *
 * ## Lo que esta migracion NO hace, y es lo importante
 * **No copia una sola columna de Kepler.** La regla principal del proyecto es cero importers
 * y derivar, no materializar: el hecho «el gasto se ejercio» ya vive en la vista
 * `analytics.expense_requests.aplicada` (derive-no-copy sobre `kepler_ods.kdm1`), fresca sin
 * mantenimiento. Guardar aca una copia de `aplicada` seria una segunda materializacion de algo
 * que ya tiene fuente — justo lo que GOTCHAS §32 prohibe.
 *
 * Lo unico que se persiste es un hecho **nuestro**, que ninguna vista puede saber: **cuando le
 * avisamos a la persona**. Sin ese sello, cada pasada del detector volveria a avisar lo mismo.
 *
 * ## Por que no hay estado nuevo en `status`
 * El CHECK de `status` no se toca. El ejercicio es una dimension aparte (ver
 * `libs/contracts/src/finance/ejercicio.contract.ts`): `status` es nuestro tramite, y de el
 * cuelgan la bandeja de Aprobacion, los KPI, la reapertura y el candado de `dueno-del-vale`.
 * Un hecho de otro sistema no puede mover nuestra maquina de estados.
 *
 * Idempotente (`hasColumn` antes de `addColumn`), aditiva, sin reescribir ninguna fila.
 *
 * @param { import("knex").Knex } knex
 */
const TABLA = 'expense_proofs';

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable(TABLA))) {
    console.log('[expense_proofs_ejercido] up: la tabla no existe todavia, no-op');
    return;
  }

  if (!(await knex.schema.withSchema('finance').hasColumn(TABLA, 'ejercido_avisado_at'))) {
    await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN ejercido_avisado_at timestamptz`);
    console.log('[expense_proofs_ejercido] up: + ejercido_avisado_at');
  }

  /**
   * ⚠️ El detector busca lo contrario de lo comun: los ya cerrados **sin** avisar. Un indice
   * sobre toda la tabla seria casi todo filas que no le sirven; el parcial es el conjunto que
   * recorre. `status='validada'` es la unica puerta al ejercicio (ver el contrato).
   */
  const { rows } = await knex.raw(`SELECT to_regclass('finance.ix_fin_ep_por_avisar') t`);
  if (!rows[0].t) {
    await knex.raw(`
      CREATE INDEX ix_fin_ep_por_avisar ON finance.expense_proofs (tenant_id, folio_solicitud)
       WHERE status = 'validada' AND ejercido_avisado_at IS NULL`);
    console.log('[expense_proofs_ejercido] up: + ix_fin_ep_por_avisar (parcial)');
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_ep_por_avisar`);
  if (await knex.schema.withSchema('finance').hasColumn(TABLA, 'ejercido_avisado_at')) {
    await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN ejercido_avisado_at`);
  }
};
