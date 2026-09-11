/**
 * KE.4c — el motivo de la clase también viaja en la FOTO, no sólo en la vista.
 *
 * `analytics.v_abc_class` ya distingue las tres maneras de terminar en C (KE.4b). Pero los
 * consumidores de la **tabla** `commercial.abc_classification` no la ven, y uno de ellos decide
 * operación real: la **cadencia del conteo cíclico** (A=30 d · B=90 d · C=365 d).
 *
 * Medido en prod: **12,690 filas salen `sin_demanda`** — las 10,073 del CEDIS `00` (que no vende:
 * distribuye por traspaso) más las 2,617 de la sucursal `07`, recién cableada. Sin el motivo,
 * esas C se leen como "bajo valor" y mandan a contar una vez al año el almacén con más capital
 * de la red.
 *
 * Aditiva y nullable: las filas anteriores quedan en NULL hasta el próximo recálculo.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const ya = await knex.schema.withSchema('commercial').hasColumn('abc_classification', 'clase_motivo');
  if (!ya) {
    await knex.schema.withSchema('commercial').alterTable('abc_classification', (t) => {
      t.string('clase_motivo', 20).nullable();
    });
  }
  await knex.raw(`COMMENT ON COLUMN commercial.abc_classification.clase_motivo IS
    'KE.4c: por que la fila cayo en su clase. pareto = legitima (mueve poco valor contra sus pares). sin_demanda = el ALMACEN no registra venta (el CEDIS distribuye por traspaso; una sucursal recien cableada todavia no acumula ventana). sin_costo = hay demanda pero ningun ERP ni el catalogo dan costo. NULL = fila anterior a KE.4c. Una C sin motivo no se puede usar para fijar cadencia de conteo.'`);

  const c = (await knex.raw(
    `SELECT count(*)::int n FROM information_schema.columns
      WHERE table_schema = 'commercial' AND table_name = 'abc_classification'
        AND column_name = 'clase_motivo'`)).rows[0].n;
  if (c !== 1) throw new Error('clase_motivo no quedó en commercial.abc_classification');
  console.log('  [abc] clase_motivo listo (NULL hasta el próximo recálculo)');
};

exports.down = async function down(knex) {
  const ya = await knex.schema.withSchema('commercial').hasColumn('abc_classification', 'clase_motivo');
  if (ya) {
    await knex.schema.withSchema('commercial').alterTable('abc_classification', (t) => {
      t.dropColumn('clase_motivo');
    });
  }
};
