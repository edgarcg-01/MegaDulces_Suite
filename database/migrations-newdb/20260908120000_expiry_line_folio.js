/**
 * Caducidades — **folio por hoja de producto** (expediente por sucursal, 2026-09-08).
 *
 * Cada producto que se da de alta genera SU hoja del expediente, y una hoja de
 * expediente sin folio no se puede citar: "la del martes de 8 Esquinas" no
 * identifica nada cuando ese día se levantaron nueve. El folio va en el
 * **renglón** y no en `expiry_reviews`, porque la hoja ES el producto — el
 * encabezado solo agrupa la jornada.
 *
 * Formato: `CAD-<sucursal>-<año>-<consecutivo 5>` → `CAD-03-2026-00001`.
 * Contador **por sucursal y año**, igual que los folios de pedido (`PD-YYYY-NNNNN`,
 * `commercial.order_sequences`): el mismo UPSERT atómico de Postgres, que resuelve
 * la carrera de dos capturas simultáneas sin lock explícito. Se numera por sucursal
 * y no global para que el folio diga de dónde salió la hoja y para que cada
 * sucursal lleve su propia serie continua en su expediente.
 *
 * **Backfill:** los renglones que ya existen reciben folio en orden de captura.
 * Un expediente que arranca con huecos ("¿y las de agosto?") vale menos que uno
 * completo, y el orden por `created_at` reproduce la secuencia real de trabajo.
 *
 * Aditiva e idempotente (guard `hasColumn` / `hasTable`). No borra ni reescribe
 * nada: solo agrega columna, tabla de secuencia y numera lo que estaba en null.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. Tabla de secuencia (tenant × sucursal × año) ──
  const hasSeq = await knex.schema.withSchema('commercial').hasTable('expiry_folio_sequences');
  if (!hasSeq) {
    await knex.schema.withSchema('commercial').createTable('expiry_folio_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      // Código de 2 dígitos de la sucursal ('00'..'06'), el mismo de
      // `identity.users.warehouse_code` y `commercial.warehouses.code`.
      t.string('warehouse_code', 10).notNullable();
      t.integer('year').notNullable();
      t.integer('current_value').notNullable().defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'warehouse_code', 'year']);
    });

    // RLS forzado como toda tabla nueva del schema (defense-in-depth, ADR-010).
    await knex.raw(`ALTER TABLE commercial.expiry_folio_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.expiry_folio_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.expiry_folio_sequences
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.expiry_folio_sequences TO app_runtime`);
    await knex.raw(
      `COMMENT ON TABLE commercial.expiry_folio_sequences IS 'Consecutivo de folio de hoja de caducidad por sucursal y año (CAD-<suc>-<año>-<NNNNN>). Mismo patrón que commercial.order_sequences: UPSERT atómico, sin lock explícito.'`,
    );
  }

  // ── 2. Columna folio en el renglón (= la hoja del expediente) ──
  const hasFolio = await knex.schema.withSchema('commercial').hasColumn('expiry_review_lines', 'folio');
  if (!hasFolio) {
    await knex.schema.withSchema('commercial').alterTable('expiry_review_lines', (t) => {
      t.string('folio', 30);
    });
    await knex.raw(
      `COMMENT ON COLUMN commercial.expiry_review_lines.folio IS 'Folio de la hoja del expediente: CAD-<sucursal>-<año>-<NNNNN>. Único por tenant. NULL solo durante el backfill.'`,
    );
  }

  // Único por tenant — el folio es la identidad citable de la hoja. Parcial
  // porque un renglón viejo puede quedar en NULL si el backfill no lo alcanza
  // (sucursal sin código de 2 dígitos: almacenes-ruta, pruebas).
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS expiry_review_lines_folio_uq
      ON commercial.expiry_review_lines (tenant_id, folio)
      WHERE folio IS NOT NULL
  `);

  // Búsqueda del expediente por folio (el encargado teclea el folio que trae en papel).
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS expiry_review_lines_folio_idx
      ON commercial.expiry_review_lines (folio)
      WHERE folio IS NOT NULL
  `);

  // ── 3. Backfill: numera lo ya capturado, en orden de captura ──
  //
  // Se hace en SQL puro y por tenant/sucursal/año a la vez: `row_number()` sobre
  // la partición da el consecutivo, y el `UPDATE ... FROM` lo escribe de una.
  // `USING (tenant_id, ...)` no hace falta porque esto corre como owner en la
  // migración (RLS no aplica al owner) y debe numerar TODOS los tenants.
  await knex.raw(`
    WITH numerado AS (
      SELECT
        l.id,
        l.tenant_id,
        w.code                                   AS suc,
        EXTRACT(YEAR FROM r.review_date)::int    AS anio,
        row_number() OVER (
          PARTITION BY l.tenant_id, w.code, EXTRACT(YEAR FROM r.review_date)
          ORDER BY l.created_at, l.id
        )                                        AS n
      FROM commercial.expiry_review_lines l
      JOIN commercial.expiry_reviews r ON r.id = l.review_id
      JOIN commercial.warehouses  w    ON w.id = r.warehouse_id
      WHERE l.folio IS NULL
        AND w.code ~ '^[0-9]{2}$'
    )
    UPDATE commercial.expiry_review_lines l
       SET folio = 'CAD-' || n.suc || '-' || n.anio || '-' || lpad(n.n::text, 5, '0')
      FROM numerado n
     WHERE l.id = n.id
  `);

  // El contador arranca donde terminó el backfill, o la próxima alta reusaría
  // folios ya entregados y el índice único la rechazaría.
  await knex.raw(`
    INSERT INTO commercial.expiry_folio_sequences (tenant_id, warehouse_code, year, current_value)
    SELECT
      l.tenant_id,
      split_part(l.folio, '-', 2)                        AS warehouse_code,
      split_part(l.folio, '-', 3)::int                   AS year,
      MAX(split_part(l.folio, '-', 4)::int)              AS current_value
    FROM commercial.expiry_review_lines l
    WHERE l.folio IS NOT NULL
    GROUP BY 1, 2, 3
    ON CONFLICT (tenant_id, warehouse_code, year)
      DO UPDATE SET current_value = GREATEST(
                      commercial.expiry_folio_sequences.current_value,
                      EXCLUDED.current_value),
                    updated_at = now()
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.expiry_review_lines_folio_idx`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.expiry_review_lines_folio_uq`);

  const hasFolio = await knex.schema.withSchema('commercial').hasColumn('expiry_review_lines', 'folio');
  if (hasFolio) {
    await knex.schema.withSchema('commercial').alterTable('expiry_review_lines', (t) => {
      t.dropColumn('folio');
    });
  }

  await knex.schema.withSchema('commercial').dropTableIfExists('expiry_folio_sequences');
};
