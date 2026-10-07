/**
 * `[GX.29]` — **El vale que se aprobó con prefactura, y la reapertura autorizada.**
 *
 * ## Por qué
 * Hay gastos que se levantan con **prefactura o cotización**: documentos PREVIOS, no el
 * comprobante. El vale se aprueba con eso —el dinero sale— y el comprobante definitivo
 * llega después. Eso no es una excepción: es el curso normal de ese tipo de gasto, y hasta
 * hoy el sistema no tenía forma de decirlo. Un vale así quedaba `validada`, indistinguible
 * de uno cerrado con su factura, y **nadie podía contestar cuánto dinero está aprobado sin
 * comprobante definitivo** — que es justo lo que pregunta una auditoría.
 *
 * ## Dos mecanismos, a propósito
 * · **Agregar no pide permiso.** Un vale aprobado como `provisional` admite evidencia nueva
 *   sin trámite: era lo esperado desde que se aprobó.
 * · **Cambiar lo ya decidido, sí.** Reabrir un vale cerrado pasa por el aprobador — y por
 *   **el mismo** que lo aprobó (decisión del usuario, 2026-09-26).
 *
 * ## ⛔ Lo que NO se agrega, y por qué
 * **Ningún estado nuevo.** El `CHECK` de `status` sigue con sus cinco valores. Un vale
 * reabierto vuelve a `recibida`, que es exactamente lo que la bandeja del día ya lista: se
 * ve como algo nuevo que atender sin inventar un sexto estado que todas las consultas del
 * módulo tendrían que aprender.
 *
 * **Ningún registro nuevo.** La 2ª vuelta es el MISMO expediente con `vuelta = 2`. Crear
 * una fila nueva contaría ese vale dos veces en el total del día, en el historial y en lo
 * que se le reporta a Dirección, y duplicaría el folio de Kepler de este lado.
 *
 * **Ninguna columna para «oculto».** Un rechazado deja de verse a las 24 h de su rechazo, y
 * eso se DERIVA de `validated_at` en las consultas. Guardar un flag exigiría un cron que lo
 * prenda, y un cron que falla en silencio deja vales visibles creyendo que se ocultaron.
 * ⚠️ Ocultar NO es borrar: la fila queda. Un vale rechazado es la evidencia de que alguien
 * intentó cobrar algo que no correspondía, y es de lo primero que busca una auditoría.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);

  await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => { void t; });

  if (!(await tiene('provisional'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.boolean('provisional').notNullable().defaultTo(false);
    });
  }
  if (!(await tiene('comprobante_esperado_at'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.date('comprobante_esperado_at');
    });
  }
  if (!(await tiene('vuelta'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.integer('vuelta').notNullable().defaultTo(1);
    });
  }
  if (!(await tiene('reabierto_por'))) {
    await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => {
      t.text('reabierto_por');
      t.timestamp('reabierto_at', { useTz: true });
      t.text('reapertura_motivo');
    });
  }

  await knex.raw(`
    COMMENT ON COLUMN finance.expense_proofs.provisional IS
      '[GX.29] Aprobado con evidencia PROVISIONAL (prefactura o cotizacion): el dinero sale pero falta el comprobante definitivo. No es un error, es el curso normal de ese gasto — y es lo que hace medible cuanto dinero esta aprobado sin comprobar.';
    COMMENT ON COLUMN finance.expense_proofs.comprobante_esperado_at IS
      '[GX.29] Para cuando se espera el comprobante definitivo. Sin fecha, la deuda documental no envejece y nadie la reclama nunca.';
    COMMENT ON COLUMN finance.expense_proofs.vuelta IS
      '[GX.29] Cuantas veces volvio a la bandeja. 1 = la original. Se incrementa al reabrir. NO se crea un expediente nuevo: eso contaria el dinero dos veces.';
    COMMENT ON COLUMN finance.expense_proofs.reabierto_por IS
      '[GX.29] Quien autorizo la reapertura. Solo puede ser quien aprobo el vale (validated_by), decision del usuario 2026-09-26.';
  `);

  /**
   * La deuda documental se consulta seguido (es el tablero de «que falta comprobar»), y
   * son pocas filas sobre muchas: indice PARCIAL, que ocupa lo que ocupa el subconjunto.
   */
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_expense_proofs_provisional
      ON finance.expense_proofs (tenant_id, comprobante_esperado_at)
      WHERE provisional = true;
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS finance.ix_expense_proofs_provisional');
  const tiene = async (col) => knex.schema.withSchema('finance').hasColumn('expense_proofs', col);
  for (const col of ['reapertura_motivo', 'reabierto_at', 'reabierto_por', 'vuelta', 'comprobante_esperado_at', 'provisional']) {
    if (await tiene(col)) {
      await knex.schema.withSchema('finance').alterTable('expense_proofs', (t) => { t.dropColumn(col); });
    }
  }
};
