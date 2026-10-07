/**
 * LT.6 — logistics.fleet_alerts: alertas de flota persistidas (server-side).
 *
 * Un `@Cron` scanner detecta condiciones (sin señal 90min–24h, exceso de
 * velocidad) sobre logistics.trackers y abre/cierra alertas aquí. Anti-spam:
 * UNIQUE parcial (tenant_id, tracker_id, kind) WHERE status='open' → una sola
 * alerta abierta por unidad+tipo; el scanner la actualiza o la resuelve.
 *
 * Patrón logistics.* estándar (RLS forzado), bajo volumen.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('fleet_alerts');
  if (!exists) {
    await knex.schema.withSchema('logistics').createTable('fleet_alerts', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('tracker_id').notNullable();
      t.uuid('vehicle_id');
      t.string('kind', 20).notNullable(); // offline | speed
      t.string('severity', 12).notNullable(); // warn | danger
      t.text('message').notNullable();
      t.decimal('value', 10, 2); // min sin señal, o km/h
      t.string('status', 12).notNullable().defaultTo('open'); // open | ack | resolved
      t.timestamp('first_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('acknowledged_at', { useTz: true });
      t.uuid('acknowledged_by');
      t.timestamp('resolved_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'logistics_fleet_alerts_tenant_id_composite' });
      t.index(['tenant_id', 'status', 'last_seen_at'], 'idx_logistics_fleet_alerts_tenant_status');
    });

    // Una sola alerta ABIERTA por (tenant, tracker, kind).
    await knex.raw(`CREATE UNIQUE INDEX uq_logistics_fleet_alerts_open ON logistics.fleet_alerts (tenant_id, tracker_id, kind) WHERE status = 'open'`);
    await knex.raw(`ALTER TABLE logistics.fleet_alerts ADD CONSTRAINT fk_logistics_fleet_alerts_tenant FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
    await knex.raw(`ALTER TABLE logistics.fleet_alerts ADD CONSTRAINT fk_logistics_fleet_alerts_tracker FOREIGN KEY (tenant_id, tracker_id) REFERENCES logistics.trackers(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE logistics.fleet_alerts ADD CONSTRAINT logistics_fleet_alerts_kind_valid CHECK (kind IN ('offline','speed'))`);
    await knex.raw(`ALTER TABLE logistics.fleet_alerts ADD CONSTRAINT logistics_fleet_alerts_status_valid CHECK (status IN ('open','ack','resolved'))`);
    await knex.raw(`ALTER TABLE logistics.fleet_alerts ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.fleet_alerts FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON logistics.fleet_alerts USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.fleet_alerts TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('fleet_alerts');
};
