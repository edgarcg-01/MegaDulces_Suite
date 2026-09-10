/**
 * FC.1 — Asignación vehicular: derecho de uso + acta de entrega.
 *
 * Digitaliza el "FORMATO DE ASIGNACIÓN VEHICULAR" que hoy se llena en papel y
 * modela quién PUEDE usar cada unidad, que es distinto de quién la trae hoy.
 *
 * Dos conceptos, dos tablas, a propósito:
 *
 *   1. `logistics.vehicle_entitlements` — el DERECHO. Un colaborador está
 *      autorizado a usar una unidad, con vigencia. Es permiso permanente y
 *      responde "¿a qué vehículos tiene derecho fulano?". Lo consulta el alta
 *      de cualquier movimiento para no dejar salir una unidad que no le toca.
 *
 *   2. `logistics.vehicle_assignments` — el ACTA. El hecho puntual de entregar
 *      la unidad: folio, kilometraje, responsable administrativo, chofer, y el
 *      estado físico de ~50 piezas calificadas M/R/B. Es lo que se firma.
 *
 * Por qué el estado NO reusa `logistics.shipment_checklists`: ese cuelga de un
 * EMBARQUE y su respuesta es booleana (`ok: true/false`). El formato califica en
 * tres niveles (Malo/Regular/Bueno) y cuelga de unidad + persona. Meterlo ahí
 * habría obligado a colapsar "Regular" contra "Bueno" o contra "Malo", que es
 * justo la información que el formato existe para capturar.
 *
 * La PERSONA es `logistics.drivers`: ya es el padrón de personal de logística y
 * su `user_id` es nullable, o sea que sirve igual para quien entra al sistema y
 * para quien sólo tiene ficha. Se le amplían los roles para que quepa el
 * responsable administrativo, que no es chofer.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ───────────────────────────────────────────────────────────────────────
  // 1. Datos de la unidad que el formato pide y `vehicles` no tenía
  // ───────────────────────────────────────────────────────────────────────
  const cols = [
    ['economic_number', (t) => t.string('economic_number', 30)],
    ['vin', (t) => t.string('vin', 30)],           // "No. de serie" en el formato
    ['engine_number', (t) => t.string('engine_number', 40)], // "No. de motor"
    ['color', (t) => t.string('color', 40)],
    ['current_odometer', (t) => t.decimal('current_odometer', 12, 2)],
  ];
  for (const [name, add] of cols) {
    if (!(await knex.schema.hasColumn('logistics.vehicles', name))) {
      await knex.schema.withSchema('logistics').alterTable('vehicles', add);
    }
  }
  await knex.raw(`
    COMMENT ON COLUMN logistics.vehicles.current_odometer IS
      'Kilometraje denormalizado. Lo escribe el acta de asignación o el motor de odómetro; NO se teclea suelto.'`);

  // Número económico único por tenant cuando está presente.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_logistics_vehicles_economic
      ON logistics.vehicles (tenant_id, economic_number)
      WHERE economic_number IS NOT NULL AND deleted_at IS NULL`);

  // ───────────────────────────────────────────────────────────────────────
  // 2. El padrón de personal admite al responsable administrativo
  // ───────────────────────────────────────────────────────────────────────
  // `drivers.roles` es text[] y hasta acá sólo aceptaba chofer|ayudante|cargador
  // por validación en el servicio (no había CHECK en DB). El formato distingue
  // dos figuras — §3.1 responsable administrativo y §3.2 responsable operativo —
  // y la primera no maneja: autoriza.
  await knex.raw(`
    COMMENT ON COLUMN logistics.drivers.roles IS
      'chofer | ayudante | cargador | responsable_administrativo. El responsable NO conduce: es quien responde por la unidad (formato de asignación).'`);

  // ───────────────────────────────────────────────────────────────────────
  // 3. DERECHO de uso: a qué unidades está autorizado un colaborador
  // ───────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('vehicle_entitlements'))) {
    await knex.schema.withSchema('logistics').createTable('vehicle_entitlements', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('driver_id').notNullable();   // el colaborador (padrón logistics.drivers)
      t.uuid('vehicle_id').notNullable();
      // Con qué carácter: conduce, o responde por ella.
      t.string('capacity', 30).notNullable().defaultTo('chofer');
      t.date('valid_from').notNullable().defaultTo(knex.fn.now());
      t.date('valid_to');                  // NULL = vigente
      t.text('source');                    // de dónde salió: 'formato_asignacion', 'alta_manual', ...
      t.text('notes');

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at', { useTz: true });
      t.uuid('deleted_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicle_entitlements_tenant_id_composite' });
      t.index(['tenant_id', 'driver_id'], 'idx_logistics_entitlements_driver');
      t.index(['tenant_id', 'vehicle_id'], 'idx_logistics_entitlements_vehicle');
    });

    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements
      ADD CONSTRAINT fk_logistics_entitlements_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements
      ADD CONSTRAINT fk_logistics_entitlements_driver
      FOREIGN KEY (tenant_id, driver_id) REFERENCES logistics.drivers(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements
      ADD CONSTRAINT fk_logistics_entitlements_vehicle
      FOREIGN KEY (tenant_id, vehicle_id) REFERENCES logistics.vehicles(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements
      ADD CONSTRAINT logistics_entitlements_capacity_check
      CHECK (capacity IN ('chofer','responsable_administrativo','ayudante'))`);
    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements
      ADD CONSTRAINT logistics_entitlements_vigencia_check
      CHECK (valid_to IS NULL OR valid_to >= valid_from)`);

    // Un derecho VIGENTE por (colaborador, unidad, carácter). Parcial: el
    // histórico de derechos vencidos se conserva sin chocar.
    await knex.raw(`
      CREATE UNIQUE INDEX uq_logistics_entitlement_vigente
        ON logistics.vehicle_entitlements (tenant_id, driver_id, vehicle_id, capacity)
        WHERE valid_to IS NULL AND deleted_at IS NULL`);

    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.vehicle_entitlements FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.vehicle_entitlements
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.vehicle_entitlements TO app_runtime`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // 4. ACTA de asignación (el formato en papel, digitalizado)
  // ───────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasTable('vehicle_assignments'))) {
    await knex.schema.withSchema('logistics').createTable('vehicle_assignments', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('folio', 40).notNullable();          // el "FOLIO No." del formato
      t.uuid('vehicle_id').notNullable();
      t.uuid('responsible_driver_id');              // responsable administrativo
      t.uuid('driver_id');                          // chofer que la recibe
      t.string('area', 120);                        // área / departamento al que se asigna
      t.string('warehouse_code', 10);               // sucursal, si aplica
      t.decimal('odometer', 12, 2);                 // kilometraje al momento de la entrega
      t.date('assigned_on').notNullable();
      t.date('released_on');                        // devolución; NULL = vigente

      // Estado físico: { "<concepto_id>": "M" | "R" | "B" }. El formato califica
      // en TRES niveles; un booleano perdería el "Regular".
      t.jsonb('condition');
      t.string('condition_template', 40);           // versión de la plantilla usada
      t.text('observations');                       // el texto manuscrito al pie
      t.text('scan_url');                           // la hoja firmada escaneada
      t.text('signature_url');

      t.string('status', 20).notNullable().defaultTo('vigente');

      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at', { useTz: true });
      t.uuid('deleted_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_vehicle_assignments_tenant_id_composite' });
      t.unique(['tenant_id', 'folio'], { indexName: 'uq_logistics_vehicle_assignments_folio' });
      t.index(['tenant_id', 'vehicle_id'], 'idx_logistics_assignments_vehicle');
      t.index(['tenant_id', 'driver_id'], 'idx_logistics_assignments_driver');
    });

    await knex.raw(`ALTER TABLE logistics.vehicle_assignments
      ADD CONSTRAINT fk_logistics_assignments_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.vehicle_assignments
      ADD CONSTRAINT fk_logistics_assignments_vehicle
      FOREIGN KEY (tenant_id, vehicle_id) REFERENCES logistics.vehicles(tenant_id, id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.vehicle_assignments
      ADD CONSTRAINT fk_logistics_assignments_driver
      FOREIGN KEY (tenant_id, driver_id) REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`ALTER TABLE logistics.vehicle_assignments
      ADD CONSTRAINT fk_logistics_assignments_responsible
      FOREIGN KEY (tenant_id, responsible_driver_id) REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`ALTER TABLE logistics.vehicle_assignments
      ADD CONSTRAINT logistics_assignments_status_check
      CHECK (status IN ('vigente','devuelto','cancelado'))`);
    await knex.raw(`ALTER TABLE logistics.vehicle_assignments
      ADD CONSTRAINT logistics_assignments_devolucion_check
      CHECK (released_on IS NULL OR released_on >= assigned_on)`);

    // Una sola asignación VIGENTE por unidad. Es el candado que impide que la
    // misma camioneta figure entregada a dos personas a la vez.
    await knex.raw(`
      CREATE UNIQUE INDEX uq_logistics_assignment_vigente
        ON logistics.vehicle_assignments (tenant_id, vehicle_id)
        WHERE status = 'vigente' AND deleted_at IS NULL`);

    await knex.raw(`ALTER TABLE logistics.vehicle_assignments ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.vehicle_assignments FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.vehicle_assignments
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.vehicle_assignments TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_assignments');
  await knex.schema.withSchema('logistics').dropTableIfExists('vehicle_entitlements');
  await knex.raw(`DROP INDEX IF EXISTS logistics.uq_logistics_vehicles_economic`);
  for (const col of ['economic_number', 'vin', 'engine_number', 'color', 'current_odometer']) {
    if (await knex.schema.hasColumn('logistics.vehicles', col)) {
      await knex.schema.withSchema('logistics').alterTable('vehicles', (t) => t.dropColumn(col));
    }
  }
};
