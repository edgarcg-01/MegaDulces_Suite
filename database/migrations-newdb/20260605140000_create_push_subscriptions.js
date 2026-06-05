/**
 * Portal B2B — Web Push (Fase 3 del plan PWA).
 *
 * Guarda las suscripciones push del navegador del rep (endpoint + claves) para
 * mandarle notificaciones de estado de pedido / promos.
 *
 * SIN RLS a propósito (igual que portal_telemetry_events): los envíos ocurren en
 * background (trigger por evento / cron) SIN tenant context, así que una policy
 * `current_tenant_id()` los bloquearía al leer. `tenant_id`/`user_id` se guardan
 * para acotar las queries manualmente (el `subscribe` corre autenticado).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('push_subscriptions');
  if (!exists) {
    await knex.schema.withSchema('commercial').createTable('push_subscriptions', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id');
      t.uuid('user_id').notNullable();
      // customer al que pertenece el user (resuelto de commercial.users al
      // suscribir). Permite notificar "al cliente" por order.customer_id.
      t.uuid('customer_id');
      t.text('endpoint').notNullable().unique();
      t.text('p256dh').notNullable();
      t.text('auth').notNullable();
      t.string('user_agent', 400);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('last_used_at', { useTz: true });

      t.index(['user_id'], 'idx_push_subs_user');
      t.index(['tenant_id'], 'idx_push_subs_tenant');
      t.index(['customer_id'], 'idx_push_subs_customer');
    });

    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.push_subscriptions TO app_runtime`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('push_subscriptions');
};
