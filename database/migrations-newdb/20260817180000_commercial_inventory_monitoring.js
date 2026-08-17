/**
 * Fase PREV.2 — Monitoreo intensivo + ventanas de pérdida (Apéndice B §10-13).
 *
 * Tras una PÉRDIDA NO IDENTIFICADA, el SKU entra a monitoreo: varios conteos rápidos
 * al día. Cada conteo acota la VENTANA TEMPORAL donde se produjo el nuevo menoscabo
 * (entre el conteo previo y éste) → reduce el universo de investigación.
 *
 * `commercial.inventory_monitoring` (SKU×almacén en monitoreo, 1 activo por SKU) +
 * `commercial.inventory_monitoring_counts` (conteos rápidos con ventana). RLS forzado.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── inventory_monitoring ──
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_monitoring'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_monitoring', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.uuid('product_id').notNullable();
      t.uuid('source_investigation_id'); // expediente PNI que lo originó (sin FK dura)
      t.string('status', 12).notNullable().defaultTo('active'); // active | closed
      t.integer('counts_per_day').notNullable().defaultTo(2);
      t.text('reason');
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('started_by');
      t.timestamp('closed_at');
      t.uuid('closed_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_inv_monitoring_tenant_id_composite' });
      t.check("?? in ('active','closed')", ['status'], 'commercial_inv_monitoring_status_chk');
      t.index(['tenant_id', 'status'], 'idx_commercial_inv_monitoring_status');
      t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_inv_monitoring_whp');
    });
    await knex.raw(`
      ALTER TABLE commercial.inventory_monitoring
        ADD CONSTRAINT fk_commercial_inv_monitoring_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_monitoring
        ADD CONSTRAINT fk_commercial_inv_monitoring_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_monitoring
        ADD CONSTRAINT fk_commercial_inv_monitoring_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
    `);
    // Un solo monitoreo ACTIVO por (almacén, producto).
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_inv_monitoring_one_active
        ON commercial.inventory_monitoring (tenant_id, warehouse_id, product_id)
        WHERE status = 'active'
    `);
    await knex.raw(`ALTER TABLE commercial.inventory_monitoring ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_monitoring FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_monitoring`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.inventory_monitoring
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_monitoring TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.inventory_monitoring IS 'Monitoreo intensivo de un SKU tras pérdida no identificada (Fase PREV.2). 1 activo por (almacén,producto).'`);
  }

  // ── inventory_monitoring_counts ──
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_monitoring_counts'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_monitoring_counts', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('monitoring_id').notNullable();
      t.decimal('expected_qty', 14, 3).notNullable().defaultTo(0); // teórico del sistema al momento
      t.decimal('physical_qty', 14, 3).notNullable().defaultTo(0); // contado
      t.decimal('difference', 14, 3).notNullable().defaultTo(0); // physical - expected
      t.timestamp('window_from'); // conteo previo (o inicio del monitoreo)
      t.timestamp('window_to').notNullable().defaultTo(knex.fn.now()); // este conteo
      t.timestamp('counted_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('counted_by');
      t.text('notes');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_inv_moncounts_tenant_id_composite' });
      t.index(['tenant_id', 'monitoring_id'], 'idx_commercial_inv_moncounts_mon');
    });
    await knex.raw(`
      ALTER TABLE commercial.inventory_monitoring_counts
        ADD CONSTRAINT fk_commercial_inv_moncounts_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_monitoring_counts
        ADD CONSTRAINT fk_commercial_inv_moncounts_monitoring
        FOREIGN KEY (tenant_id, monitoring_id)
        REFERENCES commercial.inventory_monitoring(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`ALTER TABLE commercial.inventory_monitoring_counts ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.inventory_monitoring_counts FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_monitoring_counts`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.inventory_monitoring_counts
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_monitoring_counts TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.inventory_monitoring_counts IS 'Conteos rápidos del monitoreo intensivo (Fase PREV.2): expected vs físico + ventana temporal de la pérdida.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_monitoring_counts');
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_monitoring');
};
