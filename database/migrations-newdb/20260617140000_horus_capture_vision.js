/**
 * Horus — H2.2: capa de VISIÓN. commercial.capture_vision.
 *
 * 1 row por foto de exhibición analizada por Claude vision. Guarda el veredicto
 * ESTRUCTURADO (qué se ve: anaquel válido, marca propia/competencia, calidad,
 * quiebre de stock, calidad de foto) + el cruce declarado-vs-observado (`mismatch`).
 * El LLM extrae HECHOS; el motor (FindingsEngine) decide los hallazgos sobre estos
 * hechos — invariante ADR-016/020 intacto.
 *
 * Incremental: dedup por (tenant_id, photo_key) donde photo_key = fotoPublicId del
 * exhibidor (o capture_id:idx si no hay). Re-escanear salta lo ya analizado.
 *
 * capture_id es uuid SIN FK (daily_captures vive en otro schema/vista). RLS forzado
 * + grant app_runtime; acceso runtime vía KNEX_CONNECTION + tenant explícito.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('capture_vision');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('capture_vision', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('capture_id').notNullable();
    t.string('photo_key', 200).notNullable();
    t.integer('exhibition_idx');
    t.text('foto_url');
    t.string('foto_public_id', 255);
    t.boolean('declared_own'); // perteneceMegaDulces declarado en la captura

    // Veredicto observado por Claude vision:
    t.boolean('is_shelf');
    t.boolean('own_brand_visible');
    t.boolean('competitor_visible');
    t.decimal('shelf_quality', 4, 3); // 0..1
    t.boolean('out_of_stock');
    t.string('photo_quality', 12); // good | blurry | dark | unusable
    t.boolean('mismatch'); // declarado propio pero la foto solo muestra competencia (gating duro)

    t.jsonb('verdict').notNullable().defaultTo('{}'); // crudo (notes + lo provisto por el modelo)
    t.string('model', 60);
    t.string('status', 12).notNullable().defaultTo('analyzed'); // analyzed | error
    t.text('error');
    t.timestamp('analyzed_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.unique(['tenant_id', 'photo_key'], { indexName: 'uq_capture_vision_photo' });
    t.index(['tenant_id', 'capture_id'], 'idx_capture_vision_capture');
    t.index(['tenant_id', 'analyzed_at'], 'idx_capture_vision_analyzed');
  });

  await knex.raw(`
    ALTER TABLE commercial.capture_vision
      ADD CONSTRAINT chk_capture_vision_status CHECK (status IN ('analyzed', 'error'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.capture_vision
      ADD CONSTRAINT fk_capture_vision_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.capture_vision ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.capture_vision FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.capture_vision
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.capture_vision TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.capture_vision IS 'Horus H2.2: veredicto estructurado de Claude vision sobre cada foto de exhibición (share observado, planograma, stockout, foto válida + cruce declarado-vs-observado). El LLM extrae hechos; el motor decide hallazgos (ADR-016/020).'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('capture_vision');
};
