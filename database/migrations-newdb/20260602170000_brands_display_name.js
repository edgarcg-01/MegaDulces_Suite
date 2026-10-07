/**
 * Capa 3 cleanup — agrega `display_name` a brands.
 *
 * Las 438 brands del tenant Mega Dulces tienen el nombre legal completo
 * ("DISTRIBUIDORA DE LA ROSA SA DE CV"). UX terrible en el panel de filtros
 * del portal. Este campo guarda una versión limpia ("DISTRIBUIDORA DE LA
 * ROSA") aplicando strip de sufijos legales mexicanos.
 *
 * Endpoints cliente-facing (catalog/products, catalog/facets) usan
 * COALESCE(display_name, nombre) para mostrar la versión limpia con fallback
 * al nombre legal si display_name es null.
 *
 * Notas técnicas:
 *   - Usamos char class `[.]` en lugar de `\.` porque Postgres POSIX regex
 *     interpreta los backslashes de forma diferente según el escaping de
 *     strings — `[.]` siempre es punto literal sin importar el escape.
 *   - Pasamos los patrones como bind parameters (?) para evitar problemas
 *     de escape al interpolar en SQL string.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE brands
      ADD COLUMN IF NOT EXISTS display_name VARCHAR(255) NULL
  `);

  // Pase 1: SAPI / SAB / SA / SAS DE CV (con/sin puntos)
  await knex.raw(
    `UPDATE brands
     SET display_name = regexp_replace(
       nombre,
       ?,
       '',
       'gi'
     )
     WHERE deleted_at IS NULL`,
    [
      '[,]?[[:space:]]+S[.]?A[.]?(P[.]?I[.]?|B[.]?|S[.]?)?[[:space:]]*(DE[[:space:]]+)?C[.]?V[.]?[.]?$',
    ],
  );

  // Pase 2: S DE R.L. DE C.V. variantes
  await knex.raw(
    `UPDATE brands
     SET display_name = regexp_replace(display_name, ?, '', 'gi')
     WHERE deleted_at IS NULL AND display_name IS NOT NULL`,
    [
      '[,]?[[:space:]]+S[.]?[[:space:]]*DE[[:space:]]+R[.]?[[:space:]]*L[.]?([[:space:]]*(DE[[:space:]]+)?C[.]?V[.]?[.]?)?$',
    ],
  );

  // Pase 3: SRL / S.R.L. / SC / S.C. solos al final
  await knex.raw(
    `UPDATE brands
     SET display_name = regexp_replace(display_name, ?, '', 'gi')
     WHERE deleted_at IS NULL AND display_name IS NOT NULL`,
    ['[,]?[[:space:]]+(S[.]?R[.]?L[.]?|S[.]?C[.]?|S[.]?A[.]?S[.]?|S[.]?A[.]?)[.]?$'],
  );

  // Pase 4: trailing puntuación + espacios sobrantes
  await knex.raw(
    `UPDATE brands
     SET display_name = regexp_replace(display_name, ?, '', 'g')
     WHERE deleted_at IS NULL AND display_name IS NOT NULL`,
    ['[,. [:space:]]+$'],
  );

  // Pase 5: si quedó vacío (edge case), restaurar al nombre original
  await knex.raw(`
    UPDATE brands
    SET display_name = nombre
    WHERE deleted_at IS NULL AND (display_name IS NULL OR display_name = '')
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_brands_tenant_display_name
      ON brands (tenant_id, display_name)
      WHERE deleted_at IS NULL
  `);

  await knex.raw(
    `COMMENT ON COLUMN brands.display_name IS 'Versión limpia del nombre para UI customer-facing (strip de SA DE CV y similares). Endpoints clientes usan COALESCE(display_name, nombre).'`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_brands_tenant_display_name`);
  await knex.raw(`ALTER TABLE brands DROP COLUMN IF EXISTS display_name`);
};
