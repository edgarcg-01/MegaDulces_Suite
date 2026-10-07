/**
 * LT.7 — Operador del proveedor en el tracker. La API oficial de MagniTracking
 * (travels.php) amarra ruta ↔ operador ↔ IMEI de forma autoritativa; guardamos
 * el operador (chofer/vendedor) que el proveedor asigna a esa unidad.
 *
 * NOTA: restaurada tras un revert del working-tree (la fila ya existe en
 * knex_migrations local batch 228 → borrar el archivo dispara "directory
 * corrupt" de knex). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasId = await knex.schema.withSchema('logistics').hasColumn('trackers', 'operator_id');
  const hasName = await knex.schema.withSchema('logistics').hasColumn('trackers', 'operator_name');
  if (!hasId || !hasName) {
    await knex.schema.withSchema('logistics').alterTable('trackers', (t) => {
      if (!hasId) t.string('operator_id', 64);
      if (!hasName) t.string('operator_name', 160);
    });
  }
};

exports.down = async function (knex) {
  const hasId = await knex.schema.withSchema('logistics').hasColumn('trackers', 'operator_id');
  const hasName = await knex.schema.withSchema('logistics').hasColumn('trackers', 'operator_name');
  await knex.schema.withSchema('logistics').alterTable('trackers', (t) => {
    if (hasId) t.dropColumn('operator_id');
    if (hasName) t.dropColumn('operator_name');
  });
};
