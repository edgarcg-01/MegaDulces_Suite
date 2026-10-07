/**
 * Migración: shipment_expenses + load_details + unload_details + liquidations.
 *
 * Fase J.0.3b/J.0.4 — dominio financiero del viaje. Por cada shipment hay
 * un detalle de costos (combustible, casetas, viáticos, etc.), detalles de
 * carga/descarga (tarifas por colaborador) y liquidaciones por período.
 *
 * Tablas:
 *   1. logistics.shipment_expenses  — costos del viaje (origen: logistica_costos)
 *   2. logistics.load_details       — tarifas carga (origen: logistica_detalles_carga)
 *   3. logistics.unload_details     — tarifas descarga (origen: logistica_detalles_descarga)
 *   4. logistics.liquidations       — liquidaciones por colaborador/período (origen: logistica_liquidaciones)
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // logistics.shipment_expenses — costos del viaje (1:1 con shipment)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('shipment_expenses', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('shipment_id').notNullable();
    table.decimal('fuel', 14, 2).notNullable().defaultTo(0);
    table.decimal('tolls', 14, 2).notNullable().defaultTo(0); // casetas
    table.decimal('lodging', 14, 2).notNullable().defaultTo(0); // hospedaje
    table.decimal('parking', 14, 2).notNullable().defaultTo(0); // pensiones
    table.decimal('permits', 14, 2).notNullable().defaultTo(0); // permisos
    table.decimal('repairs', 14, 2).notNullable().defaultTo(0); // talachas
    table.decimal('external_helpers', 14, 2).notNullable().defaultTo(0); // ayudantes_ext
    table.decimal('handling', 14, 2).notNullable().defaultTo(0); // maniobras
    table.decimal('driver_per_diem', 14, 2).notNullable().defaultTo(0); // viaticos_guia
    table.decimal('other', 14, 2).notNullable().defaultTo(0);
    table.decimal('operating_subtotal', 14, 2).notNullable().defaultTo(0);
    table.decimal('fixed_cost_per_km', 14, 4).notNullable().defaultTo(0); // costo fijo por km al momento
    table.decimal('total_cost', 14, 2).notNullable().defaultTo(0);
    table.jsonb('extras'); // gastos adicionales no categorizados [{label, amount}]
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'shipment_id'], { indexName: 'logistics_shipment_expenses_tenant_shipment_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_shipment_expenses_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_shipment_expenses_tenant');
  });

  await knex.raw(`
    ALTER TABLE logistics.shipment_expenses
      ADD CONSTRAINT fk_logistics_shipment_expenses_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipment_expenses
      ADD CONSTRAINT fk_logistics_shipment_expenses_shipment
      FOREIGN KEY (tenant_id, shipment_id)
      REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.load_details — tarifa por colaborador en CARGA
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('load_details', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('shipment_id').notNullable();
    table.uuid('driver_id').notNullable(); // colaborador (chofer, ayudante, cargador)
    table.decimal('rate', 12, 2).notNullable().defaultTo(0); // tarifa pactada
    table.string('role_at_time', 30); // chofer | ayudante | cargador — snapshot del rol al momento
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_load_details_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_load_details_tenant');
    table.index(['tenant_id', 'shipment_id'], 'idx_logistics_load_details_tenant_shipment');
    table.index(['tenant_id', 'driver_id'], 'idx_logistics_load_details_tenant_driver');
  });

  await knex.raw(`
    ALTER TABLE logistics.load_details
      ADD CONSTRAINT fk_logistics_load_details_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.load_details
      ADD CONSTRAINT fk_logistics_load_details_shipment
      FOREIGN KEY (tenant_id, shipment_id)
      REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE logistics.load_details
      ADD CONSTRAINT fk_logistics_load_details_driver
      FOREIGN KEY (tenant_id, driver_id)
      REFERENCES logistics.drivers(tenant_id, id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.unload_details — tarifa por colaborador en DESCARGA (regreso/lab)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('unload_details', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('shipment_id').notNullable();
    table.uuid('driver_id').notNullable();
    table.decimal('amount', 12, 2).notNullable().defaultTo(0);
    table.string('type', 20).notNullable(); // regreso | lab
    table.string('role_at_time', 30);
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_unload_details_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_unload_details_tenant');
    table.index(['tenant_id', 'shipment_id'], 'idx_logistics_unload_details_tenant_shipment');
    table.index(['tenant_id', 'driver_id'], 'idx_logistics_unload_details_tenant_driver');
  });

  await knex.raw(`
    ALTER TABLE logistics.unload_details
      ADD CONSTRAINT fk_logistics_unload_details_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.unload_details
      ADD CONSTRAINT fk_logistics_unload_details_shipment
      FOREIGN KEY (tenant_id, shipment_id)
      REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE logistics.unload_details
      ADD CONSTRAINT fk_logistics_unload_details_driver
      FOREIGN KEY (tenant_id, driver_id)
      REFERENCES logistics.drivers(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.unload_details
      ADD CONSTRAINT logistics_unload_details_type_check
      CHECK (type IN ('regreso', 'lab'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.liquidations — liquidación por colaborador/período (catorcena)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('liquidations', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('driver_id').notNullable();
    table.uuid('period_id').notNullable();
    table.decimal('per_diem_amount', 14, 2).notNullable().defaultTo(0); // viáticos
    table.decimal('commissions_amount', 14, 2).notNullable().defaultTo(0);
    table.decimal('load_unload_amount', 14, 2).notNullable().defaultTo(0); // cargas + maniobras
    table.decimal('bonuses', 14, 2).notNullable().defaultTo(0);
    table.decimal('deductions', 14, 2).notNullable().defaultTo(0);
    table.decimal('subtotal', 14, 2).notNullable().defaultTo(0);
    table.decimal('net_amount', 14, 2).notNullable().defaultTo(0);
    table.string('status', 20).notNullable().defaultTo('calculado'); // calculado | revisado | pagado | anulado
    table.timestamp('paid_at');
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'driver_id', 'period_id'], { indexName: 'logistics_liquidations_tenant_driver_period_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_liquidations_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_liquidations_tenant');
    table.index(['tenant_id', 'period_id'], 'idx_logistics_liquidations_tenant_period');
    table.index(['tenant_id', 'driver_id'], 'idx_logistics_liquidations_tenant_driver');
    table.index(['tenant_id', 'status'], 'idx_logistics_liquidations_tenant_status');
  });

  await knex.raw(`
    ALTER TABLE logistics.liquidations
      ADD CONSTRAINT fk_logistics_liquidations_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.liquidations
      ADD CONSTRAINT fk_logistics_liquidations_driver
      FOREIGN KEY (tenant_id, driver_id)
      REFERENCES logistics.drivers(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.liquidations
      ADD CONSTRAINT fk_logistics_liquidations_period
      FOREIGN KEY (tenant_id, period_id)
      REFERENCES logistics.payroll_periods(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.liquidations
      ADD CONSTRAINT logistics_liquidations_status_check
      CHECK (status IN ('calculado', 'revisado', 'pagado', 'anulado'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // RLS forzado + grants
  // ─────────────────────────────────────────────────────────────────────────
  const tables = [
    'logistics.shipment_expenses',
    'logistics.load_details',
    'logistics.unload_details',
    'logistics.liquidations',
  ];
  for (const t of tables) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables.join(', ')} TO app_runtime`);

  // Comments
  await knex.raw(`COMMENT ON COLUMN logistics.shipment_expenses.operating_subtotal IS 'Suma de fuel+tolls+lodging+parking+permits+repairs+external_helpers+handling+driver_per_diem+other. Pre-cálculo para reports.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.liquidations.net_amount IS 'Liquidación final tras deducciones. subtotal - deductions + bonuses.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('liquidations');
  await knex.schema.withSchema('logistics').dropTableIfExists('unload_details');
  await knex.schema.withSchema('logistics').dropTableIfExists('load_details');
  await knex.schema.withSchema('logistics').dropTableIfExists('shipment_expenses');
};
