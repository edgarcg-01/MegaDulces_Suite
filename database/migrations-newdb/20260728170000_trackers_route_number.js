/**
 * LTV.11 — "Unidad de ruta". Normaliza el número de ruta del tracker para poder
 * cruzar camión ↔ ruta ↔ vendedor ↔ clientes (el número aparece escrito de 3
 * formas: GPS "R-21", vendedor "RUTA 21", Kepler "R0021").
 *
 *   - route_number: entero canónico (21). Auto desde el nombre del GPS en el sync
 *     salvo que esté marcado manual.
 *   - route_manual: true = alguien lo asignó a mano (los ~37 camiones foráneos/
 *     motos/bodega cuyo nombre de GPS no trae ruta). El sync NO lo pisa.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasNum = await knex.schema.withSchema('logistics').hasColumn('trackers', 'route_number');
  const hasManual = await knex.schema.withSchema('logistics').hasColumn('trackers', 'route_manual');
  if (!hasNum || !hasManual) {
    await knex.schema.withSchema('logistics').alterTable('trackers', (t) => {
      if (!hasNum) t.integer('route_number');
      if (!hasManual) t.boolean('route_manual').notNullable().defaultTo(false);
    });
  }
  if (!hasNum) {
    await knex.schema.withSchema('logistics').alterTable('trackers', (t) => {
      t.index(['tenant_id', 'route_number'], 'idx_logistics_trackers_route_number');
    });
    // Backfill inicial desde route_code existente (R-21 → 21).
    await knex.raw(`
      UPDATE logistics.trackers
      SET route_number = NULLIF(regexp_replace(route_code, '\\D', '', 'g'), '')::int
      WHERE route_code IS NOT NULL AND route_number IS NULL
    `);
  }
};

exports.down = async function (knex) {
  const hasNum = await knex.schema.withSchema('logistics').hasColumn('trackers', 'route_number');
  const hasManual = await knex.schema.withSchema('logistics').hasColumn('trackers', 'route_manual');
  await knex.schema.withSchema('logistics').alterTable('trackers', (t) => {
    if (hasNum) t.dropColumn('route_number');
    if (hasManual) t.dropColumn('route_manual');
  });
};
