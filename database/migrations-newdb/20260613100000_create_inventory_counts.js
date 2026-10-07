/**
 * Fase I.0 — Inventario físico (conteo cíclico / total por almacén).
 *
 * Modela el proceso manual de "hacer inventario" (marbeteo + doble conteo)
 * como una sesión digital con conteo ciego y reconciliación auditable:
 *
 *   commercial.inventory_counts          — el folio/sesión (por almacén)
 *   commercial.inventory_count_items     — una fila por SKU contado
 *   commercial.inventory_count_sequences — counter atómico para folio INV-YYYY-NNNNN
 *
 * Principios de control embebidos en el schema:
 *   - expected_qty = snapshot del teórico al abrir el folio. Es la base del
 *     conteo CIEGO: se guarda pero el endpoint de conteo nunca lo devuelve.
 *   - count_1/count_2/count_3 = conteos sucesivos por contadores DISTINTOS.
 *   - La varianza (final_qty - expected_qty) se calcula al resolver y se
 *     materializa para reporte y para el ajuste posterior.
 *   - freeze_movements = bandera que los demás módulos (orders, route-control)
 *     deben respetar para no mover stock mientras se cuenta (enforce en servicio).
 *
 * Granularidad: por (almacén, producto). commercial.stock ya es único por
 * (tenant, warehouse, product), así que el conteo es por SKU por almacén;
 * `location` viaja como pista de ubicación, no como eje de conteo.
 *
 * Cantidades decimal(14,3): hay ~9k SKUs con saldo fraccionado en prod.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ───────────────────────────────────────────────────────────────────────
  // inventory_count_sequences — counter atómico por (tenant, year) → folio
  // ───────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_count_sequences'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_count_sequences', (table) => {
      table.uuid('tenant_id').notNullable();
      table.integer('year').notNullable();
      table.integer('current_value').notNullable().defaultTo(0);
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      table.primary(['tenant_id', 'year']);
      table.check('?? > 0', ['year'], 'commercial_inv_count_seq_year_positive');
      table.check('?? >= 0', ['current_value'], 'commercial_inv_count_seq_current_nonneg');
    });
    await knex.raw(`
      ALTER TABLE commercial.inventory_count_sequences
        ADD CONSTRAINT fk_commercial_inv_count_seq_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE CASCADE
    `);
  }

  // ───────────────────────────────────────────────────────────────────────
  // inventory_counts — el folio/sesión de conteo, por almacén
  // ───────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_counts'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_counts', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('warehouse_id').notNullable();
      table.string('folio', 30).notNullable();
      table.string('type', 20).notNullable().defaultTo('full'); // full | cycle
      table.string('status', 24).notNullable().defaultTo('open');
      table.boolean('freeze_movements').notNullable().defaultTo(true);
      table.boolean('blind_double_count').notNullable().defaultTo(true);
      table.text('notes');

      table.timestamp('started_at');
      table.timestamp('closed_at');
      table.timestamp('reconciled_at');
      table.uuid('reconciled_by');

      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');

      table.primary('id');
      table.unique(['tenant_id', 'id'], { indexName: 'commercial_inv_counts_tenant_id_composite' });
      table.unique(['tenant_id', 'folio'], { indexName: 'commercial_inv_counts_folio_unique' });

      table.check(`?? IN ('full','cycle')`, ['type'], 'commercial_inv_counts_type_valid');
      table.check(
        `?? IN ('open','counting','review','ready_to_reconcile','reconciled','cancelled')`,
        ['status'],
        'commercial_inv_counts_status_valid',
      );

      table.index('tenant_id', 'idx_commercial_inv_counts_tenant');
      table.index(['tenant_id', 'warehouse_id'], 'idx_commercial_inv_counts_tenant_wh');
      table.index(['tenant_id', 'status'], 'idx_commercial_inv_counts_tenant_status');
    });

    await knex.raw(`
      ALTER TABLE commercial.inventory_counts
        ADD CONSTRAINT fk_commercial_inv_counts_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_counts
        ADD CONSTRAINT fk_commercial_inv_counts_warehouse
        FOREIGN KEY (tenant_id, warehouse_id)
        REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
    `);

    // Un solo folio ABIERTO (no terminal) por almacén a la vez: evita dos
    // inventarios físicos simultáneos sobre el mismo almacén pisándose el
    // snapshot del teórico. Índice parcial único.
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_inv_counts_one_open_per_wh
        ON commercial.inventory_counts (tenant_id, warehouse_id)
        WHERE status IN ('open','counting','review','ready_to_reconcile')
    `);
  }

  // ───────────────────────────────────────────────────────────────────────
  // inventory_count_items — una fila por SKU contado dentro del folio
  // ───────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('inventory_count_items'))) {
    await knex.schema.withSchema('commercial').createTable('inventory_count_items', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('count_id').notNullable();
      table.uuid('product_id').notNullable();
      table.string('location', 40); // snapshot de products.location (pista para el contador)

      table.decimal('expected_qty', 14, 3).notNullable().defaultTo(0); // teórico al abrir — OCULTO al contador

      table.decimal('count_1', 14, 3);
      table.uuid('counted_by_1');
      table.timestamp('counted_at_1');
      table.decimal('count_2', 14, 3);
      table.uuid('counted_by_2');
      table.timestamp('counted_at_2');
      table.decimal('count_3', 14, 3);
      table.uuid('counted_by_3');
      table.timestamp('counted_at_3');

      table.decimal('final_qty', 14, 3); // valor físico aceptado
      table.decimal('variance', 14, 3); // final_qty - expected_qty (firmado)
      table.string('status', 16).notNullable().defaultTo('pending'); // pending|counted|discrepancy|resolved
      table.text('notes'); // motivo de resolución (merma, dañado, robo, error captura)

      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');

      table.primary('id');
      table.unique(['tenant_id', 'id'], { indexName: 'commercial_inv_items_tenant_id_composite' });
      table.unique(['tenant_id', 'count_id', 'product_id'], { indexName: 'commercial_inv_items_count_product_unique' });

      table.check(
        `?? IN ('pending','counted','discrepancy','resolved')`,
        ['status'],
        'commercial_inv_items_status_valid',
      );

      table.index(['tenant_id', 'count_id'], 'idx_commercial_inv_items_count');
      table.index(['tenant_id', 'count_id', 'status'], 'idx_commercial_inv_items_count_status');
    });

    await knex.raw(`
      ALTER TABLE commercial.inventory_count_items
        ADD CONSTRAINT fk_commercial_inv_items_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_count_items
        ADD CONSTRAINT fk_commercial_inv_items_count
        FOREIGN KEY (tenant_id, count_id)
        REFERENCES commercial.inventory_counts(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE commercial.inventory_count_items
        ADD CONSTRAINT fk_commercial_inv_items_product
        FOREIGN KEY (product_id)
        REFERENCES catalog.products(id) ON DELETE RESTRICT
    `);
  }

  // RLS + grants para las 3 tablas
  for (const t of [
    'commercial.inventory_count_sequences',
    'commercial.inventory_counts',
    'commercial.inventory_count_items',
  ]) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO app_runtime`);
  }

  await knex.raw(`COMMENT ON COLUMN commercial.inventory_count_items.expected_qty IS 'Snapshot del teórico (commercial.stock.quantity) al abrir el folio. Base del conteo CIEGO — nunca se devuelve al rol contador.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.inventory_counts.freeze_movements IS 'Si true, los módulos que escriben stock (orders, route-control) deben rechazar movimientos en este almacén mientras el folio no esté en estado terminal.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_count_items');
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_counts');
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_count_sequences');
};
