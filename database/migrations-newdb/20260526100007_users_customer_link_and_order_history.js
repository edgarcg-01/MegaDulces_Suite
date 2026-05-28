/**
 * Migración: link users ↔ customers para Portal B2B + audit trail de orders.
 *
 * Cambios:
 *   1. public.users + columna `customer_id` UUID NULL.
 *      - Internal users (admin, supervisor, colaborador): customer_id = NULL.
 *      - B2B customer users (rol customer_b2b): customer_id = <commercial.customers.id>.
 *      - Composite FK (tenant_id, customer_id) → commercial.customers(tenant_id, id).
 *      - Permite que el portal B2B reuse el flujo auth-mt existente.
 *
 *   2. commercial.order_status_history — audit trail de transiciones de estado.
 *      - Una fila por cada cambio de status.
 *      - changed_by puede ser un user interno o un customer user.
 *      - reason opcional (ej: cancellation_reason).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ─────────────────────────────────────────────────────────────────────────
  // 1. ALTER public.users ADD customer_id
  // ─────────────────────────────────────────────────────────────────────────
  const hasCustomerId = await knex.schema.hasColumn('public.users', 'customer_id');
  if (!hasCustomerId) {
    await knex.schema.alterTable('public.users', (table) => {
      table.uuid('customer_id'); // nullable — solo customer users la pueblan
    });

    await knex.raw(`
      ALTER TABLE public.users
        ADD CONSTRAINT fk_users_tenant_customer
        FOREIGN KEY (tenant_id, customer_id)
        REFERENCES commercial.customers(tenant_id, id) ON DELETE SET NULL
    `);

    await knex.raw(`
      CREATE INDEX idx_users_tenant_customer
        ON public.users (tenant_id, customer_id)
        WHERE customer_id IS NOT NULL
    `);

    await knex.raw(`
      COMMENT ON COLUMN public.users.customer_id IS
        'Si NULL → internal user (staff del tenant). Si seteado → B2B customer user con role_name=customer_b2b. FK composite a commercial.customers garantiza mismo tenant.'
    `);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. commercial.order_status_history — audit trail
  // ─────────────────────────────────────────────────────────────────────────
  await knex.schema.withSchema('commercial').createTable('order_status_history', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('order_id').notNullable();
    table.string('from_status', 20); // nullable porque la creación no tiene "from"
    table.string('to_status', 20).notNullable();
    table.uuid('changed_by'); // user_id (interno o customer_b2b)
    table.string('changed_by_username', 100); // snapshot por si el user se elimina
    table.text('reason'); // cancellation_reason, notas, etc.
    table.jsonb('snapshot'); // copia de totals/balance en el momento del cambio (debugging)
    table.timestamp('changed_at').notNullable().defaultTo(knex.fn.now());

    table.primary('id');

    table.check(
      `?? IN ('draft', 'confirmed', 'fulfilled', 'cancelled')`,
      ['to_status'],
      'commercial_order_status_history_to_status_valid',
    );
    table.check(
      `?? IS NULL OR ?? IN ('draft', 'confirmed', 'fulfilled', 'cancelled')`,
      ['from_status', 'from_status'],
      'commercial_order_status_history_from_status_valid',
    );

    table.index('tenant_id', 'idx_commercial_order_status_history_tenant');
    table.index(['tenant_id', 'order_id', 'changed_at'], 'idx_commercial_order_status_history_order_time');
  });

  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      ADD CONSTRAINT fk_commercial_order_status_history_tenant
      FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.order_status_history
      ADD CONSTRAINT fk_commercial_order_status_history_order
      FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE CASCADE
  `);

  // RLS
  await knex.raw(`ALTER TABLE commercial.order_status_history ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.order_status_history FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.order_status_history
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.order_status_history TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.order_status_history IS 'Audit trail append-only de cambios de status de orders. 1 row por transición. changed_by puede ser internal user o customer_b2b.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('order_status_history');
  await knex.raw('ALTER TABLE public.users DROP CONSTRAINT IF EXISTS fk_users_tenant_customer');
  await knex.raw('DROP INDEX IF EXISTS idx_users_tenant_customer');
  const has = await knex.schema.hasColumn('public.users', 'customer_id');
  if (has) {
    await knex.schema.alterTable('public.users', (table) => {
      table.dropColumn('customer_id');
    });
  }
};
