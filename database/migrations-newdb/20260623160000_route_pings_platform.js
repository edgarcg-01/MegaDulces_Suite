/**
 * Diagnóstico de tracking: columna `platform` en los breadcrumbs GPS para
 * distinguir de raíz web (PWA, no rastrea con pantalla bloqueada) vs android
 * nativo (background-geolocation). Resuelve la ambigüedad recurrente al revisar
 * por qué un vendedor "no aparece" — `source` ya separa foreground/background,
 * `platform` separa el origen del dispositivo.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('public').hasColumn('route_location_pings', 'platform');
  if (!has) {
    await knex.schema.withSchema('public').alterTable('route_location_pings', (t) => {
      t.string('platform', 12); // 'web' | 'android' | 'ios'
    });
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const has = await knex.schema.withSchema('public').hasColumn('route_location_pings', 'platform');
  if (has) {
    await knex.schema.withSchema('public').alterTable('route_location_pings', (t) => {
      t.dropColumn('platform');
    });
  }
};
