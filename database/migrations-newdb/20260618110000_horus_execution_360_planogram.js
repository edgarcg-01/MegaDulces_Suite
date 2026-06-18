/**
 * Horus 360 — K4: adherencia al planograma en el feature store.
 *
 * execution_360 += planogram_present / planogram_total (ventana 30d). present =
 * SKUs distintos del planograma (trade.planogram_skus) que el sujeto marcó en sus
 * capturas (productosMarcados ∩ planograma); total = tamaño del planograma activo.
 * Audit 2026-06-18: orden_exhibicion 100% poblado, productosMarcados↔product_id
 * mapean (304/631 marcados están en planograma). Conocimiento de "cuánto del
 * planograma exhibe cada sujeto".
 *
 * El finding `planogram_gap` (FindingsEngine) es PEER-RELATIVO entre tiendas (el
 * planograma es tenant-wide, sin target por tienda → un umbral absoluto no aplica).
 * Grano = tienda, capado a store_id ~33% (se loguea, no se oculta).
 *
 * Idempotente (hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (c) => knex.schema.withSchema('commercial').hasColumn('execution_360', c);
  if (!(await has('planogram_present'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.integer('planogram_present'); // SKUs distintos del planograma marcados (30d)
      t.integer('planogram_total'); // tamaño del planograma activo del tenant
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.execution_360.planogram_present IS 'Horus K4: # SKUs del planograma (trade.planogram_skus) que el sujeto exhibió (productosMarcados ∩ planograma), ventana 30d. Base de planogram_gap (peer-relativo entre tiendas).'`,
    );
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('execution_360', 'planogram_present')) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.dropColumn('planogram_present');
      t.dropColumn('planogram_total');
    });
  }
};
