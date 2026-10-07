/**
 * Thot (ADR-023) — Autonomía acotada con autoridad GANADA (L3 sobre ADR-016/018).
 *
 * Cambia UNA parte de ADR-016 (humano aprueba todo → el motor puede auto-ejecutar dentro
 * de límites) y CONSERVA la otra (el LLM sigue fuera del camino del dinero: quien
 * auto-decide es el motor determinista, no un modelo de lenguaje).
 *
 * commercial.autonomy_policies: el "dial" por action_type. mode off|dry_run|auto +
 * gates: min_confidence (solo auto si la precisión aprendida L2 ≥ X → autoridad ganada),
 * daily_cap (tope diario), value_cap_mxn (tope de $ por acción). Fila especial
 * action_type='__global__' = kill-switch maestro (si no es 'auto', TODO queda co-piloto).
 *
 * DEFAULT: sin filas = todo OFF (co-piloto). Shippear no cambia comportamiento.
 *
 * commercial_actions += auto_executed (marca lo que Thot ejecutó solo → panel "Thot actuó
 * solo" + conteo del daily_cap). Reversible: push_product crea push_directive (se deshace);
 * el resto sólo escribe nota interna (efecto sensible diferido por ADR-020) → auto es seguro.
 *
 * RLS forzado; runtime vía TenantKnexService.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.withSchema('commercial').hasTable('autonomy_policies');
  if (!hasTable) {
    await knex.schema.withSchema('commercial').createTable('autonomy_policies', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('action_type', 40).notNullable(); // push_product | review_price | ... | __global__
      t.string('mode', 10).notNullable().defaultTo('off'); // off | dry_run | auto
      t.decimal('min_confidence', 4, 3).notNullable().defaultTo(0.8); // solo auto si confianza ≥
      t.integer('daily_cap').notNullable().defaultTo(5);
      t.decimal('value_cap_mxn', 14, 2); // null = sin tope de $
      t.uuid('updated_by');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.primary('id');
      t.unique(['tenant_id', 'action_type'], { indexName: 'uq_autonomy_policies' });
    });
    await knex.raw(`
      ALTER TABLE commercial.autonomy_policies
        ADD CONSTRAINT chk_autonomy_policies_mode CHECK (mode IN ('off', 'dry_run', 'auto'))
    `);
    await knex.raw(`
      ALTER TABLE commercial.autonomy_policies
        ADD CONSTRAINT fk_autonomy_policies_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`ALTER TABLE commercial.autonomy_policies ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.autonomy_policies FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.autonomy_policies
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.autonomy_policies TO app_runtime`);
    await knex.raw(
      `COMMENT ON TABLE commercial.autonomy_policies IS 'Thot ADR-023: dial de autonomía por action_type (off/dry_run/auto + min_confidence/daily_cap/value_cap). __global__ = kill-switch. Default OFF. El motor determinista auto-decide; el LLM sigue fuera del dinero.'`,
    );
  }

  if (!(await knex.schema.withSchema('commercial').hasColumn('commercial_actions', 'auto_executed'))) {
    await knex.schema.withSchema('commercial').alterTable('commercial_actions', (t) => {
      t.boolean('auto_executed').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasColumn('commercial_actions', 'auto_executed')) {
    await knex.schema.withSchema('commercial').alterTable('commercial_actions', (t) => t.dropColumn('auto_executed'));
  }
  await knex.schema.withSchema('commercial').dropTableIfExists('autonomy_policies');
};
