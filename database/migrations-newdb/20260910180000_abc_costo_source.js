/**
 * KE.3b — LA CLASE ABC CARGA CON QUÉ COSTO SE CALCULÓ.
 *
 * `commercial.abc_classification.annual_value` es `NOT NULL`, y el cálculo hace
 * `COALESCE(costo, 0)`. O sea un SKU **sin costo** no se distingue de uno que vale cero: los dos
 * caen a clase **C**, y la clase fija el nivel de servicio de RA-PRO (A=0.98 / B=0.95 / C=0.90).
 * Un cero por ausencia baja el colchón de seguridad de un producto que quizá es A.
 *
 * No se puede volver la columna nullable sin tocar a quien la lee, así que se hace lo que manda
 * ADR-056: el número se queda, y **al lado viaja de dónde salió**. `costo_source` NULL sólo en las
 * filas viejas, hasta el próximo recálculo.
 *
 * Medido antes de escribir esto (prod, 2026-09-10): con `analytics.v_erp_unit_cost` el costo tiene
 * testigo del propio ERP en **25,324 de 25,573** filas con existencia (99.03%), y el catálogo se
 * salía ±50% del árbitro en **111 SKUs = $6,129,130 de capital mal clasificado**.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const ya = await knex.schema.withSchema('commercial').hasColumn('abc_classification', 'costo_source');
  if (!ya) {
    await knex.schema.withSchema('commercial').alterTable('abc_classification', (t) => {
      t.string('costo_source', 40).nullable();
    });
  }
  await knex.raw(`COMMENT ON COLUMN commercial.abc_classification.costo_source IS
    'KE.3b: de donde salio el costo con el que se calculo annual_value (analytics.v_erp_unit_cost.costo_source). NULL = fila anterior a KE.3, aun sin recalcular. sin_costo = la clase C puede ser por ausencia, no por bajo valor.'`);

  const c = (await knex.raw(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'abc_classification'
        AND column_name = 'costo_source'`)).rows[0].n;
  if (c !== 1) throw new Error('costo_source no quedó en commercial.abc_classification');
  console.log('  [abc] costo_source listo (NULL hasta el próximo recálculo)');
};

exports.down = async function down(knex) {
  const ya = await knex.schema.withSchema('commercial').hasColumn('abc_classification', 'costo_source');
  if (ya) {
    await knex.schema.withSchema('commercial').alterTable('abc_classification', (t) => {
      t.dropColumn('costo_source');
    });
  }
};
