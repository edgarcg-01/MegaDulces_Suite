/**
 * Horus — Sprint Horus.ACT.5: balanceo de carga entre rutas/personas.
 *
 * commercial.route_rebalance_log: 1 row por rebalanceo APLICADO (co-piloto: el
 * supervisor aprueba con el botón Aplicar). Guarda los movimientos de clientes,
 * el estado PREVIO (para revertir) y las métricas antes/después. Reversible:
 * `undo` lee el último `applied` del día y restaura `sales_route`/`visit_sequence`.
 *
 * El nivelado real se logra moviendo clientes entre rutas (redimensionar) porque
 * daily_assignments es 1 ruta/persona/día → persona = su ruta. RLS forzado + grants
 * app_runtime; Horus escribe vía KNEX_CONNECTION (superuser) + tenant_id explícito.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('route_rebalance_log');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('route_rebalance_log', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.integer('day_of_week').notNullable(); // ISODOW 1..7
    t.uuid('applied_by');
    t.jsonb('moves').notNullable().defaultTo('[]'); // [{customer_id, name, from_route, to_route}]
    t.jsonb('previous_state').notNullable().defaultTo('[]'); // [{id, sales_route, visit_sequence}]
    t.jsonb('metrics'); // {makespan_before, makespan_after, stddev_before, stddev_after, moved, improvement_pct}
    t.string('status', 12).notNullable().defaultTo('applied'); // applied | reverted
    t.timestamp('applied_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('reverted_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.index(['tenant_id', 'day_of_week', 'status'], 'idx_route_rebalance_log_tenant_day');
  });

  await knex.raw(`
    ALTER TABLE commercial.route_rebalance_log
      ADD CONSTRAINT chk_route_rebalance_status CHECK (status IN ('applied', 'reverted'))
  `);
  await knex.raw(`
    ALTER TABLE commercial.route_rebalance_log
      ADD CONSTRAINT fk_route_rebalance_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`ALTER TABLE commercial.route_rebalance_log ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.route_rebalance_log FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.route_rebalance_log
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.route_rebalance_log TO app_runtime`);

  await knex.raw(
    `COMMENT ON TABLE commercial.route_rebalance_log IS 'Horus ACT.5: rebalanceo de carga aplicado (co-piloto). moves + previous_state (undo) + métricas antes/después. Nivela tiempo por persona moviendo clientes entre rutas.'`,
  );
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('route_rebalance_log');
};
