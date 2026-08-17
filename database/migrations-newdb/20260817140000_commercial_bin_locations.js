/**
 * Fase WMS-REC (Pieza 3 — Ubicación bin-level lote×posición, ADR-044).
 *
 * `commercial.warehouse_bins` = posiciones físicas finas (rack-nivel-posición) dentro
 * de un pasillo. `commercial.stock_lot_locations` = el AUXILIAR DE UBICACIONES: cuánta
 * cantidad de cada (producto, lote, caducidad) está en cada bin.
 *
 * Modelo (deliberadamente NO invariante estricto): SUM(ubicaciones de un lote) ≤
 * stock_lots.quantity de ese lote. El remanente = "por ubicar" (la recepción suma al
 * lote antes del put-away). La regla ≤ se valida en el servicio (no trigger), para no
 * chocar con recepción-antes-de-ubicar.
 *
 * `warehouse_bins.aisle_id` es un uuid SIN FK dura a warehouse_aisles (se valida en el
 * servicio) para no depender de su unicidad compuesta. Aditivo e idempotente. RLS
 * forzado + grant app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── warehouse_bins ──
  if (!(await knex.schema.withSchema('commercial').hasTable('warehouse_bins'))) {
    await knex.schema.withSchema('commercial').createTable('warehouse_bins', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.uuid('aisle_id'); // pasillo (opcional, sin FK dura — validado en servicio)
      t.string('code', 40).notNullable(); // ej. "R12-N03-B"
      t.string('label', 120);
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_wh_bins_tenant_id_composite' });
      t.unique(['tenant_id', 'warehouse_id', 'code'], { indexName: 'commercial_wh_bins_code_unique' });
      t.index(['tenant_id', 'warehouse_id'], 'idx_commercial_wh_bins_wh');
      t.index(['tenant_id', 'aisle_id'], 'idx_commercial_wh_bins_aisle');
    });
    await knex.raw(`
      ALTER TABLE commercial.warehouse_bins
        ADD CONSTRAINT fk_commercial_wh_bins_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.warehouse_bins
        ADD CONSTRAINT fk_commercial_wh_bins_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`ALTER TABLE commercial.warehouse_bins ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.warehouse_bins FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.warehouse_bins`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.warehouse_bins
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.warehouse_bins TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.warehouse_bins IS 'Posiciones físicas finas (rack-nivel-posición) por almacén (ADR-044, Pieza 3).'`);
  }

  // ── stock_lot_locations ──
  if (!(await knex.schema.withSchema('commercial').hasTable('stock_lot_locations'))) {
    await knex.schema.withSchema('commercial').createTable('stock_lot_locations', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.uuid('product_id').notNullable();
      t.string('lot_code', 60).notNullable().defaultTo('NA');
      t.date('expiry_date');
      t.uuid('bin_id').notNullable();
      t.decimal('quantity', 14, 3).notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_stock_lot_loc_tenant_id_composite' });
      t.check('?? >= 0', ['quantity'], 'commercial_stock_lot_loc_qty_nonneg');
      t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_stock_lot_loc_whp');
      t.index(['tenant_id', 'bin_id'], 'idx_commercial_stock_lot_loc_bin');
    });
    // Una fila por (lote × bin). NULLS NOT DISTINCT para que expiry NULL sea única.
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_stock_lot_loc_natural_unique
        ON commercial.stock_lot_locations (tenant_id, warehouse_id, product_id, lot_code, expiry_date, bin_id)
        NULLS NOT DISTINCT
    `);
    await knex.raw(`
      ALTER TABLE commercial.stock_lot_locations
        ADD CONSTRAINT fk_commercial_stock_lot_loc_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.stock_lot_locations
        ADD CONSTRAINT fk_commercial_stock_lot_loc_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.stock_lot_locations
        ADD CONSTRAINT fk_commercial_stock_lot_loc_product
        FOREIGN KEY (tenant_id, product_id)
        REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.stock_lot_locations
        ADD CONSTRAINT fk_commercial_stock_lot_loc_bin
        FOREIGN KEY (tenant_id, bin_id)
        REFERENCES commercial.warehouse_bins(tenant_id, id) ON DELETE RESTRICT
    `);
    await knex.raw(`ALTER TABLE commercial.stock_lot_locations ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.stock_lot_locations FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.stock_lot_locations`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.stock_lot_locations
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.stock_lot_locations TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE commercial.stock_lot_locations IS 'Auxiliar de ubicaciones (ADR-044, Pieza 3): cantidad de (producto,lote,caducidad) por bin. SUM(ubicado) ≤ stock_lots.quantity; remanente = por ubicar.'`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_lot_locations');
  await knex.schema.withSchema('commercial').dropTableIfExists('warehouse_bins');
};
