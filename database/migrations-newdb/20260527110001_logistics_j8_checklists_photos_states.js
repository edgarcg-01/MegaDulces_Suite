/**
 * Migración J.8.1 — Migración desde repo Megadulces-Logistica.
 *
 * Aporta los gaps del repo origen que J.0-J.7 no había traído:
 *   1. 3 estados extra en logistics.shipments: checklist_salida, checklist_llegada, costos_pendientes
 *   2. Tabla logistics.shipment_checklists (tipo salida/llegada + items JSONB + respuestas + signed_by)
 *   3. Tabla logistics.shipment_photos (general purpose: cloudinary + GPS + descripcion)
 *
 * Hook con commercial.orders preservado: cerrado → fulfillInTransaction.
 *
 * Origen (referencia):
 *   - _imported/logistica/database/migrations/20260501000001_add_checklists_and_fotos.js
 *   - _imported/logistica/database/migrations/2026050200030_0_add_respuestas_to_checklists.js
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. Actualizar CHECK constraint de logistics.shipments.status
  //    Agregar: checklist_salida, checklist_llegada, costos_pendientes
  // ─────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE logistics.shipments
      DROP CONSTRAINT IF EXISTS logistics_shipments_status_check
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT logistics_shipments_status_check
      CHECK (status IN (
        'programado',
        'checklist_salida',
        'en_ruta',
        'entregado',
        'checklist_llegada',
        'costos_pendientes',
        'cerrado',
        'cancelado'
      ))
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // 2. logistics.shipment_checklists — checklists de inspección
  //    Tipos: salida (pre-departure) | llegada (post-arrival)
  //    items: JSONB con array [{ id, label, required, observaciones? }]
  //    respuestas: JSONB con map { item_id: { ok: boolean, comment?: string } }
  // ─────────────────────────────────────────────────────────────────────────
  const hasChecklists = await knex.schema.withSchema('logistics').hasTable('shipment_checklists');
  if (!hasChecklists) {
    await knex.schema.withSchema('logistics').createTable('shipment_checklists', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('shipment_id').notNullable();
      table.string('type', 20).notNullable(); // salida | llegada
      table.string('status', 20).notNullable().defaultTo('pendiente'); // pendiente | completado
      table.jsonb('items').notNullable(); // template de items [{id, label, required, ...}]
      table.jsonb('responses'); // respuestas {[item_id]: {ok, comment, photo_url?}}
      table.uuid('driver_id'); // chofer que firma (opcional, FK a drivers)
      table.uuid('signed_by_user_id'); // usuario que firma (chofer puede usar app)
      table.timestamp('completed_at');
      table.text('notes');
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('created_by');
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      table.uuid('updated_by');

      table.primary('id');
      table.unique(['tenant_id', 'shipment_id', 'type'], {
        indexName: 'logistics_shipment_checklists_tenant_shipment_type_unique',
      });
      table.unique(['tenant_id', 'id'], {
        indexName: 'logistics_shipment_checklists_tenant_id_composite',
      });

      table.index('tenant_id', 'idx_logistics_shipment_checklists_tenant');
      table.index(['tenant_id', 'shipment_id'], 'idx_logistics_shipment_checklists_tenant_shipment');
      table.index(['tenant_id', 'status'], 'idx_logistics_shipment_checklists_tenant_status');
    });

    await knex.raw(`
      ALTER TABLE logistics.shipment_checklists
        ADD CONSTRAINT fk_logistics_shipment_checklists_tenant
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_checklists
        ADD CONSTRAINT fk_logistics_shipment_checklists_shipment
        FOREIGN KEY (tenant_id, shipment_id)
        REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_checklists
        ADD CONSTRAINT fk_logistics_shipment_checklists_driver
        FOREIGN KEY (tenant_id, driver_id)
        REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_checklists
        ADD CONSTRAINT fk_logistics_shipment_checklists_signed_by
        FOREIGN KEY (tenant_id, signed_by_user_id)
        REFERENCES public.users(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_checklists
        ADD CONSTRAINT logistics_shipment_checklists_type_check
        CHECK (type IN ('salida', 'llegada'))
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_checklists
        ADD CONSTRAINT logistics_shipment_checklists_status_check
        CHECK (status IN ('pendiente', 'completado'))
    `);

    await knex.raw('ALTER TABLE logistics.shipment_checklists ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE logistics.shipment_checklists FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      CREATE POLICY tenant_isolation ON logistics.shipment_checklists
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.shipment_checklists TO app_runtime');

    await knex.raw(`COMMENT ON COLUMN logistics.shipment_checklists.items IS 'Template de checklist como JSONB: [{id, label, required, group?, ...}]. Origen: repo logistica.'`);
    await knex.raw(`COMMENT ON COLUMN logistics.shipment_checklists.responses IS 'Respuestas como JSONB: {[item_id]: {ok, comment?, photo_url?}}. Llenado al completar checklist.'`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. logistics.shipment_photos — fotos generales del embarque
  //    Origen: repo logistica.fotos_entrega (extendida con GPS + driver_id)
  //    Diferencia con guide_recipients.proof_photo_url: ese es por destinatario.
  //    Esta tabla es por embarque y categorizada (loading/transit/delivery/incident/other).
  // ─────────────────────────────────────────────────────────────────────────
  const hasPhotos = await knex.schema.withSchema('logistics').hasTable('shipment_photos');
  if (!hasPhotos) {
    await knex.schema.withSchema('logistics').createTable('shipment_photos', (table) => {
      table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('tenant_id').notNullable();
      table.uuid('shipment_id').notNullable();
      table.uuid('guide_id'); // opcional: si está asociada a una guía específica
      table.uuid('driver_id'); // opcional: chofer que la subió
      table.uuid('uploaded_by_user_id'); // usuario que hizo el upload
      table.string('category', 30).notNullable().defaultTo('other');
      // categories: loading | transit | delivery | incident | checklist | other
      table.string('url', 500).notNullable(); // URL Cloudinary
      table.string('cloudinary_public_id', 300); // para poder borrar de Cloudinary
      table.text('description');
      table.decimal('gps_lat', 10, 7); // captura GPS al momento de upload
      table.decimal('gps_lng', 10, 7);
      table.timestamp('captured_at'); // timestamp del device del chofer
      table.timestamp('uploaded_at').notNullable().defaultTo(knex.fn.now());
      table.timestamp('deleted_at');
      table.uuid('deleted_by');

      table.primary('id');
      table.unique(['tenant_id', 'id'], {
        indexName: 'logistics_shipment_photos_tenant_id_composite',
      });

      table.index('tenant_id', 'idx_logistics_shipment_photos_tenant');
      table.index(['tenant_id', 'shipment_id'], 'idx_logistics_shipment_photos_tenant_shipment');
      table.index(['tenant_id', 'guide_id'], 'idx_logistics_shipment_photos_tenant_guide');
      table.index(['tenant_id', 'category'], 'idx_logistics_shipment_photos_tenant_category');
    });

    await knex.raw(`
      ALTER TABLE logistics.shipment_photos
        ADD CONSTRAINT fk_logistics_shipment_photos_tenant
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_photos
        ADD CONSTRAINT fk_logistics_shipment_photos_shipment
        FOREIGN KEY (tenant_id, shipment_id)
        REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_photos
        ADD CONSTRAINT fk_logistics_shipment_photos_guide
        FOREIGN KEY (tenant_id, guide_id)
        REFERENCES logistics.delivery_guides(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_photos
        ADD CONSTRAINT fk_logistics_shipment_photos_driver
        FOREIGN KEY (tenant_id, driver_id)
        REFERENCES logistics.drivers(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_photos
        ADD CONSTRAINT fk_logistics_shipment_photos_uploaded_by
        FOREIGN KEY (tenant_id, uploaded_by_user_id)
        REFERENCES public.users(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      ALTER TABLE logistics.shipment_photos
        ADD CONSTRAINT logistics_shipment_photos_category_check
        CHECK (category IN ('loading', 'transit', 'delivery', 'incident', 'checklist', 'other'))
    `);

    await knex.raw('ALTER TABLE logistics.shipment_photos ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE logistics.shipment_photos FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      CREATE POLICY tenant_isolation ON logistics.shipment_photos
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.shipment_photos TO app_runtime');

    await knex.raw(`COMMENT ON COLUMN logistics.shipment_photos.cloudinary_public_id IS 'Cloudinary public_id para poder borrar el asset al soft-delete de la foto.'`);
    await knex.raw(`COMMENT ON COLUMN logistics.shipment_photos.captured_at IS 'Timestamp del device del chofer (puede diferir de uploaded_at si subió offline tarde).'`);
  }
};

exports.down = async function (knex) {
  // Revertir CHECK constraint a 5 estados originales
  await knex.raw(`
    ALTER TABLE logistics.shipments
      DROP CONSTRAINT IF EXISTS logistics_shipments_status_check
  `);
  await knex.raw(`
    ALTER TABLE logistics.shipments
      ADD CONSTRAINT logistics_shipments_status_check
      CHECK (status IN ('programado', 'en_ruta', 'entregado', 'cerrado', 'cancelado'))
  `);

  await knex.schema.withSchema('logistics').dropTableIfExists('shipment_photos');
  await knex.schema.withSchema('logistics').dropTableIfExists('shipment_checklists');
};
