/**
 * Migración: shipments + delivery_guides + guide_recipients.
 *
 * Fase J.0.3a — dominio operativo del viaje. Cada shipment es un viaje físico
 * de una unidad. Cada shipment tiene 0..N delivery_guides (cuando se reparte
 * en múltiples paradas). Cada guide tiene 0..N destinatarios.
 *
 * Tablas:
 *   1. logistics.shipments          — embarques (origen: logistica_embarques)
 *   2. logistics.delivery_guides    — guías (origen: logistica_guias)
 *   3. logistics.guide_recipients   — destinatarios (origen: logistica_guias_destinatarios)
 *
 * Hookeo con commercial: shipments.order_id (opcional, composite FK) apunta
 * a un commercial.orders. Al confirmar pedido se puede crear draft de shipment.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // logistics.shipments — embarques
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('shipments', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('folio', 30).notNullable(); // EMB-YYYY-NNNNN
    table.date('shipment_date').notNullable();
    table.uuid('vehicle_id'); // FK composite via tenant_id, vehicle_id
    table.uuid('route_id');    // FK composite via tenant_id, route_id
    table.uuid('order_id');    // FK opcional a commercial.orders (link entre venta y entrega)
    table.string('origin', 200);
    table.string('destination', 200);
    table.integer('actual_km');
    table.decimal('freight_revenue', 14, 2).notNullable().defaultTo(0); // flete cobrado
    table.decimal('cargo_value', 14, 2).notNullable().defaultTo(0);     // valor de la mercancía
    table.integer('boxes_count').notNullable().defaultTo(0);
    table.decimal('total_weight_kg', 12, 2).notNullable().defaultTo(0);
    table.string('type', 30).notNullable().defaultTo('entrega'); // entrega | traspaso | recoleccion
    table.string('status', 30).notNullable().defaultTo('programado'); // programado | en_ruta | entregado | cerrado | cancelado
    table.timestamp('departure_at');
    table.timestamp('arrival_at');
    table.timestamp('closed_at');
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'folio'], { indexName: 'logistics_shipments_tenant_folio_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_shipments_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_shipments_tenant');
    table.index(['tenant_id', 'status'], 'idx_logistics_shipments_tenant_status');
    table.index(['tenant_id', 'shipment_date'], 'idx_logistics_shipments_tenant_date');
    table.index(['tenant_id', 'vehicle_id'], 'idx_logistics_shipments_tenant_vehicle');
    table.index(['tenant_id', 'order_id'], 'idx_logistics_shipments_tenant_order');
  });

  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT fk_logistics_shipments_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT fk_logistics_shipments_vehicle
      FOREIGN KEY (tenant_id, vehicle_id)
      REFERENCES logistics.vehicles(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT fk_logistics_shipments_route
      FOREIGN KEY (tenant_id, route_id)
      REFERENCES logistics.routes(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT fk_logistics_shipments_order
      FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT logistics_shipments_status_check
      CHECK (status IN ('programado', 'en_ruta', 'entregado', 'cerrado', 'cancelado'))
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT logistics_shipments_type_check
      CHECK (type IN ('entrega', 'traspaso', 'recoleccion'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.delivery_guides — guías de entrega
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('delivery_guides', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.string('number', 50).notNullable(); // GUIA-YYYY-NNNNN
    table.uuid('shipment_id').notNullable();
    table.string('type', 30).notNullable().defaultTo('entrega');
    table.string('status', 30).notNullable().defaultTo('pendiente'); // pendiente | en_ruta | entregada | cancelada
    table.uuid('driver_id');
    table.decimal('driver_commission', 12, 2).notNullable().defaultTo(0);
    table.uuid('helper1_id');
    table.decimal('helper1_commission', 12, 2).notNullable().defaultTo(0);
    table.uuid('helper2_id');
    table.decimal('helper2_commission', 12, 2).notNullable().defaultTo(0);
    table.time('departure_time');
    table.time('arrival_time');
    table.boolean('overnight').notNullable().defaultTo(false); // si el chofer duerme fuera
    table.decimal('per_diem_total', 12, 2).notNullable().defaultTo(0); // viáticos totales
    table.jsonb('per_diem_breakdown'); // desglose: { driver: {breakfast, lunch, dinner}, helper1: {...} }
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'number'], { indexName: 'logistics_delivery_guides_tenant_number_unique' });
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_delivery_guides_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_delivery_guides_tenant');
    table.index(['tenant_id', 'shipment_id'], 'idx_logistics_delivery_guides_tenant_shipment');
    table.index(['tenant_id', 'status'], 'idx_logistics_delivery_guides_tenant_status');
    table.index(['tenant_id', 'driver_id'], 'idx_logistics_delivery_guides_tenant_driver');
  });

  await knex.raw(`
    ALTER TABLE logistics.delivery_guides
      ADD CONSTRAINT fk_logistics_delivery_guides_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.delivery_guides
      ADD CONSTRAINT fk_logistics_delivery_guides_shipment
      FOREIGN KEY (tenant_id, shipment_id)
      REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE logistics.delivery_guides
      ADD CONSTRAINT fk_logistics_delivery_guides_driver
      FOREIGN KEY (tenant_id, driver_id)
      REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.delivery_guides
      ADD CONSTRAINT fk_logistics_delivery_guides_helper1
      FOREIGN KEY (tenant_id, helper1_id)
      REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.delivery_guides
      ADD CONSTRAINT fk_logistics_delivery_guides_helper2
      FOREIGN KEY (tenant_id, helper2_id)
      REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.delivery_guides
      ADD CONSTRAINT logistics_delivery_guides_status_check
      CHECK (status IN ('pendiente', 'en_ruta', 'entregada', 'cancelada'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // logistics.guide_recipients — destinatarios de la guía
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('logistics').createTable('guide_recipients', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('guide_id').notNullable();
    table.uuid('customer_id'); // opcional: si el destinatario es un commercial.customers
    table.string('customer_name', 200).notNullable();
    table.text('address');
    table.integer('boxes_count').notNullable().defaultTo(0);
    table.decimal('weight_kg', 12, 2).notNullable().defaultTo(0);
    table.decimal('value', 14, 2).notNullable().defaultTo(0);
    table.string('status', 30).notNullable().defaultTo('pendiente'); // pendiente | entregado | no_entregado | rechazado
    table.timestamp('delivered_at');
    table.string('delivered_to', 200); // nombre de quien recibió
    table.string('proof_photo_url', 500); // URL foto firma/recepción (Cloudinary)
    table.decimal('gps_lat', 10, 7); // captura GPS al marcar entregado
    table.decimal('gps_lng', 10, 7);
    table.text('notes');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'logistics_guide_recipients_tenant_id_composite' });

    table.index('tenant_id', 'idx_logistics_guide_recipients_tenant');
    table.index(['tenant_id', 'guide_id'], 'idx_logistics_guide_recipients_tenant_guide');
    table.index(['tenant_id', 'status'], 'idx_logistics_guide_recipients_tenant_status');
  });

  await knex.raw(`
    ALTER TABLE logistics.guide_recipients
      ADD CONSTRAINT fk_logistics_guide_recipients_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE logistics.guide_recipients
      ADD CONSTRAINT fk_logistics_guide_recipients_guide
      FOREIGN KEY (tenant_id, guide_id)
      REFERENCES logistics.delivery_guides(tenant_id, id) ON DELETE CASCADE
  `);
  await knex.raw(`
    ALTER TABLE logistics.guide_recipients
      ADD CONSTRAINT fk_logistics_guide_recipients_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE SET NULL
  `);
  await knex.raw(`
    ALTER TABLE logistics.guide_recipients
      ADD CONSTRAINT logistics_guide_recipients_status_check
      CHECK (status IN ('pendiente', 'entregado', 'no_entregado', 'rechazado'))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // RLS forzado + grants
  // ─────────────────────────────────────────────────────────────────────────
  const tables = [
    'logistics.shipments',
    'logistics.delivery_guides',
    'logistics.guide_recipients',
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
  await knex.raw(`COMMENT ON COLUMN logistics.shipments.order_id IS 'Link opcional a commercial.orders. Permite vincular embarque con pedido que origina la entrega.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.delivery_guides.per_diem_breakdown IS 'JSONB con desglose de viáticos por persona/comida. Shape libre, validar en service.'`);
  await knex.raw(`COMMENT ON COLUMN logistics.guide_recipients.proof_photo_url IS 'URL Cloudinary de foto firma/recepción. Capturada por app móvil del chofer.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('guide_recipients');
  await knex.schema.withSchema('logistics').dropTableIfExists('delivery_guides');
  await knex.schema.withSchema('logistics').dropTableIfExists('shipments');
};
