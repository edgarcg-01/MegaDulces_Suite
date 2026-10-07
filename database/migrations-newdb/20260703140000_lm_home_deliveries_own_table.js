/**
 * Fase LM — DESACOPLE Reparto ↔ Logística (decisión usuario 2026-07-03).
 *
 * El repartidor es un USUARIO con rol `repartidor` (dominio Reparto), NO un
 * chofer de la flota de logística. La entrega a domicilio deja de colgar de
 * logistics.shipments/delivery_guides/guide_recipients/drivers y pasa a una
 * tabla PROPIA del módulo comercial:
 *
 *   commercial.home_deliveries          — 1 fila = 1 parada asignada a un repartidor.
 *   commercial.home_delivery_sequences  — counter atómico para folio REP-YYYY-NNNNN.
 *
 * La parada trae todo lo que vivía en guide_recipients (POD/firma/foto/GPS,
 * cobro COD, snapshot Kepler, incidencia). `rider_user_id` (FK identity.users)
 * es el asignado. `vehicle_id` (moto) es OPCIONAL y suave: no hay FK dura a
 * logistics.vehicles para no re-acoplar; si viene, sirve para overflow CEDIS.
 *
 * NO se borran las tablas logistics.* (regla: no borrar). Los datos viejos
 * quedan; el flujo nuevo escribe/lee solo aquí.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── sequences (folio atómico por tenant+año) ─────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('home_delivery_sequences'))) {
    await knex.schema.withSchema('commercial').createTable('home_delivery_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('year').notNullable();
      t.integer('current_value').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'year']);
      t.check('?? >= 0', ['current_value'], 'commercial_home_del_seq_nonneg');
    });
    await knex.raw(`
      ALTER TABLE commercial.home_delivery_sequences
        ADD CONSTRAINT fk_commercial_home_del_seq_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE CASCADE
    `);
  }

  // ── home_deliveries ──────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('home_deliveries'))) {
    await knex.schema.withSchema('commercial').createTable('home_deliveries', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('folio', 40);

      // Asignación: usuario repartidor (dominio Reparto). Moto opcional.
      t.uuid('rider_user_id');
      t.uuid('vehicle_id'); // moto opcional (soft ref, sin FK dura a logistics)

      // Origen: intake propio (order_id) O referencia a folio Kepler.
      t.uuid('order_id');
      t.uuid('customer_id');
      t.string('kepler_folio', 40);
      t.string('kepler_serie', 40);
      t.string('kepler_warehouse_code', 10);

      // Destinatario + carga.
      t.string('customer_name', 200);
      t.string('phone', 40);
      t.jsonb('delivery_address'); // {street, references, recipient_name, lat, lng, ...}
      t.jsonb('items_snapshot'); // qué cargar (líneas del ticket/pedido)
      t.decimal('value', 14, 2).notNullable().defaultTo(0);
      t.integer('units').notNullable().defaultTo(0);

      // Cobro contra entrega.
      t.boolean('collect_on_delivery').notNullable().defaultTo(false);
      t.decimal('amount_to_collect', 14, 2);

      // Overflow moto → CEDIS (aviso, no auto-split en MVP).
      t.boolean('requires_cedis').notNullable().defaultTo(false);
      t.text('cedis_note');

      // Ciclo de la parada.
      t.string('status', 20).notNullable().defaultTo('pendiente');
      t.date('shipment_date').notNullable();
      t.timestamp('dispatched_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('dispatched_by');
      t.timestamp('delivered_at');
      t.timestamp('attempted_at');

      // Evidencia de entrega (POD).
      t.string('delivered_to', 200);
      t.text('proof_photo_url');
      t.text('signature_url');
      t.boolean('whatsapp_confirmed').notNullable().defaultTo(false);
      t.decimal('gps_lat', 10, 7);
      t.decimal('gps_lng', 10, 7);

      // Incidencia (§10 SOP).
      t.string('incident_type', 30);
      t.text('incident_notes');

      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at');
      t.uuid('deleted_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_home_del_tenant_id_composite' });
      t.check(
        `?? IN ('pendiente', 'entregado', 'no_entregado', 'rechazado')`,
        ['status'],
        'commercial_home_del_status_valid',
      );

      t.index(['tenant_id', 'rider_user_id', 'status'], 'idx_commercial_home_del_rider_status');
      t.index(['tenant_id', 'status'], 'idx_commercial_home_del_status');
      t.index(['tenant_id', 'shipment_date'], 'idx_commercial_home_del_date');
    });

    // Anti doble-despacho: 1 parada viva por folio Kepler.
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_home_del_one_per_kepler
        ON commercial.home_deliveries (tenant_id, kepler_warehouse_code, kepler_serie, kepler_folio)
        WHERE deleted_at IS NULL AND kepler_folio IS NOT NULL
    `);
    // Anti doble-despacho: 1 parada viva por pedido de intake.
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_home_del_one_per_order
        ON commercial.home_deliveries (tenant_id, order_id)
        WHERE deleted_at IS NULL AND order_id IS NOT NULL
    `);

    await knex.raw(`
      ALTER TABLE commercial.home_deliveries
        ADD CONSTRAINT fk_commercial_home_del_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.home_deliveries
        ADD CONSTRAINT fk_commercial_home_del_rider
        FOREIGN KEY (tenant_id, rider_user_id)
        REFERENCES identity.users(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE commercial.home_deliveries
        ADD CONSTRAINT fk_commercial_home_del_order
        FOREIGN KEY (tenant_id, order_id)
        REFERENCES commercial.orders(tenant_id, id) ON DELETE SET NULL
    `);
  }

  // ── RLS + grants ─────────────────────────────────────────────────────────
  for (const t of ['commercial.home_deliveries', 'commercial.home_delivery_sequences']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.home_deliveries, commercial.home_delivery_sequences TO app_runtime',
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('home_deliveries');
  await knex.schema.withSchema('commercial').dropTableIfExists('home_delivery_sequences');
};
