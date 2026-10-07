/**
 * Fase DENUE — Prospección de PdV con INEGI DENUE.
 *
 * commercial.prospect_sources: 1 row por tenant. Config de la cosecha — clases
 *   SCIAN objetivo, área de operación (entidad/municipios), radio default.
 *   Editable por el negocio sin redeploy.
 *
 * commercial.prospect_stores: candidatos descubiertos en DENUE (dato abierto →
 *   se PUEDE almacenar, a diferencia de Mapbox/Google). 1 row por unidad
 *   económica (CLEE en source_ref). El pipeline de dedup los clasifica contra
 *   `stores` + `commercial.customers`: candidate (net-new) | covered (ya es mío)
 *   | dismissed (descartado) | converted (dado de alta).
 *
 * RLS forzado + grants app_runtime (defense-in-depth). El acceso runtime es vía
 * KNEX_CONNECTION (superuser, bypassa RLS) + tenant_id explícito, igual que
 * CommercialMap/Horus — porque el dedup cruza `stores` (search_path legacy).
 *
 * @param { import("knex").Knex } knex
 */
async function hardenRls(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.${table}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  const has = (t) => knex.schema.withSchema('commercial').hasTable(t);

  if (!(await has('prospect_sources'))) {
    await knex.schema.withSchema('commercial').createTable('prospect_sources', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      // Clases SCIAN objetivo. Default: dulcerías + abarrotes + minisúper.
      t.jsonb('scian_codes').notNullable().defaultTo(
        JSON.stringify(['461160', '461110', '462112']),
      );
      t.string('entidad', 2); // código INEGI de entidad ('00' = todas) — opcional
      t.jsonb('municipios'); // array de códigos de municipio en scope (opcional)
      t.integer('default_radius_m').notNullable().defaultTo(1000); // ≤5000 (límite DENUE)
      // Geocerca circular: solo se conservan prospectos a ≤ max_radius_km del centro.
      // Complementa a `entidad` (ej. La Piedad colinda con Guanajuato → el filtro de
      // entidad recorta lo que la geocerca dejaría entrar de estados vecinos).
      t.decimal('center_lat', 9, 6);
      t.decimal('center_lng', 9, 6);
      t.integer('max_radius_km'); // null = sin límite de distancia
      t.boolean('active').notNullable().defaultTo(true);
      t.string('attribution', 120).notNullable().defaultTo('INEGI · DENUE');
      t.timestamp('last_ingested_at');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id'], { indexName: 'uq_prospect_sources_tenant' });
    });
    await knex.raw(`
      ALTER TABLE commercial.prospect_sources
        ADD CONSTRAINT fk_prospect_sources_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await hardenRls(knex, 'prospect_sources');
    await knex.raw(
      `COMMENT ON TABLE commercial.prospect_sources IS 'Fase DENUE: config por tenant de la cosecha de prospectos (SCIAN objetivo, área de operación, radio). Editable por el negocio.'`,
    );
  }

  if (!(await has('prospect_stores'))) {
    await knex.schema.withSchema('commercial').createTable('prospect_stores', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('source', 20).notNullable().defaultTo('denue');
      t.string('source_ref', 64).notNullable(); // CLEE / id DENUE

      t.string('nombre', 300);
      t.string('razon_social', 300);
      t.string('scian', 10);
      t.string('scian_label', 200);
      t.string('estrato', 80); // personal ocupado (rango)
      t.string('tipo', 40); // fijo | semifijo

      t.decimal('lat', 9, 6);
      t.decimal('lng', 9, 6);
      t.string('calle', 200);
      t.string('num_ext', 40);
      t.string('colonia', 160);
      t.string('cp', 10);
      t.string('municipio', 160);
      t.string('entidad', 80);
      t.string('telefono', 40);
      t.string('email', 160);
      t.string('web', 200);

      // Estado + resultado del dedup.
      t.string('status', 20).notNullable().defaultTo('candidate');
      t.uuid('matched_store_id');
      t.uuid('matched_customer_id');
      t.integer('match_distance_m'); // distancia al registro propio matcheado
      t.decimal('match_name_sim', 4, 3); // similitud de nombre 0..1
      t.integer('nearest_customer_m'); // distancia al cliente propio más cercano
      t.decimal('whitespace_score', 5, 2); // prioridad de oportunidad 0..100

      t.jsonb('raw'); // registro DENUE crudo (auditoría / enriquecimiento)
      t.timestamp('discovered_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'source', 'source_ref'], {
        indexName: 'uq_prospect_stores_source_ref',
      });
      t.index(['tenant_id', 'status'], 'idx_prospect_stores_tenant_status');
    });
    await knex.raw(`
      ALTER TABLE commercial.prospect_stores
        ADD CONSTRAINT chk_prospect_stores_status
        CHECK (status IN ('candidate', 'covered', 'dismissed', 'converted'))
    `);
    await knex.raw(`
      ALTER TABLE commercial.prospect_stores
        ADD CONSTRAINT fk_prospect_stores_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await hardenRls(knex, 'prospect_stores');
    await knex.raw(
      `COMMENT ON TABLE commercial.prospect_stores IS 'Fase DENUE: PdV descubiertos en INEGI DENUE (1 row por unidad económica, CLEE en source_ref). status=candidate net-new | covered ya cliente | dismissed | converted. Dato abierto: almacenamiento permitido con atribución.'`,
    );
  }

  // Config inicial del tenant Mega Dulces: Michoacán (entidad 16), geocerca de
  // 100 km alrededor de La Piedad de Cabadas (20.3450, -102.0367). Solo si el
  // tenant ya existe (en DB fresca los tenants se siembran después; la config se
  // crea perezosamente y se ajusta por el endpoint /prospects/config). Idempotente.
  await knex.raw(
    `INSERT INTO commercial.prospect_sources
       (tenant_id, entidad, center_lat, center_lng, max_radius_km, scian_codes)
     SELECT '00000000-0000-0000-0000-00000000d01c', '16', 20.345000, -102.036700, 100,
            '["461160","461110","462112"]'::jsonb
      WHERE EXISTS (SELECT 1 FROM identity.tenants WHERE id = '00000000-0000-0000-0000-00000000d01c')
     ON CONFLICT (tenant_id) DO NOTHING`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('prospect_stores');
  await knex.schema.withSchema('commercial').dropTableIfExists('prospect_sources');
};
