/**
 * Horus 360 — K1: desglose por concepto + ubicación en el feature store.
 *
 * execution_360 += by_concept / by_location (JSONB, ventana 30d). Cada uno =
 * { [catalogId]: { label, n, level_avg, own_share_pct, photo_pct } } resolviendo el
 * nombre vía `catalogs` (value). Permite al motor diagnosticar QUÉ tipo de exhibidor
 * (concepto) y QUÉ posición ejecuta mal el sujeto vs su propio promedio → coaching
 * concreto ("flojeás la cabecera"). Audit 2026-06-18: conceptoId/ubicacionId 93%
 * poblados (5 conceptos / 6 ubicaciones) → señal defendible.
 *
 * Idempotente (hasColumn). Sin RLS extra (columnas en tabla ya hardened).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (c) => knex.schema.withSchema('commercial').hasColumn('execution_360', c);
  if (!(await has('by_concept'))) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.jsonb('by_concept'); // { conceptoId: { label, n, level_avg, own_share_pct, photo_pct } } (30d)
      t.jsonb('by_location'); // { ubicacionId: { label, n, level_avg } } (30d)
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.execution_360.by_concept IS 'Horus K1: ejecución desglosada por tipo de exhibidor (conceptoId→catalogs.value), ventana 30d. Base de weak_concept.'`,
    );
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('execution_360', 'by_concept')) {
    await knex.schema.withSchema('commercial').alterTable('execution_360', (t) => {
      t.dropColumn('by_concept');
      t.dropColumn('by_location');
    });
  }
};
