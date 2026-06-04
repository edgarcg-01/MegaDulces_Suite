/**
 * Migración: commercial.promotions.banner_url
 *
 * Agrega una columna opcional para el arte de marketing de la promoción
 * (banner full-width hosteado en Cloudinary). NULL = sin banner (el portal
 * cae al hero "bento" generado). El admin pega la URL de Cloudinary en el
 * form de promociones; el portal la renderiza en home + /promotions.
 *
 * Idempotente: chequea hasColumn antes de agregar.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('commercial').hasColumn('promotions', 'banner_url');
  if (!has) {
    await knex.schema.withSchema('commercial').alterTable('promotions', (table) => {
      table.text('banner_url'); // null = sin banner
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.promotions.banner_url IS 'URL del banner de marketing (Cloudinary). NULL = portal usa hero generado.'`,
    );
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.withSchema('commercial').hasColumn('promotions', 'banner_url');
  if (has) {
    await knex.schema.withSchema('commercial').alterTable('promotions', (table) => {
      table.dropColumn('banner_url');
    });
  }
};
