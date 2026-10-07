/**
 * Fase E.0 — Schema de televenta (Remote Manager).
 *
 * Crea 2 tablas en `commercial.*`:
 *
 *   1. `commercial.lead_reservations` — qué operador tomó qué cliente del pool
 *      y por cuánto tiempo (TTL). Un cron limpia las expiradas cada 5 min.
 *      UNIQUE PARTIAL `(tenant_id, customer_id) WHERE released_at IS NULL`
 *      previene dos operadores compitiendo por el mismo lead.
 *
 *   2. `commercial.call_logs` — log de cada llamada con outcome + notes.
 *      Opcionalmente linkeado a `commercial.orders` cuando outcome=sale.
 *
 * Ambas con composite FK `(tenant_id, ...)`, RLS forzado + grants app_runtime.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── 1. commercial.lead_reservations ───────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('lead_reservations', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('customer_id').notNullable();
    table.uuid('reserved_by_user_id').notNullable();
    table.timestamp('reserved_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('expires_at').notNullable();
    table.timestamp('released_at'); // NULL = activa
    table.text('released_reason'); // 'completed' | 'released_manual' | 'expired'

    table.primary('id');
  });

  // Composite FK al cliente: (tenant_id, customer_id) → commercial.customers(tenant_id, id).
  // Esto enforces que el customer pertenece al mismo tenant que la reserva.
  await knex.raw(`
    ALTER TABLE commercial.lead_reservations
      ADD CONSTRAINT fk_lead_reservations_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE commercial.lead_reservations
      ADD CONSTRAINT fk_lead_reservations_user
      FOREIGN KEY (tenant_id, reserved_by_user_id)
      REFERENCES public.users(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE commercial.lead_reservations
      ADD CONSTRAINT fk_lead_reservations_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);

  await knex.raw(`
    ALTER TABLE commercial.lead_reservations
      ADD CONSTRAINT chk_lead_reservations_released_reason
      CHECK (released_reason IS NULL OR released_reason IN ('completed', 'released_manual', 'expired'))
  `);

  // UNIQUE PARTIAL: solo una reserva activa (released_at IS NULL) por customer + tenant.
  await knex.raw(`
    CREATE UNIQUE INDEX uq_lead_reservations_active
      ON commercial.lead_reservations (tenant_id, customer_id)
      WHERE released_at IS NULL
  `);

  await knex.raw(`CREATE INDEX idx_lead_reservations_user ON commercial.lead_reservations (tenant_id, reserved_by_user_id, released_at)`);
  await knex.raw(`CREATE INDEX idx_lead_reservations_expires ON commercial.lead_reservations (expires_at) WHERE released_at IS NULL`);

  await knex.raw(`ALTER TABLE commercial.lead_reservations ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.lead_reservations FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.lead_reservations
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);

  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.lead_reservations TO app_runtime`);

  // ── 2. commercial.call_logs ───────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('call_logs', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('customer_id').notNullable();
    table.uuid('user_id').notNullable(); // operador
    table.timestamp('called_at').notNullable().defaultTo(knex.fn.now());
    table.text('outcome').notNullable();
    table.text('notes');
    table.timestamp('next_action_at'); // NULL excepto si outcome='callback_scheduled'
    table.uuid('order_id'); // NULL excepto si outcome='sale'
    table.smallint('duration_minutes'); // estimate del operador

    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.primary('id');
  });

  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT fk_call_logs_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT fk_call_logs_user
      FOREIGN KEY (tenant_id, user_id)
      REFERENCES public.users(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT fk_call_logs_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);

  // FK opcional al order — sin ON CASCADE para que un order borrado no pierda
  // el log. (Soft-delete preserva FK).
  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT fk_call_logs_order
      FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE SET NULL
  `);

  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT chk_call_logs_outcome
      CHECK (outcome IN ('sale', 'no_sale', 'callback_scheduled', 'no_answer', 'wrong_contact', 'other'))
  `);

  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT chk_call_logs_callback_action
      CHECK (
        (outcome = 'callback_scheduled' AND next_action_at IS NOT NULL)
        OR (outcome <> 'callback_scheduled')
      )
  `);

  await knex.raw(`
    ALTER TABLE commercial.call_logs
      ADD CONSTRAINT chk_call_logs_duration_positive
      CHECK (duration_minutes IS NULL OR duration_minutes >= 0)
  `);

  await knex.raw(`CREATE INDEX idx_call_logs_customer ON commercial.call_logs (tenant_id, customer_id, called_at DESC)`);
  await knex.raw(`CREATE INDEX idx_call_logs_user ON commercial.call_logs (tenant_id, user_id, called_at DESC)`);
  await knex.raw(`CREATE INDEX idx_call_logs_callback ON commercial.call_logs (tenant_id, next_action_at) WHERE outcome = 'callback_scheduled' AND next_action_at IS NOT NULL`);

  await knex.raw(`ALTER TABLE commercial.call_logs ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.call_logs FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.call_logs
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);

  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.call_logs TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.lead_reservations IS 'Fase E: qué operador (reserved_by_user_id) tomó qué cliente del pool de televenta y por cuánto tiempo. Cron libera expiradas cada 5min.'`);
  await knex.raw(`COMMENT ON TABLE commercial.call_logs IS 'Fase E: log de cada llamada de televenta con outcome + notes. Opcionalmente linkeado a commercial.orders.id si outcome=sale.'`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('call_logs');
  await knex.schema.withSchema('commercial').dropTableIfExists('lead_reservations');
};
