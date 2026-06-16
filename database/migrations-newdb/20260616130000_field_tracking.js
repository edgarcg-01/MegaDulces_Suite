/**
 * Tracking de campo (vendedores + colaboradores): ubicación viva + rutas del día.
 *
 * Modelo "capturar denso, almacenar ralo":
 *  - field_track_points : pings crudos (hot). Se purgan al consolidar el día.
 *  - field_live_position: 1 fila por usuario (UPSERT). Posición actual (mapa vivo).
 *  - field_routes       : 1 fila por usuario+día. Ruta consolidada (encoded polyline)
 *                         + métricas. Histórico permanente y compacto.
 *
 * FK a identity.users/tenants (reales; public.* son vistas passthrough sin FK).
 * RLS forzado + grants app_runtime. Idempotente.
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
async function addFks(knex, table) {
  await knex.raw(`ALTER TABLE commercial.${table}
    ADD CONSTRAINT fk_${table}_user FOREIGN KEY (tenant_id, user_id)
    REFERENCES identity.users(tenant_id, id) ON DELETE CASCADE`);
  await knex.raw(`ALTER TABLE commercial.${table}
    ADD CONSTRAINT fk_${table}_tenant FOREIGN KEY (tenant_id)
    REFERENCES identity.tenants(id) ON DELETE RESTRICT`);
}

exports.up = async function (knex) {
  const has = (t) => knex.schema.withSchema('commercial').hasTable(t);

  if (!(await has('field_track_points'))) {
    await knex.schema.withSchema('commercial').createTable('field_track_points', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.decimal('latitude', 10, 7).notNullable();
      t.decimal('longitude', 10, 7).notNullable();
      t.decimal('accuracy_m', 8, 2);
      t.timestamp('recorded_at').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.primary('id');
      t.index(['tenant_id', 'user_id', 'recorded_at'], 'idx_field_track_points_user_time');
    });
    await addFks(knex, 'field_track_points');
    await hardenRls(knex, 'field_track_points');
  }

  if (!(await has('field_live_position'))) {
    await knex.schema.withSchema('commercial').createTable('field_live_position', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.decimal('latitude', 10, 7).notNullable();
      t.decimal('longitude', 10, 7).notNullable();
      t.decimal('accuracy_m', 8, 2);
      t.timestamp('recorded_at').notNullable();
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'user_id']);
    });
    await addFks(knex, 'field_live_position');
    await hardenRls(knex, 'field_live_position');
  }

  if (!(await has('field_routes'))) {
    await knex.schema.withSchema('commercial').createTable('field_routes', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('user_id').notNullable();
      t.date('route_date').notNullable();
      t.text('polyline').notNullable();
      t.integer('point_count').notNullable().defaultTo(0);
      t.decimal('distance_m', 12, 2).notNullable().defaultTo(0);
      t.timestamp('started_at');
      t.timestamp('ended_at');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.primary('id');
      t.unique(['tenant_id', 'user_id', 'route_date'], { indexName: 'uq_field_routes_user_date' });
      t.index(['tenant_id', 'route_date'], 'idx_field_routes_date');
    });
    await addFks(knex, 'field_routes');
    await hardenRls(knex, 'field_routes');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('field_track_points');
  await knex.schema.withSchema('commercial').dropTableIfExists('field_live_position');
  await knex.schema.withSchema('commercial').dropTableIfExists('field_routes');
};
