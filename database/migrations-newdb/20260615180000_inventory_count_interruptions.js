/**
 * Fase I.5 — bitácora de interrupciones del contador (integridad del conteo).
 *
 * commercial.inventory_count_interruptions: cada vez que el contador sale de la
 * app (cambia de app, bloquea el celular, apaga la pantalla) durante un folio
 * activo, se registra left_at / returned_at / duración. El supervisor ve la
 * línea de tiempo de interrupciones por contador y decide (auditoría, no
 * bloqueo). No demuestra fraude por sí sola — el control duro sigue siendo el
 * doble conteo + reconciliación.
 *
 * Aditivo e idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('inventory_count_interruptions')) return;

  await knex.schema.withSchema('commercial').createTable('inventory_count_interruptions', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('count_id').notNullable();
    t.uuid('user_id').notNullable();
    t.string('username', 80); // snapshot denormalizado para el timeline del supervisor
    t.timestamp('left_at').notNullable();
    t.timestamp('returned_at');
    t.integer('duration_seconds');
    t.string('source', 16).notNullable().defaultTo('visibility'); // 'visibility' | 'appstate'
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.index(['tenant_id', 'count_id'], 'idx_commercial_inv_interrupt_count');
    t.index(['tenant_id', 'count_id', 'user_id'], 'idx_commercial_inv_interrupt_user');
  });
  await knex.raw(`ALTER TABLE commercial.inventory_count_interruptions ADD CONSTRAINT fk_inv_interrupt_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
  await knex.raw(`ALTER TABLE commercial.inventory_count_interruptions ADD CONSTRAINT fk_inv_interrupt_count FOREIGN KEY (tenant_id, count_id) REFERENCES commercial.inventory_counts(tenant_id, id) ON DELETE CASCADE`);
  await knex.raw(`ALTER TABLE commercial.inventory_count_interruptions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.inventory_count_interruptions FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.inventory_count_interruptions`);
  await knex.raw(`CREATE POLICY tenant_isolation ON commercial.inventory_count_interruptions USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.inventory_count_interruptions TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('inventory_count_interruptions');
};
