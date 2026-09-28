/**
 * `[GX.34]` — **Quien sube la evidencia se queda con el vale.**
 *
 * ## El pedido
 * *«el usuario que suba la evidencia de un vale lo hará como de su propiedad y es cuando
 * aparece en la sección de mis gastos»*.
 *
 * ## Por qué no alcanzaba con `created_by`
 * `created_by` dice **quién levantó el expediente**, y en el camino normal esa persona es la
 * misma que sube la foto — pero no siempre:
 *
 *  · **Evidencia posterior** (`addEvidence`): el gasto se aprueba sin comprobante y alguien
 *    lo sube después. Hoy ese vale sigue siendo del que lo levantó, y quien puso la cara
 *    subiendo la evidencia no lo ve en ningún lado.
 *  · **Captura por link**: `created_by` queda como `link:JUAN PEREZ`, que **no es un
 *    usuario**. Ese expediente no aparece en «Mis gastos» de nadie. Medido: 3 filas así en
 *    la base local; en prod todavía ninguna, pero el camino existe y está en uso.
 *
 * ## ⛔ Por qué NO se reescribe `created_by`
 * Sería más corto y destruiría el rastro: `created_by` es **quién levantó el gasto**, y eso
 * es lo que una auditoría busca cuando pregunta de dónde salió un expediente. Dos hechos
 * distintos, dos columnas.
 *
 * ## ⚠️ Lo que esta columna NO es
 * No es un permiso. Que un vale sea «tuyo» sólo decide **si lo ves en tu lista**; quién
 * puede aprobarlo, reabrirlo o cerrarlo lo siguen resolviendo los permisos y
 * `reapertura.ts`. Confundir las dos cosas convertiría subir una foto en una forma de ganar
 * derechos sobre el dinero de otro.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);

  if (!(await tiene('evidencia_por'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.text('evidencia_por');
      t.timestamp('evidencia_at', { useTz: true });
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN finance.expense_proofs.evidencia_por IS
      '[GX.34] Quien SUBIO la evidencia. Lo hace duenio del vale para «Mis gastos» — distinto de created_by, que es quien LEVANTO el expediente y no se reescribe (es el rastro de auditoria). NO es un permiso: no decide quien aprueba ni quien cierra.';
    COMMENT ON COLUMN finance.expense_proofs.evidencia_at IS
      '[GX.34] Cuando se subio esa evidencia. Sin la hora, «lo subio Fulano» no se puede ubicar en el tiempo frente al resto del expediente.';
  `);

  /**
   * «Mis gastos» consulta por `created_by = yo OR evidencia_por = yo`, así que el índice va
   * sobre la segunda mitad. Parcial: la enorme mayoría de las filas la tendrá en NULL
   * (quien levanta y quien sube son la misma persona), y un índice completo ocuparía lo que
   * ocupa la tabla para servir a una minoría.
   */
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_expense_proofs_evidencia_por
      ON finance.expense_proofs (tenant_id, evidencia_por)
      WHERE evidencia_por IS NOT NULL;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS finance.ix_expense_proofs_evidencia_por');
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);
  for (const col of ['evidencia_at', 'evidencia_por']) {
    if (await tiene(col)) {
      await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => { t.dropColumn(col); });
    }
  }
};
