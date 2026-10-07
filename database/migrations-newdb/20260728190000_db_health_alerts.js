/**
 * analytics.db_health_alerts — bandeja PERSISTENTE de fallas de datos, visible desde prod.
 *
 * Un `@Cron` (DbHealthScannerService) corre el reporte de db-health (frescura de cada
 * fuente crítica: ventas, stock, catálogo, consolidado, KP_CONCENTRADA…) y ABRE una alerta
 * aquí cuando una fuente pasa a warn/critical, la ACTUALIZA mientras siga fallando, y la
 * RESUELVE cuando vuelve a ok. Anti-spam: UNIQUE parcial (tenant_id, source_key) WHERE
 * resolved_at IS NULL → una sola alerta ABIERTA por fuente; se emite WS solo en las
 * transiciones (abrir / escalar warn→critical / resolver), no en cada ciclo.
 *
 * Patrón analytics.* estándar (RLS forzado + grant app_runtime), bajo volumen.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('analytics').hasTable('db_health_alerts');
  if (!exists) {
    await knex.schema.withSchema('analytics').createTable('db_health_alerts', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.string('source_key', 60).notNullable();   // sales_daily | stock | consolidado | kp_concentrada …
      t.string('source_label', 120);
      t.string('group_key', 12);                   // app | source
      t.string('status', 12).notNullable();        // warn | critical
      t.bigInteger('age_seconds');
      t.timestamp('last_update', { useTz: true }); // último dato conocido de la fuente
      t.text('note');
      t.jsonb('detail');                            // snapshot de la fuente al detectar
      t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('resolved_at', { useTz: true }); // NULL = alerta abierta
      t.timestamp('acknowledged_at', { useTz: true });
      t.uuid('acknowledged_by');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'analytics_db_health_alerts_tenant_id_composite' });
      t.index(['tenant_id', 'resolved_at', 'last_seen_at'], 'idx_db_health_alerts_tenant_open');
    });

    // Una sola alerta ABIERTA por (tenant, fuente).
    await knex.raw(`CREATE UNIQUE INDEX uq_db_health_alerts_open ON analytics.db_health_alerts (tenant_id, source_key) WHERE resolved_at IS NULL`);
    await knex.raw(`ALTER TABLE analytics.db_health_alerts ADD CONSTRAINT fk_db_health_alerts_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE analytics.db_health_alerts ADD CONSTRAINT db_health_alerts_status_valid CHECK (status IN ('warn','critical'))`);
    await knex.raw(`ALTER TABLE analytics.db_health_alerts ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE analytics.db_health_alerts FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON analytics.db_health_alerts USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.db_health_alerts TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('db_health_alerts');
};
