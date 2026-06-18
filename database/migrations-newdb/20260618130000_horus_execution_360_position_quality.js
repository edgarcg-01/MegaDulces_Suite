/**
 * Horus 360 — K3: calidad de posición (pesos oficiales del catálogo) en el feature store.
 *
 * execution_360 += position_quality (0-100): promedio de la `puntuacion` oficial de la
 * UBICACIÓN de cada exhibición (catalogs catalog_id='ubicaciones': Caja 100, Adyacente
 * 70, Vitrina 60, Exhibidor 50, Refrigerador 40, Anaquel 25, Detrás 10). Mide si el
 * sujeto exhibe en buenas posiciones (caja/adyacente) o malas (anaquel/detrás).
 *
 * Desbloquea la "position-quality" que el audit (H2.1) había diferido por
 * "scoring_pesos inaccesible" — los pesos viven en catalogs.puntuacion. Base del
 * finding `weak_position` (FindingsEngine). Determinista, rúbrica OFICIAL del negocio.
 *
 * Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('execution_360', 'position_quality'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.decimal('position_quality', 5, 2); // 0-100, promedio de catalogs.puntuacion de la ubicación
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.execution_360.position_quality IS 'Horus K3: calidad de posición (0-100), promedio de la puntuacion oficial (catalogs ubicaciones) de las exhibiciones. Base de weak_position.'`,
    );
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('execution_360', 'position_quality')) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.dropColumn('position_quality');
    });
  }
};
