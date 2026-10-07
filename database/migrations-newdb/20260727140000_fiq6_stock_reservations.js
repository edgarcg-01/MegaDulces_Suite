/**
 * FIQ.6 (ADR-038) — Apartado de pedidos con TTL para el bot de WhatsApp.
 *
 * El cliente pide "apártame esto"; el motor RESERVA el stock (incrementa
 * commercial.stock.reserved_quantity via OrderStockService.reserve, con
 * reference_type='reservation') por un TTL. Un cron @5min libera los vencidos
 * y devuelve el reserved_quantity (defense-in-depth + auditoría).
 *
 * 3 tablas en commercial.*:
 *   1. reservation_sequences — folio atómico AP-YYYY-NNNNN por (tenant, year).
 *      Clon exacto de order_sequences (UPSERT ON CONFLICT).
 *   2. stock_reservations — header: contacto por teléfono E.164 canónico (ancla
 *      aun sin customer_id), customer opcional, warehouse de surtido, TTL
 *      (expires_at), released_at/reason. UNIQUE (tenant_id, id) para la FK de
 *      líneas + UNIQUE (tenant_id, folio). idx expires_at WHERE released_at IS
 *      NULL para el cron.
 *   3. stock_reservation_lines — qty (piezas) + snapshot de precio por línea.
 *
 * Todas con tenant_id + RLS FORZADO + grants app_runtime (regla dura del proyecto).
 * Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. commercial.reservation_sequences (folio AP-YYYY-NNNNN) ──────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('reservation_sequences'))) {
    await knex.schema.withSchema('commercial').createTable('reservation_sequences', (table) => {
      table.uuid('tenant_id').notNullable();
      table.integer('year').notNullable();
      table.integer('current_value').notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      table.primary(['tenant_id', 'year']);
      table.check('?? > 0', ['year'], 'commercial_reservation_sequences_year_positive');
      table.check('?? >= 0', ['current_value'], 'commercial_reservation_sequences_current_nonneg');
    });
    // Sin FK a public.tenants: en la DB actual es una VISTA (field_ops passthrough),
    // no una tabla. La integridad de tenant la garantiza tenant_id NOT NULL + RLS.
    await knex.raw(`ALTER TABLE commercial.reservation_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.reservation_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.reservation_sequences
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.reservation_sequences TO app_runtime');
    await knex.raw(`COMMENT ON TABLE commercial.reservation_sequences IS 'FIQ.6: counter atómico por (tenant, year) para folio de apartado AP-YYYY-NNNNN. UPSERT ON CONFLICT.'`);
  }

  // ── 2. commercial.stock_reservations (header del apartado) ─────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('stock_reservations'))) {
    await knex.schema.withSchema('commercial').createTable('stock_reservations', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.text('folio').notNullable();
      // Teléfono E.164 canónico (dígitos, sin +): ancla del apartado aun sin customer.
      table.text('phone').notNullable();
      table.uuid('customer_id'); // NULL = casual todavía sin alta
      table.uuid('warehouse_id').notNullable();
      table.timestamp('reserved_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('expires_at').notNullable();
      table.timestamp('released_at'); // NULL = activa
      table.text('released_reason'); // 'converted' | 'released_manual' | 'expired'
      table.decimal('total', 14, 2).notNullable().defaultTo(0);
      table.text('notes');
      table.uuid('created_by');
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      table.primary('id');
      table.unique(['tenant_id', 'id'], { indexName: 'commercial_stock_reservations_tenant_id_composite' });
      table.unique(['tenant_id', 'folio'], { indexName: 'commercial_stock_reservations_folio_unique' });
    });

    // Sin FK a public.tenants (VISTA en esta DB). tenant_id NOT NULL + RLS bastan.
    // customer_id nullable → MATCH SIMPLE: si es NULL no se valida la FK (casual).
    await knex.raw(`
      ALTER TABLE commercial.stock_reservations
        ADD CONSTRAINT fk_stock_reservations_customer
        FOREIGN KEY (tenant_id, customer_id)
        REFERENCES commercial.customers(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE commercial.stock_reservations
        ADD CONSTRAINT fk_stock_reservations_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.stock_reservations
        ADD CONSTRAINT chk_stock_reservations_released_reason
        CHECK (released_reason IS NULL OR released_reason IN ('converted', 'released_manual', 'expired'))
    `);

    await knex.raw(`CREATE INDEX idx_stock_reservations_phone ON commercial.stock_reservations (tenant_id, phone, released_at)`);
    // Índice del cron: solo las activas vencidas.
    await knex.raw(`CREATE INDEX idx_stock_reservations_expires ON commercial.stock_reservations (expires_at) WHERE released_at IS NULL`);

    await knex.raw(`ALTER TABLE commercial.stock_reservations ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.stock_reservations FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.stock_reservations
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.stock_reservations TO app_runtime');
    await knex.raw(`COMMENT ON TABLE commercial.stock_reservations IS 'FIQ.6 (ADR-038): apartado de pedidos con TTL. Reserva stock (reserved_quantity) por un TTL; cron libera vencidos. Ancla por teléfono E.164 aun sin customer_id.'`);
  }

  // ── 3. commercial.stock_reservation_lines ──────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('stock_reservation_lines'))) {
    await knex.schema.withSchema('commercial').createTable('stock_reservation_lines', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('reservation_id').notNullable();
      table.uuid('product_id').notNullable();
      table.uuid('warehouse_id').notNullable();
      table.decimal('quantity', 14, 3).notNullable(); // piezas
      table.decimal('unit_price', 14, 4).notNullable().defaultTo(0);
      table.decimal('line_total', 14, 2).notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      table.primary('id');
      table.check('?? > 0', ['quantity'], 'commercial_stock_reservation_lines_qty_positive');
    });

    // Sin FK a public.tenants (VISTA en esta DB). tenant_id NOT NULL + RLS bastan.
    await knex.raw(`
      ALTER TABLE commercial.stock_reservation_lines
        ADD CONSTRAINT fk_stock_reservation_lines_reservation
        FOREIGN KEY (tenant_id, reservation_id)
        REFERENCES commercial.stock_reservations(tenant_id, id) ON DELETE CASCADE
    `);

    await knex.raw(`CREATE INDEX idx_stock_reservation_lines_res ON commercial.stock_reservation_lines (tenant_id, reservation_id)`);
    await knex.raw(`CREATE INDEX idx_stock_reservation_lines_product ON commercial.stock_reservation_lines (tenant_id, product_id)`);

    await knex.raw(`ALTER TABLE commercial.stock_reservation_lines ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.stock_reservation_lines FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.stock_reservation_lines
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.stock_reservation_lines TO app_runtime');
    await knex.raw(`COMMENT ON TABLE commercial.stock_reservation_lines IS 'FIQ.6: líneas del apartado (piezas + snapshot de precio). El cron libera reserved_quantity leyendo estas líneas.'`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_reservation_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_reservations');
  await knex.schema.withSchema('commercial').dropTableIfExists('reservation_sequences');
};
