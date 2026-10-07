/**
 * Migración: schema `logistics` + catálogos base.
 *
 * Fase J — Logística (embarques, flotilla, costos). Importado del repo
 * Megadulces-Logistica (commit 14d7fe0) y re-escrito para multi-tenant:
 *   - schema dedicado `logistics.*`
 *   - tenant_id UUID NOT NULL en todas las tablas
 *   - composite unique (tenant_id, id) para FK cross-table
 *   - RLS forzado + tenant_isolation policy
 *   - grants a app_runtime (NOSUPERUSER, no bypass RLS)
 *
 * Tablas de esta migración (catálogos):
 *   1. logistics.routes              — destinos/rutas con comisiones base (origen: logistica_catalogo_destinos)
 *   2. logistics.drivers             — choferes/ayudantes/cargadores (origen: logistica_colaboradores)
 *   3. logistics.vehicles            — flotilla (origen: logistica_unidades)
 *   4. logistics.payroll_periods     — catorcenales de pago (origen: logistica_periodos)
 *   5. logistics.config_finance      — factores y costos km (origen: logistica_config_finanzas)
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS logistics');
  await knex.raw('GRANT USAGE ON SCHEMA logistics TO app_runtime');
  await knex.raw('ALTER DEFAULT PRIVILEGES IN SCHEMA logistics GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime');

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.routes — catálogo de destinos con comisiones base
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('routes', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('name', 200).notNullable();
    table.string('origin', 200);
    table.string('destination', 200);
    table.integer('estimated_km');
    table.decimal('driver_commission', 12, 2).notNullable().defaultTo(0);
    table.decimal('helper_commission', 12, 2).notNullable().defaultTo(0);
    table.boolean('active').notNullable().defaultTo(true);
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'name'], { indexName: 'logistics_routes_tenant_name_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_routes_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_routes_tenant');
    table.index(['tenant_id', 'active'], 'idx_logistics_routes_tenant_active');
  });

  await knex.raw(`
    ALTER TABLE logistics.routes
      ADD CONSTRAINT fk_logistics_routes_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.drivers — colaboradores logísticos (chofer/ayudante/cargador)
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('drivers', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('full_name', 200).notNullable();
    table.specificType('roles', 'text[]').notNullable(); // ['chofer', 'ayudante', 'cargador']
    table.string('employee_type', 20).notNullable().defaultTo('interno'); // interno | externo
    table.string('status', 20).notNullable().defaultTo('activo'); // activo | inactivo | suspendido
    table.string('nss', 20);
    table.string('phone', 50);
    table.string('emergency_contact', 200);
    table.uuid('user_id'); // opcional: vincular a public.users (cuando el chofer tiene login en la app)
    table.boolean('active').notNullable().defaultTo(true);
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_drivers_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_drivers_tenant');
    table.index(['tenant_id', 'active'], 'idx_logistics_drivers_tenant_active');
    table.index(['tenant_id', 'full_name'], 'idx_logistics_drivers_tenant_name');
  });

  await knex.raw(`
    ALTER TABLE logistics.drivers
      ADD CONSTRAINT fk_logistics_drivers_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.drivers
      ADD CONSTRAINT fk_logistics_drivers_user
      FOREIGN KEY (tenant_id, user_id)
      REFERENCES public.users(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.drivers
      ADD CONSTRAINT logistics_drivers_status_check
      CHECK (status IN ('activo', 'inactivo', 'suspendido'))
  `);
  await knex.raw(`
    ALTER TABLE logistics.drivers
      ADD CONSTRAINT logistics_drivers_employee_type_check
      CHECK (employee_type IN ('interno', 'externo'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.vehicles — flotilla
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('vehicles', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('plate', 20).notNullable();
    table.string('model', 100);
    table.string('brand', 100);
    table.integer('year');
    table.decimal('fuel_efficiency_km_l', 10, 2); // km por litro
    table.integer('capacity_boxes');
    table.decimal('capacity_kg', 12, 2);
    table.string('status', 30).notNullable().defaultTo('disponible'); // disponible | en_ruta | mantenimiento | baja
    table.text('notes');
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'plate'], { indexName: 'logistics_vehicles_tenant_plate_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicles_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_vehicles_tenant');
    table.index(['tenant_id', 'active'], 'idx_logistics_vehicles_tenant_active');
    table.index(['tenant_id', 'status'], 'idx_logistics_vehicles_tenant_status');
  });

  await knex.raw(`
    ALTER TABLE logistics.vehicles
      ADD CONSTRAINT fk_logistics_vehicles_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.vehicles
      ADD CONSTRAINT logistics_vehicles_status_check
      CHECK (status IN ('disponible', 'en_ruta', 'mantenimiento', 'baja'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.payroll_periods — catorcenales
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('payroll_periods', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.integer('number').notNullable(); // número de catorcena en el año
    table.integer('year').notNullable();
    table.date('start_date').notNullable();
    table.date('end_date').notNullable();
    table.date('payment_date').notNullable();
    table.string('status', 20).notNullable().defaultTo('abierto'); // abierto | calculado | pagado | cerrado
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'year', 'number'], { indexName: 'logistics_payroll_periods_tenant_year_number_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_payroll_periods_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_payroll_periods_tenant');
    table.index(['tenant_id', 'status'], 'idx_logistics_payroll_periods_tenant_status');
  });

  await knex.raw(`
    ALTER TABLE logistics.payroll_periods
      ADD CONSTRAINT fk_logistics_payroll_periods_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.payroll_periods
      ADD CONSTRAINT logistics_payroll_periods_status_check
      CHECK (status IN ('abierto', 'calculado', 'pagado', 'cerrado'))
  `);
  await knex.raw(`
    ALTER TABLE logistics.payroll_periods
      ADD CONSTRAINT logistics_payroll_periods_dates_check
      CHECK (end_date >= start_date AND payment_date >= end_date)
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.config_finance — factores y costos km
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('config_finance', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('key', 100).notNullable(); // 'factor_jalisco', 'costo_km_internacional', etc.
    table.string('category', 50).notNullable(); // factor | costo_km | tarifa_maniobra | viatico
    table.string('description', 300);
    table.decimal('value', 14, 4).notNullable();
    table.string('unit', 30); // 'mxn/km', 'pct', 'mxn'
    table.boolean('active').notNullable().defaultTo(true);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'key'], { indexName: 'logistics_config_finance_tenant_key_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_config_finance_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_config_finance_tenant');
    table.index(['tenant_id', 'category'], 'idx_logistics_config_finance_tenant_category');
  });

  await knex.raw(`
    ALTER TABLE logistics.config_finance
      ADD CONSTRAINT fk_logistics_config_finance_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.config_finance
      ADD CONSTRAINT logistics_config_finance_category_check
      CHECK (category IN ('factor', 'costo_km', 'tarifa_maniobra', 'viatico', 'otro'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // RLS forzado + grants
  // ─────────────────────────────────────────────────────────────────────────
  const tables = [
    'logistics.routes',
    'logistics.drivers',
    'logistics.vehicles',
    'logistics.payroll_periods',
    'logistics.config_finance',
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
  await knex.raw(`COMMENT ON COLUMN logistics.drivers.roles IS 'Array de roles: chofer | ayudante | cargador. Un colaborador puede tener varios.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.drivers.user_id IS 'Link opcional a public.users cuando el chofer tiene login para app mobile.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.config_finance.key IS 'Clave única del parámetro (ej: factor_jalisco, costo_km_internacional).'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('config_finance');
  await knex.schema.withSchema('logistics').dropTableIfExists('payroll_periods');
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicles');
  await knex.schema.withSchema('logistics').dropTableIfExists('drivers');
  await knex.schema.withSchema('logistics').dropTableIfExists('routes');
  // No droppeamos el schema acá — la última migración de logistics se encarga
};
