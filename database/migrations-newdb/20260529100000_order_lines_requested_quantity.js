/**
 * Separa "cantidad pedida por el cliente" (`requested_quantity`) de "cantidad
 * que el vendedor va a surtir" (`quantity`):
 *
 *   - `requested_quantity` se setea al crear/agregar la línea y NO se toca
 *     en pending_approval. Es la referencia de lo que pidió el cliente.
 *   - `quantity` es lo que se reserva, factura y consume. El vendedor puede
 *     bajarla durante el approval, pero NUNCA subirla por encima de
 *     `requested_quantity`.
 *
 * Backfill: para órdenes existentes copia `quantity → requested_quantity`
 * (asumimos que lo histórico era idéntico).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasCol = await knex.schema.hasColumn('commercial.order_lines', 'requested_quantity');
  if (!hasCol) {
    await knex.schema.withSchema('commercial').alterTable('order_lines', (t) => {
      t.decimal('requested_quantity', 14, 3);
    });

    // Backfill: para todas las líneas existentes la pedida == la actual.
    await knex.raw(`
      UPDATE commercial.order_lines
         SET requested_quantity = quantity
       WHERE requested_quantity IS NULL
    `);

    // Defensa: bloqueo a nivel DB para que approved <= requested.
    // No la hacemos NOT NULL para no romper escrituras legacy que ignoren el
    // campo — el service nuevo siempre lo setea.
    await knex.raw(`
      ALTER TABLE commercial.order_lines
        ADD CONSTRAINT commercial_order_lines_qty_le_requested
        CHECK (
          requested_quantity IS NULL
          OR quantity <= requested_quantity
        )
    `);

    await knex.raw(`
      COMMENT ON COLUMN commercial.order_lines.requested_quantity IS
        'Cantidad original que el cliente pidió al confirmar. quantity (actual) puede ser menor durante approval si el vendedor recorta, pero nunca mayor.'
    `);
  }
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.order_lines DROP CONSTRAINT IF EXISTS commercial_order_lines_qty_le_requested`);
  if (await knex.schema.hasColumn('commercial.order_lines', 'requested_quantity')) {
    await knex.schema.withSchema('commercial').alterTable('order_lines', (t) =>
      t.dropColumn('requested_quantity'),
    );
  }
};
