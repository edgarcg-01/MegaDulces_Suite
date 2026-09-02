/**
 * LC.6.1 (Fase LC) — Distingue las dos corridas que puede tener un mes.
 *
 * `finance.purchase_book_runs` nació asumiendo una corrida por mes: la póliza completa del
 * libro de compras (folio 1, "REGISTRO DE COMPRAS DEL MES"). El sub-módulo "Movimientos no
 * asociados" necesita una segunda, distinta en propósito:
 *
 *   tipo = 'libro'        → el mes completo. Es lo que se arma cuando el mes no se ha subido.
 *   tipo = 'complemento'  → SOLO lo que quedó sin asociar. Es lo que se arma cuando la
 *                           póliza del mes ya existe pero se le quedaron facturas fuera.
 *
 * El UNIQUE `(tenant_id, anio_mes, folio_poliza)` ya permitía dos filas por mes; lo que
 * faltaba era poder decir cuál es cuál, porque `ensureRun` buscaba por mes a secas y con
 * dos corridas habría agarrado la que le tocara.
 *
 * El folio 2 es el default del complemento y no es arbitrario: en el Diario de ContPAQi el
 * folio 1 es siempre el registro de compras y **el 2 está libre en todos los meses
 * medidos** (jul-2026 salta de 1 a 3; ago-2026 arranca en 3). Sigue siendo editable: el
 * folio definitivo lo decide quien sube el archivo.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // Depende de 20260901220000 (la tabla). En orden normal ya existe; aplicada a mano sobre
  // una base atrasada, no: sin esta guarda el ALTER truena y deja la cola trabada.
  if (!(await knex.schema.withSchema('finance').hasTable('purchase_book_runs'))) return;

  if (!(await knex.schema.withSchema('finance').hasColumn('purchase_book_runs', 'tipo'))) {
    await knex.raw(`ALTER TABLE finance.purchase_book_runs ADD COLUMN tipo text NOT NULL DEFAULT 'libro'`);
    await knex.raw(`
      ALTER TABLE finance.purchase_book_runs
        ADD CONSTRAINT purchase_book_runs_tipo_valido CHECK (tipo IN ('libro','complemento'))`);
    await knex.raw(`
      COMMENT ON COLUMN finance.purchase_book_runs.tipo IS
        'libro = la póliza completa del mes (folio 1). complemento = solo los CFDIs que quedaron sin asociar.'`);
    // Las corridas que ya existen son del libro completo — es lo único que había.
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_pbr_mes_tipo ON finance.purchase_book_runs (tenant_id, anio_mes DESC, tipo)`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_pbr_mes_tipo`);
  if (await knex.schema.withSchema('finance').hasColumn('purchase_book_runs', 'tipo')) {
    await knex.raw(`ALTER TABLE finance.purchase_book_runs DROP CONSTRAINT IF EXISTS purchase_book_runs_tipo_valido`);
    await knex.schema.withSchema('finance').alterTable('purchase_book_runs', (t) => t.dropColumn('tipo'));
  }
};
