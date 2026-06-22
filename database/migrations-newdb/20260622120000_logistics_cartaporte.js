/**
 * J12.0 — Carta Porte 3.1: schema de soporte.
 *
 * Agrega lo que el gap analysis (2026-06-22) detectó faltante para timbrar el
 * complemento Carta Porte vía PAC, sobre el dato que ya tenemos:
 *
 *   1. logistics.carrier_fiscal_profile — datos fiscales del emisor/transportista
 *      (RFC, régimen, CP expedición, permiso SCT). 1 fila por tenant.
 *   2. logistics.vehicles ALTER — config vehicular SAT + seguros.
 *   3. catalog.products ALTER — ClaveProdServ + ClaveUnidad SAT + material peligroso.
 *   4. commercial.warehouses.fiscal_address jsonb — domicilio estructurado de origen.
 *   5. logistics.guide_recipients.fiscal_address jsonb — domicilio estructurado de destino.
 *   6. logistics.cartaporte_documents — documento timbrado (XML/PDF, UUID, estado, PAC).
 *
 * Patrón estándar logistics.*: tenant_id NOT NULL, composite unique (tenant_id, id),
 * RLS forzado, grants app_runtime. Idempotente (hasTable/hasColumn).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. logistics.carrier_fiscal_profile — emisor (transportista)
  // ──────────────────────────────────────────────────────────────────────────
  const hasProfile = await knex.schema.withSchema('logistics').hasTable('carrier_fiscal_profile');
  if (!hasProfile) {
    await knex.schema.withSchema('logistics').createTable('carrier_fiscal_profile', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('rfc', 13).notNullable();
      t.string('legal_name', 250).notNullable();         // razón social
      t.string('regimen_fiscal', 5).notNullable();        // c_RegimenFiscal SAT
      t.string('cp_expedicion', 5).notNullable();         // CP lugar de expedición
      t.string('sct_permit_type', 10);                    // PermSCT (TPAF01...)
      t.string('sct_permit_number', 50);                  // NumPermisoSCT
      t.jsonb('fiscal_address');                          // domicilio fiscal completo
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id'], { indexName: 'logistics_carrier_fiscal_profile_tenant_unique' });
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_carrier_fiscal_profile_tenant_id_composite' });
    });
    await knex.raw(`ALTER TABLE logistics.carrier_fiscal_profile ADD CONSTRAINT fk_logistics_carrier_fiscal_profile_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.carrier_fiscal_profile ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.carrier_fiscal_profile FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.carrier_fiscal_profile USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.carrier_fiscal_profile TO app_runtime`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. logistics.vehicles — datos fiscales del vehículo
  // ──────────────────────────────────────────────────────────────────────────
  const vCol = (c) => knex.schema.withSchema('logistics').hasColumn('vehicles', c);
  if (!(await vCol('sat_config_vehicular'))) await knex.raw(`ALTER TABLE logistics.vehicles ADD COLUMN sat_config_vehicular VARCHAR(10)`);
  if (!(await vCol('gross_weight_kg')))      await knex.raw(`ALTER TABLE logistics.vehicles ADD COLUMN gross_weight_kg NUMERIC(10,2)`);
  if (!(await vCol('insurance_carrier')))    await knex.raw(`ALTER TABLE logistics.vehicles ADD COLUMN insurance_carrier VARCHAR(200)`);
  if (!(await vCol('insurance_policy')))     await knex.raw(`ALTER TABLE logistics.vehicles ADD COLUMN insurance_policy VARCHAR(50)`);

  // ──────────────────────────────────────────────────────────────────────────
  // 3. catalog.products — claves SAT (ClaveProdServ + ClaveUnidad)
  // ──────────────────────────────────────────────────────────────────────────
  const pCol = (c) => knex.schema.withSchema('catalog').hasColumn('products', c);
  if (!(await pCol('sat_clave_prod_serv'))) await knex.raw(`ALTER TABLE catalog.products ADD COLUMN sat_clave_prod_serv VARCHAR(8)`);
  if (!(await pCol('sat_clave_unidad')))    await knex.raw(`ALTER TABLE catalog.products ADD COLUMN sat_clave_unidad VARCHAR(3)`);
  if (!(await pCol('sat_material_peligroso'))) await knex.raw(`ALTER TABLE catalog.products ADD COLUMN sat_material_peligroso BOOLEAN NOT NULL DEFAULT false`);

  // ──────────────────────────────────────────────────────────────────────────
  // 4. commercial.warehouses.fiscal_address — domicilio estructurado de origen
  // ──────────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasColumn('warehouses', 'fiscal_address'))) {
    await knex.raw(`ALTER TABLE commercial.warehouses ADD COLUMN fiscal_address JSONB`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 5. logistics.guide_recipients.fiscal_address — domicilio estructurado de destino
  // ──────────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('logistics').hasColumn('guide_recipients', 'fiscal_address'))) {
    await knex.raw(`ALTER TABLE logistics.guide_recipients ADD COLUMN fiscal_address JSONB`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 6. logistics.cartaporte_documents — documento timbrado
  // ──────────────────────────────────────────────────────────────────────────
  const hasDocs = await knex.schema.withSchema('logistics').hasTable('cartaporte_documents');
  if (!hasDocs) {
    await knex.schema.withSchema('logistics').createTable('cartaporte_documents', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('shipment_id').notNullable();
      t.uuid('guide_id');                                  // null = nivel embarque; set = nivel guía
      t.string('cfdi_type', 10).notNullable().defaultTo('traslado'); // traslado | ingreso
      t.string('status', 20).notNullable().defaultTo('borrador');    // borrador|timbrado|cancelado|error
      t.string('uuid_fiscal', 40);                         // folio fiscal SAT
      t.string('serie', 25);
      t.string('folio', 40);
      t.decimal('total_distance_km', 12, 2);
      t.string('xml_url', 500);
      t.string('pdf_url', 500);
      t.string('cloudinary_public_id', 300);
      t.string('pac_provider', 40);
      t.jsonb('pac_request');
      t.jsonb('pac_response');
      t.text('error_message');
      t.timestamp('stamped_at');
      t.timestamp('cancelled_at');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_cartaporte_documents_tenant_id_composite' });
      t.index('tenant_id', 'idx_logistics_cartaporte_documents_tenant');
      t.index(['tenant_id', 'shipment_id'], 'idx_logistics_cartaporte_documents_tenant_shipment');
      t.index(['tenant_id', 'status'], 'idx_logistics_cartaporte_documents_tenant_status');
    });
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents ADD CONSTRAINT fk_logistics_cp_docs_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents ADD CONSTRAINT fk_logistics_cp_docs_shipment FOREIGN KEY (tenant_id, shipment_id) REFERENCES logistics.shipments(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents ADD CONSTRAINT fk_logistics_cp_docs_guide FOREIGN KEY (tenant_id, guide_id) REFERENCES logistics.delivery_guides(tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents ADD CONSTRAINT logistics_cp_docs_type_check CHECK (cfdi_type IN ('traslado','ingreso'))`);
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents ADD CONSTRAINT logistics_cp_docs_status_check CHECK (status IN ('borrador','timbrado','cancelado','error'))`);
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.cartaporte_documents FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.cartaporte_documents USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.cartaporte_documents TO app_runtime`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('cartaporte_documents');
  await knex.raw(`ALTER TABLE logistics.guide_recipients DROP COLUMN IF EXISTS fiscal_address`);
  await knex.raw(`ALTER TABLE commercial.warehouses DROP COLUMN IF EXISTS fiscal_address`);
  await knex.raw(`ALTER TABLE catalog.products DROP COLUMN IF EXISTS sat_material_peligroso`);
  await knex.raw(`ALTER TABLE catalog.products DROP COLUMN IF EXISTS sat_clave_unidad`);
  await knex.raw(`ALTER TABLE catalog.products DROP COLUMN IF EXISTS sat_clave_prod_serv`);
  await knex.raw(`ALTER TABLE logistics.vehicles DROP COLUMN IF EXISTS insurance_policy`);
  await knex.raw(`ALTER TABLE logistics.vehicles DROP COLUMN IF EXISTS insurance_carrier`);
  await knex.raw(`ALTER TABLE logistics.vehicles DROP COLUMN IF EXISTS gross_weight_kg`);
  await knex.raw(`ALTER TABLE logistics.vehicles DROP COLUMN IF EXISTS sat_config_vehicular`);
  await knex.schema.withSchema('logistics').dropTableIfExists('carrier_fiscal_profile');
};
