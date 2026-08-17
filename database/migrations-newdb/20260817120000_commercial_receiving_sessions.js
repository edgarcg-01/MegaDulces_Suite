/**
 * Fase WMS-REC (Pieza 1 — Modo recepción por escaneo / Vale de Entrada vivo, ADR-044).
 *
 * `commercial.receiving_sessions` = el Vale de Entrada VIVO de la rampa: el operador
 * abre una sesión (desde una orden de entrada del ERP o manual), escanea caja/pieza
 * contra lo esperado, y el sistema le dice qué falta validar + faltantes/sobrantes.
 * `commercial.receiving_lines` = una fila por SKU esperado/recibido (expected vs
 * received + discrepancia). `receiving_session_sequences` = folio VE-YYYY-NNNNN.
 *
 * NOTA: esta pieza captura CANTIDADES (identidad física). La caducidad/lote la
 * audita la Pieza 2 (commercial.receiving_lot_captures), enlazada por source_ref.
 *
 * Aditivo e idempotente. RLS forzado + grant app_runtime. FKs compuestas.
 * product_id NULLABLE: una línea esperada del ERP puede no mapear a catalog.products
 * (se guarda expected_sku/expected_name para mostrarla igual).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── receiving_session_sequences ──
  if (!(await knex.schema.withSchema('commercial').hasTable('receiving_session_sequences'))) {
    await knex.schema.withSchema('commercial').createTable('receiving_session_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('year').notNullable();
      t.integer('last_seq').notNullable().defaultTo(0);
      t.primary(['tenant_id', 'year']);
    });
    await knex.raw(`ALTER TABLE commercial.receiving_session_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.receiving_session_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.receiving_session_sequences`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.receiving_session_sequences
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.receiving_session_sequences TO app_runtime`);
  }

  // ── receiving_sessions ──
  if (!(await knex.schema.withSchema('commercial').hasTable('receiving_sessions'))) {
    await knex.schema.withSchema('commercial').createTable('receiving_sessions', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('folio', 24).notNullable(); // VE-YYYY-NNNNN
      t.uuid('warehouse_id').notNullable();
      t.string('supplier_code', 60);
      t.string('source_kind', 20).notNullable().defaultTo('manual'); // manual | erp_receipt
      t.string('source_ref', 120); // folio de la orden de entrada ERP, si aplica
      t.string('status', 16).notNullable().defaultTo('open'); // open | validating | closed | cancelled
      t.text('notes');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('closed_at');
      t.uuid('closed_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_recv_sessions_tenant_id_composite' });
      t.unique(['tenant_id', 'folio'], { indexName: 'commercial_recv_sessions_folio_unique' });
      t.check("?? in ('manual','erp_receipt')", ['source_kind'], 'commercial_recv_sessions_source_chk');
      t.check("?? in ('open','validating','closed','cancelled')", ['status'], 'commercial_recv_sessions_status_chk');
      t.index(['tenant_id', 'status'], 'idx_commercial_recv_sessions_status');
      t.index(['tenant_id', 'warehouse_id'], 'idx_commercial_recv_sessions_wh');
    });
    await knex.raw(`
      ALTER TABLE commercial.receiving_sessions
        ADD CONSTRAINT fk_commercial_recv_sessions_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.receiving_sessions
        ADD CONSTRAINT fk_commercial_recv_sessions_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`ALTER TABLE commercial.receiving_sessions ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.receiving_sessions FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.receiving_sessions`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.receiving_sessions
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.receiving_sessions TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.receiving_sessions IS 'Vale de Entrada vivo (ADR-044, Pieza 1): recepción por escaneo, expected vs físico. Caducidad = Pieza 2 (receiving_lot_captures) por source_ref.'`);
  }

  // ── receiving_lines ──
  if (!(await knex.schema.withSchema('commercial').hasTable('receiving_lines'))) {
    await knex.schema.withSchema('commercial').createTable('receiving_lines', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('session_id').notNullable();
      t.uuid('product_id'); // nullable: línea esperada no mapeada a catálogo
      t.string('expected_sku', 60);
      t.string('expected_name', 200);
      t.decimal('expected_qty', 14, 3).notNullable().defaultTo(0);
      t.decimal('received_qty', 14, 3).notNullable().defaultTo(0);
      t.string('barcode_scanned', 80);
      t.string('discrepancy_kind', 24).notNullable().defaultTo('pending'); // pending|ok|faltante|sobrante|producto_incorrecto|dañado
      t.text('notes');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_recv_lines_tenant_id_composite' });
      t.check("?? in ('pending','ok','faltante','sobrante','producto_incorrecto','dañado')", ['discrepancy_kind'], 'commercial_recv_lines_disc_chk');
      t.index(['tenant_id', 'session_id'], 'idx_commercial_recv_lines_session');
    });
    await knex.raw(`
      ALTER TABLE commercial.receiving_lines
        ADD CONSTRAINT fk_commercial_recv_lines_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.receiving_lines
        ADD CONSTRAINT fk_commercial_recv_lines_session
        FOREIGN KEY (tenant_id, session_id)
        REFERENCES commercial.receiving_sessions(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE commercial.receiving_lines
        ADD CONSTRAINT fk_commercial_recv_lines_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`ALTER TABLE commercial.receiving_lines ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.receiving_lines FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.receiving_lines`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.receiving_lines
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.receiving_lines TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.receiving_lines IS 'Líneas del Vale vivo (ADR-044, Pieza 1): expected_qty (snapshot esperado) vs received_qty (escaneado) + discrepancia.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('receiving_lines');
  await knex.schema.withSchema('commercial').dropTableIfExists('receiving_sessions');
  await knex.schema.withSchema('commercial').dropTableIfExists('receiving_session_sequences');
};
