/**
 * Fase PREV.1 — Expediente de investigación de diferencias de inventario (Apéndice B).
 *
 * Fase I resuelve "cuánto falta" (conteo + ledger). Prevención responde "por qué falta":
 * una diferencia confirmada abre un EXPEDIENTE con folio, se clasifica la CAUSA RAÍZ y
 * se cierra ligando el ajuste (nunca huérfano). Segregación: quien cuenta/reconcilia NO
 * es quien investiga (permisos COMMERCIAL_PREVENTION_*).
 *
 * `commercial.inventory_investigations` (folio INV-DIF-YYYY-NNNNN) + secuencia.
 * source_count_id/source_item_id son uuids SIN FK dura (validados en el servicio) para
 * no depender de la unicidad compuesta de inventory_counts. RLS forzado.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── secuencia de folio ──
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_investigation_sequences'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_investigation_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('year').notNullable();
      t.integer('last_seq').notNullable().defaultTo(0);
      t.primary(['tenant_id', 'year']);
    });
    await knex.raw(`ALTER TABLE commercial.inventory_investigation_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_investigation_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_investigation_sequences`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.inventory_investigation_sequences
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_investigation_sequences TO app_runtime`);
  }

  // ── inventory_investigations ──
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_investigations'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_investigations', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('folio', 24).notNullable(); // INV-DIF-YYYY-NNNNN
      t.uuid('warehouse_id').notNullable();
      t.uuid('product_id').notNullable();
      t.uuid('source_count_id'); // folio de conteo origen (sin FK dura)
      t.uuid('source_item_id');
      t.decimal('expected_qty', 14, 3).notNullable().defaultTo(0);
      t.decimal('physical_qty', 14, 3).notNullable().defaultTo(0);
      t.decimal('difference', 14, 3).notNullable().defaultTo(0); // physical - expected (firmado)
      t.decimal('unit_cost', 14, 4).notNullable().defaultTo(0);
      t.decimal('value_at_cost', 16, 4).notNullable().defaultTo(0); // difference * unit_cost (firmado)
      t.string('status', 16).notNullable().defaultTo('open'); // open | investigating | resolved | monitoring
      // Causa raíz: EC error conteo · ER error recepción · EA error aplicación · DC dev cliente ·
      // DP dev proveedor · TR transferencia · UB ubicación · MR merma · PNI pérdida no identificada
      t.string('root_cause', 8);
      t.string('reason_code', 30); // heredado del item de conteo, si aplica
      t.text('resolution_notes');
      t.uuid('adjustment_movement_id'); // liga al movimiento de ajuste (nunca huérfano)
      t.uuid('opened_by');
      t.timestamp('opened_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('resolved_by');
      t.timestamp('resolved_at');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_inv_investig_tenant_id_composite' });
      t.unique(['tenant_id', 'folio'], { indexName: 'commercial_inv_investig_folio_unique' });
      t.check("?? in ('open','investigating','resolved','monitoring')", ['status'], 'commercial_inv_investig_status_chk');
      t.check("?? is null or ?? in ('EC','ER','EA','DC','DP','TR','UB','MR','PNI')", ['root_cause', 'root_cause'], 'commercial_inv_investig_cause_chk');
      t.index(['tenant_id', 'status'], 'idx_commercial_inv_investig_status');
      t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_inv_investig_whp');
      // Un expediente por item de conteo (evita duplicar al importar de un folio).
      t.index(['tenant_id', 'source_item_id'], 'idx_commercial_inv_investig_item');
    });
    await knex.raw(`
      ALTER TABLE commercial.inventory_investigations
        ADD CONSTRAINT fk_commercial_inv_investig_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_investigations
        ADD CONSTRAINT fk_commercial_inv_investig_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_investigations
        ADD CONSTRAINT fk_commercial_inv_investig_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
    `);
    // Un solo expediente por item de conteo origen (parcial, ignora los manuales sin item).
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_inv_investig_one_per_item
        ON commercial.inventory_investigations (tenant_id, source_item_id)
        WHERE source_item_id IS NOT NULL
    `);
    await knex.raw(`ALTER TABLE commercial.inventory_investigations ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_investigations FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_investigations`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.inventory_investigations
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_investigations TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.inventory_investigations IS 'Expediente de investigación de diferencias (Fase PREV.1, Apéndice B): por qué falta + causa raíz + ajuste ligado. Segregación: COMMERCIAL_PREVENTION_*.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_investigations');
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_investigation_sequences');
};
