/**
 * Fase WMS-REC (Pieza 2 — Auditor de recepción por caducidad, ADR-044).
 *
 * `commercial.receiving_lot_captures` — cada captura de lote/caducidad en la
 * RECEPCIÓN, con su evidencia fotográfica, el resultado del OCR, y el VEREDICTO
 * del motor de reglas. Append-only (inmutabilidad, Frank §18): una corrección es
 * una fila nueva, no un UPDATE del dato capturado.
 *
 * Una NO CONFORMIDAD de recepción NO es otra tabla: es una fila con
 * verdict='red' (y status pending_authorization → authorized|rejected). El
 * scorecard de proveedor = agregado por supplier_code donde verdict != 'green'.
 *
 * verdict: green (acepta y escribe stock) | yellow (advierte, escribe stock) |
 *          red (bloquea; requiere authorize de un supervisor o reject).
 * status:  accepted | pending_authorization | authorized | rejected.
 *
 * La foto se guarda en object storage (key en photo_key; se firma al leer).
 * Aditivo e idempotente. RLS forzado + grant app_runtime. FKs compuestas.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('receiving_lot_captures')) return;

  await knex.schema.withSchema('commercial').createTable('receiving_lot_captures', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.uuid('product_id').notNullable();
    t.string('supplier_code', 60); // proveedor que entrega (para el scorecard)
    t.string('source_ref', 120); // folio de la orden de entrada / vale, si aplica
    t.decimal('quantity', 14, 3).notNullable();

    // Evidencia + OCR (el OCR PROPONE; el operador confirma)
    t.text('photo_key'); // key en object storage (se firma al leer)
    t.string('ocr_lot', 60);
    t.date('ocr_expiry');
    t.decimal('ocr_confidence', 5, 4); // 0..1

    // Realidad física confirmada por el operador
    t.string('confirmed_lot', 60).notNullable().defaultTo('NA');
    t.date('confirmed_expiry');

    // Veredicto del motor (determinista)
    t.date('existing_min_expiry'); // caducidad más próxima ya en stock al momento de recibir
    t.integer('days_of_life'); // confirmed_expiry - hoy
    t.string('verdict', 10).notNullable(); // green | yellow | red
    t.string('rule_broken', 40); // min_shelf_life | older_than_existing | older_than_existing_allowed | near_min_shelf_life
    t.string('status', 24).notNullable().defaultTo('accepted'); // accepted | pending_authorization | authorized | rejected

    // Resolución del rojo + huella al stock
    t.uuid('stock_movement_id'); // movimiento 'in' generado al aceptar (green/yellow/authorized)
    t.uuid('authorized_by');
    t.timestamp('authorized_at');
    t.text('resolution_notes');

    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');

    t.primary('id');
    t.unique(['tenant_id', 'id'], { indexName: 'commercial_recv_lot_captures_tenant_id_composite' });
    t.check("?? in ('green','yellow','red')", ['verdict'], 'commercial_recv_lot_captures_verdict_chk');
    t.check("?? in ('accepted','pending_authorization','authorized','rejected')", ['status'], 'commercial_recv_lot_captures_status_chk');
    t.check('?? > 0', ['quantity'], 'commercial_recv_lot_captures_qty_pos');

    t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_recv_lot_captures_whp');
    t.index(['tenant_id', 'supplier_code'], 'idx_commercial_recv_lot_captures_supplier');
    t.index(['tenant_id', 'verdict', 'status'], 'idx_commercial_recv_lot_captures_verdict');
    t.index(['tenant_id', 'created_at'], 'idx_commercial_recv_lot_captures_created');
  });

  await knex.raw(`
    ALTER TABLE commercial.receiving_lot_captures
      ADD CONSTRAINT fk_commercial_recv_lot_captures_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.receiving_lot_captures
      ADD CONSTRAINT fk_commercial_recv_lot_captures_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.receiving_lot_captures
      ADD CONSTRAINT fk_commercial_recv_lot_captures_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.receiving_lot_captures ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.receiving_lot_captures FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.receiving_lot_captures`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.receiving_lot_captures
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.receiving_lot_captures TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.receiving_lot_captures IS 'Auditor de recepción por caducidad (ADR-044). Captura lote+caducidad con foto+OCR y VEREDICTO 🟢🟡🔴 vs inventario existente. NC = fila verdict=red. Append-only.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('receiving_lot_captures');
};
