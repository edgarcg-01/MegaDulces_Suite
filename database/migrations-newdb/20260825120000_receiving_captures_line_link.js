/**
 * Fase WMS-REC (Pieza 1+2 — captura de caducidad POR RENGLÓN del vale). Ver ADR-044.
 *
 * `commercial.receiving_lot_captures` ligaba al vale sólo por `source_ref` (string
 * libre con el folio) → la sesión sabía CUÁNTO llegó (`receiving_lines.received_qty`)
 * y el auditor sabía QUÉ LOTE era, pero nadie podía cruzarlos. Sin ese cruce no existe
 * la pregunta que da valor: "de las 100 pz recibidas, ¿cuántas tienen caducidad
 * declarada?" — es decir, cuánta mercancía entró SIN trazabilidad.
 *
 * Esta migración agrega la FK al renglón. Con ella, un SKU con 3 lotes = 3 capturas
 * del mismo renglón (la tabla ya era append-only: 1 fila = 1 lote), y el renglón puede
 * derivar `declared_qty = Σ capturas` sin columna nueva (se calcula, no se denormaliza).
 *
 * NULLABLE a propósito: las capturas sueltas (sin vale, desde /almacen/inventory/recepcion)
 * siguen siendo válidas — el cuadre por renglón sólo aplica a lo capturado dentro de un vale.
 *
 * Aditivo e idempotente (guard hasColumn). FK compuesta (tenant_id, receiving_line_id)
 * contra el unique `commercial_recv_lines_tenant_id_composite` → tenant-safe en WRITE
 * (una captura del tenant A no puede apuntar a un renglón del tenant B). MATCH SIMPLE:
 * no se enforcea cuando receiving_line_id es NULL, que es el caso de la captura suelta.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('receiving_lot_captures', 'receiving_line_id');
  if (has) return;

  await knex.schema.withSchema('commercial').alterTable('receiving_lot_captures', (t) => {
    t.uuid('receiving_line_id');
  });

  await knex.raw(`
    ALTER TABLE commercial.receiving_lot_captures
      ADD CONSTRAINT fk_recv_captures_tenant_line
      FOREIGN KEY (tenant_id, receiving_line_id)
      REFERENCES commercial.receiving_lines (tenant_id, id)
      ON DELETE SET NULL
  `);

  // Índice para el cuadre por renglón (Σ capturas por línea) y para el guard de cierre.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_recv_captures_line
      ON commercial.receiving_lot_captures (tenant_id, receiving_line_id)
      WHERE receiving_line_id IS NOT NULL
  `);

  await knex.raw(
    `COMMENT ON COLUMN commercial.receiving_lot_captures.receiving_line_id IS 'Renglón del vale al que pertenece esta captura de lote (ADR-044). NULL = captura suelta sin vale. N capturas por renglón = N lotes del mismo SKU.'`,
  );

  // La política de caducidad se resuelve por producto → department → proveedor.
  // `category` conserva el nombre (hay filas y UI que lo usan) pero su valor es el
  // department real de Kepler (kdie), NO category_id (que apunta a proveedores).
  await knex.raw(
    `COMMENT ON COLUMN commercial.expiry_receiving_policy.category IS 'Ámbito por taxonomía = valor de catalog.products.department (Kepler kdie: DULCES/BEBIDAS/BOTANAS). ADR-044. NO es catalog.products.category (columna que no existe) ni category_id (=proveedor).'`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const has = await knex.schema
    .withSchema('commercial')
    .hasColumn('receiving_lot_captures', 'receiving_line_id');
  if (!has) return;
  await knex.raw(
    `ALTER TABLE commercial.receiving_lot_captures DROP CONSTRAINT IF EXISTS fk_recv_captures_tenant_line`,
  );
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_recv_captures_line`);
  await knex.schema.withSchema('commercial').alterTable('receiving_lot_captures', (t) => {
    t.dropColumn('receiving_line_id');
  });
};
