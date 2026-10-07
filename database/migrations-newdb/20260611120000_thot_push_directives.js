/**
 * Thot T.2 — Empuje dirigido (ADR-018 §2.6). El negocio decide QUÉ empujar y el
 * motor lo amplifica: score = demanda · (1 + boost_estrategia).
 *
 * intelligence.push_directives: una directriz = "empujá esto, por esta razón, con
 * este boost, durante esta vigencia (y quizá financiado por este sponsor)".
 *   - target_kind ∈ brand|product|category  → a qué aplica.
 *   - directive_type ∈ focus_brand|manual_product|manual_category (manual, T.2)
 *       + new_launch|overstock_clear|promo (auto, reservados para T.2.1).
 *   - boost: cuánto sube (0..n; clamp en el score).
 *   - reason: lo que ve el vendedor ("Marca del mes"). sponsor: quién financia.
 *
 * tenant_id + RLS forzado + grants app_runtime. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('intelligence').hasTable('push_directives');
  if (exists) return;

  await knex.schema.withSchema('intelligence').createTable('push_directives', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.string('directive_type', 20).notNullable();
    t.string('target_kind', 10).notNullable(); // brand | product | category
    t.uuid('target_id').notNullable();
    t.decimal('boost', 6, 3).notNullable().defaultTo(0.5);
    t.string('reason', 80).notNullable();
    t.string('sponsor', 80);
    t.date('valid_from');
    t.date('valid_to');
    t.boolean('active').notNullable().defaultTo(true);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.uuid('created_by');
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('deleted_at', { useTz: true });
    t.primary('id');
    t.index(['tenant_id', 'active', 'target_kind'], 'idx_directives_lookup');
  });

  await knex.raw(`
    ALTER TABLE intelligence.push_directives
      ADD CONSTRAINT chk_directive_type CHECK (directive_type IN
        ('focus_brand','manual_product','manual_category','new_launch','overstock_clear','promo')),
      ADD CONSTRAINT chk_target_kind CHECK (target_kind IN ('brand','product','category')),
      ADD CONSTRAINT chk_boost CHECK (boost >= 0 AND boost <= 5)
  `);
  await knex.raw(`ALTER TABLE intelligence.push_directives ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE intelligence.push_directives FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON intelligence.push_directives
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON intelligence.push_directives TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('intelligence').dropTableIfExists('push_directives');
};
