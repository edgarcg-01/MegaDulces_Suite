/**
 * Fase P2.6 (Control de Caducidades) — unidad de medida por renglón.
 *
 * La hoja mostraba TODO en "pz", pero al almacén no le llega todo en piezas:
 *   - caja   → lo más común cuando el código es numérico de anaquel (no de barras)
 *   - pieza  → piñatas y producto suelto
 *   - bulto  → las bolsas grandes
 *   - kg     → producto a granel (dulce por kilo)
 *
 * Sin esto, "3" era ambiguo: 3 cajas y 3 piezas se veían igual, y el conteo que
 * alimenta FEFO al enviar la hoja podía interpretarse mal.
 *
 * NULL = sin declarar (renglones viejos). El default de la UI es 'caja' cuando el
 * código capturado es numérico y 'pieza' cuando el producto vino del catálogo por
 * código de barras — pero la columna NO tiene default: se guarda lo que el
 * operador confirma, no lo que el sistema adivina.
 *
 * Aditiva e idempotente (guard hasColumn). No toca datos existentes.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('expiry_review_lines', 'unit');
  if (has) return;

  await knex.schema.withSchema('commercial').alterTable('expiry_review_lines', (t) => {
    t.string('unit', 10);
  });

  await knex.raw(`
    ALTER TABLE commercial.expiry_review_lines
      ADD CONSTRAINT commercial_expiry_review_lines_unit_chk
      CHECK (unit IS NULL OR unit IN ('caja', 'pieza', 'bulto', 'kg'))
  `);

  await knex.raw(
    `COMMENT ON COLUMN commercial.expiry_review_lines.unit IS 'Unidad de medida del renglón: caja | pieza | bulto | kg. NULL = renglón anterior a la columna. La UI sugiere caja para códigos numéricos de anaquel y pieza para producto escaneado, pero guarda lo que confirma el operador.'`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('expiry_review_lines', 'unit');
  if (!has) return;
  await knex.raw(
    `ALTER TABLE commercial.expiry_review_lines DROP CONSTRAINT IF EXISTS commercial_expiry_review_lines_unit_chk`,
  );
  await knex.schema.withSchema('commercial').alterTable('expiry_review_lines', (t) => {
    t.dropColumn('unit');
  });
};
