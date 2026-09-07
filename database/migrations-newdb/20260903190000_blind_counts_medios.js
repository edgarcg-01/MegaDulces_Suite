/**
 * SM.24 — El arqueo deja de ser solo del efectivo.
 *
 * El corte de Kepler tiene **seis renglones**, no uno: `c15..c20` (esperado),
 * `c25..c30` (contado) y `c35..c40` (diferencia). La identidad
 * `esperado − contado = diferencia` se cumple en **976/976 cortes**, así que el
 * ERP arquea los seis. Nosotros contábamos uno.
 *
 * Medido sobre 60 días: efectivo $26.19M · tarjeta $1.75M · transferencia $1.52M.
 * Más los retiros, que son otro $18k por corte en promedio. Todo eso pasaba por la
 * caja sin que nadie lo verificara contra nada.
 *
 * `medios` guarda lo que la cajera DECLARA de cada concepto — el voucher de la
 * terminal, el fajo de cheques, los vales. Se compara contra Kepler solo donde
 * hay columna verificada:
 *
 *   tarjeta       → c16 / c26   ✅ verificado
 *   transferencia → c17 / c27   ✅ verificado
 *   retiros       → c48         ✅ verificado
 *   creditos      → c19 o c20   ⚠️ sin confirmar cuál — se guarda, no se compara
 *   cheques       → c19 o c20   ⚠️ ídem
 *
 * Los dos últimos se guardan igual: tener el dato declarado hoy es lo que permite
 * confirmar el mapeo mañana comparando contra la columna. Inventar la equivalencia
 * ahora sería peor — un cuadre mal atado acusa a alguien de una diferencia falsa,
 * que es exactamente el bug que acabamos de corregir en SM.23.
 *
 * JSONB y no columnas: los conceptos cambian por sucursal y por año, y cada uno
 * nuevo sería otra migración sobre una tabla que ya está en producción.
 *
 * Aditiva e idempotente.
 */

exports.up = async function up(knex) {
  const existe = await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'medios');
  if (!existe) {
    await knex.schema.withSchema('reconciliation').alterTable('blind_counts', (t) => {
      t.jsonb('medios').nullable();
    });
  }
  await knex.raw(`
    COMMENT ON COLUMN reconciliation.blind_counts.medios IS
      'Lo declarado por medio de pago no-efectivo: {tarjeta, transferencia, retiros, creditos, cheques}. El efectivo va en denominations (pieza por pieza). tarjeta/transferencia/retiros se cuadran contra c16/c17/c48; creditos y cheques se guardan sin comparar hasta confirmar su columna en Kepler.'`);
};

exports.down = async function down(knex) {
  // No se tira la columna si ya hay algo declarado: son montos de dinero contados
  // por una persona, no metadatos regenerables.
  const { rows } = await knex.raw(
    `SELECT count(*)::int n FROM reconciliation.blind_counts WHERE medios IS NOT NULL`);
  if (rows[0].n > 0) {
    throw new Error(`No se puede revertir: hay ${rows[0].n} arqueos con medios declarados. Exportarlos antes de tirar la columna.`);
  }
  const existe = await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'medios');
  if (existe) {
    await knex.schema.withSchema('reconciliation').alterTable('blind_counts', (t) => t.dropColumn('medios'));
  }
};
