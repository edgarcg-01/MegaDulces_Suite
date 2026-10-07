/**
 * HV.1 (Fase HV, recortada a nivel marca tras el gate HV.0) — la visión LEE los
 * productos del exhibidor. Aditivo sobre commercial.capture_vision (no tabla nueva:
 * el gate HV.0 descartó el matching duro SKU, así que guardamos el TEXTO CRUDO de
 * lo visto —valioso para el mapa comercial— sin join a catálogo todavía).
 *
 * - products_seen  : jsonb, array de {brand_text, product_text, size_text,
 *                    facings_bucket, legibility} tal como los LEE la visión (ciego).
 * - seen_brand_count / seen_product_count: derivados para reglas rápidas
 *   (over_declaration) sin desarmar el jsonb en cada query.
 *
 * Idempotente (hasColumn). Sin FK. RLS ya vigente en la tabla.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('commercial').hasColumn('capture_vision', col);
  if (!(await has('products_seen'))) {
    await knex.schema.withSchema('commercial').alterTable('capture_vision', (t) => {
      t.jsonb('products_seen').notNullable().defaultTo('[]');
    });
  }
  if (!(await has('seen_product_count'))) {
    await knex.schema.withSchema('commercial').alterTable('capture_vision', (t) => {
      t.integer('seen_product_count').notNullable().defaultTo(0);
    });
  }
  if (!(await has('seen_brand_count'))) {
    await knex.schema.withSchema('commercial').alterTable('capture_vision', (t) => {
      t.integer('seen_brand_count').notNullable().defaultTo(0);
    });
  }
  await knex.raw(
    `COMMENT ON COLUMN commercial.capture_vision.products_seen IS 'HV.1 texto crudo de productos leidos por la vision (ciego, sin match a catalogo). Gate HV.0: SKU-match diferido.'`,
  );
};

exports.down = async function (knex) {
  const has = (col) => knex.schema.withSchema('commercial').hasColumn('capture_vision', col);
  for (const col of ['products_seen', 'seen_product_count', 'seen_brand_count']) {
    if (await has(col)) {
      await knex.schema.withSchema('commercial').alterTable('capture_vision', (t) => t.dropColumn(col));
    }
  }
};
