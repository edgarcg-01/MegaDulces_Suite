/**
 * Normaliza nombres de brands y products.
 *
 * Reglas aplicadas (en este orden, por tabla):
 *   R1 — trim + colapsar espacios multiples internos a uno solo.
 *   R2 — apostrofes/agudos/backticks raros (' ` ´ ' ') -> apostrofe recto (').
 *   R3 — quitar residuos al final (espacios y guiones sobrantes).
 *   R4a — UPPER + strip de acentos en vocales (a/e/i/o/u/u). Manteniendo
 *         enie (n) porque en espanol es una letra propia, no acento.
 *
 * NO reversible: el casing y los caracteres originales no se recuperan.
 * Para revertir hay que restaurar desde el dump previo.
 *
 * Pre-check: verifica que la normalizacion no genere colisiones contra el
 * UNIQUE de brands.nombre antes de empezar a tocar nada.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // SQL que produce el "nombre normalizado" a partir del nombre actual.
  // Mismo bloque exacto que despues usaremos en cada UPDATE.
  const normalizedExpr = `
    TRANSLATE(
      UPPER(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            TRIM(
              REGEXP_REPLACE(nombre, '[‘’´\`]', '''', 'g')
            ),
            '\\s+', ' ', 'g'
          ),
          '[\\s\\-]+$', '', 'g'
        )
      ),
      'ÁÉÍÓÚÜáéíóúü',
      'AEIOUUAEIOUU'
    )
  `;

  // 0. Pre-check: detectar si la normalizacion de brands generaria duplicados
  //    contra el UNIQUE(brands.nombre). Si los hay, abortamos antes de tocar
  //    nada.
  const collisions = await knex.raw(`
    SELECT ${normalizedExpr} AS norm, count(*) AS n, array_agg(nombre) AS variantes
    FROM brands
    GROUP BY norm
    HAVING count(*) > 1
  `);
  if (collisions.rows.length > 0) {
    throw new Error(
      'normalize_product_names: la normalizacion generaria duplicados en brands.nombre. Revisar manualmente:\n' +
        JSON.stringify(collisions.rows, null, 2),
    );
  }

  // Aplicamos las 4 reglas en un solo UPDATE por tabla (todo el SQL
  // anidado las cubre). Solo tocamos filas donde el nombre cambia
  // realmente — evitamos bumping updated_at sin razon.

  for (const table of ['brands', 'products']) {
    const result = await knex.raw(`
      UPDATE ${table}
      SET nombre = ${normalizedExpr},
          updated_at = NOW()
      WHERE nombre IS NOT NULL
        AND nombre <> ${normalizedExpr}
    `);

    console.log(
      `[normalize_product_names] ${table}: ${result.rowCount} filas actualizadas`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  // Migracion lossy: el casing y caracteres originales no se reconstruyen.
  // Para revertir hay que restaurar desde dump previo a esta migracion.
  throw new Error(
    'normalize_product_names: migracion no reversible. Restaurar desde backup previo si es necesario.',
  );
};
