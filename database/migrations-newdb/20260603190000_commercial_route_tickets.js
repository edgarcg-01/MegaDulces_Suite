/**
 * Migración: commercial.route_tickets — "Cierre de ruta".
 *
 * Port de la tabla `movimientos` de Automation_RD (single-tenant) al core
 * comercial multi-tenant. 1 fila por ticket que el vendedor de ruta sube al
 * cierre del día: corte de venta, carga, o combustible. Documentos de
 * control/reconciliación a nivel día/ruta (totales, no desglose por producto).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.schema.withSchema('commercial').createTable('route_tickets', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('vendor_user_id').notNullable(); // chofer/vendedor que sube el ticket

    table.string('ticket_type', 20).notNullable(); // 'venta' | 'carga' | 'combustible'
    table.string('route_code', 10).notNullable(); // ex `ruta` (ej. "12" de RD12)
    table.date('ticket_date').notNullable(); // ex `fecha`

    table.decimal('total', 12, 2);
    table.string('corte_number', 20); // ex `num_corte` — solo venta (corte = término de dominio)
    table.string('reference', 50); // ex `referencia` — solo combustible (folio)
    table.decimal('liters', 10, 2); // ex `litros` — solo combustible

    table.string('cloudinary_public_id', 255);
    table.text('photo_url');
    table.text('photo_preview_url');
    table.text('ocr_text'); // markdown/raw devuelto por el OCR
    table.jsonb('ocr_json'); // respuesta estructurada completa del extractor

    table.boolean('reviewed').notNullable().defaultTo(true); // revisado por el vendedor en UI antes de guardar

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('created_by');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.uuid('updated_by');
    table.timestamp('deleted_at');
    table.uuid('deleted_by');

    table.primary('id');
    table.unique(['tenant_id', 'id'], { indexName: 'commercial_route_tickets_tenant_id_composite' });

    table.index(['tenant_id', 'vendor_user_id'], 'idx_commercial_route_tickets_vendor');
    table.index(['tenant_id', 'ticket_date'], 'idx_commercial_route_tickets_date');
    table.index(['tenant_id', 'ticket_type'], 'idx_commercial_route_tickets_type');
  });

  // CHECK del tipo
  await knex.raw(`
    ALTER TABLE commercial.route_tickets
      ADD CONSTRAINT chk_route_tickets_type
      CHECK (ticket_type IN ('venta', 'carga', 'combustible'))
  `);

  // NOTA: public.tenants y public.users son VISTAS en esta DB (relkind 'v'),
  // no tablas — Postgres no permite FK contra vistas. La integridad de tenant
  // la garantiza RLS (tenant_id = current_tenant_id()); vendor_user_id se valida
  // en la app (viene del JWT del request autenticado). Por eso NO se crean las
  // FK fk_route_tickets_tenant / fk_route_tickets_vendor.

  // Unique parciales anti-duplicado (replican uniq_movimientos_* de Automation_RD):
  // permiten múltiples NULL (carga no tiene corte ni reference).
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_route_tickets_tenant_corte
      ON commercial.route_tickets (tenant_id, corte_number)
      WHERE corte_number IS NOT NULL AND deleted_at IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX uniq_route_tickets_tenant_reference
      ON commercial.route_tickets (tenant_id, reference)
      WHERE reference IS NOT NULL AND deleted_at IS NULL
  `);

  // RLS forzado + grants
  await knex.raw(`ALTER TABLE commercial.route_tickets ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.route_tickets FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.route_tickets
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.route_tickets TO app_runtime');

  await knex.raw(`COMMENT ON TABLE commercial.route_tickets IS 'Cierre de ruta: tickets diarios del vendedor (venta/carga/combustible) para control/reconciliación. Port de movimientos de Automation_RD.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.route_tickets.corte_number IS 'Número de corte (cash-close) del ticket de venta. Único por tenant entre tickets vivos.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('route_tickets');
};
