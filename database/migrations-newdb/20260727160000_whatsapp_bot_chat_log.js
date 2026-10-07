/**
 * FIQ.1 — Auditoría por turno del bot (whatsapp.bot_chat_log).
 *
 * Una fila por turno LLM: mensaje del cliente + respuesta + modelo usado (tiering
 * Haiku/Sonnet) + tools + iteraciones + latencia + feedback 👍/👎. Sirve para:
 *   - AUDITORÍA / observabilidad del bot.
 *   - THROTTLE / budget-guard: contar turnos por teléfono en 24h (canal público
 *     sin techo = vector de gasto/DoS).
 *   - FEW-SHOT futuro (aprendizaje por similitud) + señal de feedback.
 *
 * tenant_id + RLS FORZADO + grant app_runtime (regla dura). Sin FK a threads
 * (soft ref, append-only). Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('whatsapp').hasTable('bot_chat_log')) return;

  await knex.schema.withSchema('whatsapp').createTable('bot_chat_log', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('thread_id'); // soft ref al hilo (sin FK: append-only para auditoría)
    t.text('phone').notNullable(); // E.164 canónico
    t.text('user_text');
    t.text('reply_text');
    t.text('model').notNullable(); // claude-haiku-4-5-* | claude-sonnet-5
    t.boolean('escalated').notNullable().defaultTo(false); // ¿subió a Sonnet?
    t.jsonb('tools_used').notNullable().defaultTo('[]');
    t.integer('iterations').notNullable().defaultTo(0);
    t.integer('latency_ms');
    t.smallint('feedback'); // NULL | 1 (👍) | -1 (👎) — captura diferida
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.check('?? IN (-1, 1)', ['feedback'], 'whatsapp_bot_chat_log_feedback_valid');
    // Índice del throttle: turnos por teléfono en ventana móvil.
    t.index(['tenant_id', 'phone', 'created_at'], 'idx_bot_chat_log_phone_time');
  });

  await knex.raw(`ALTER TABLE whatsapp.bot_chat_log ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE whatsapp.bot_chat_log FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON whatsapp.bot_chat_log
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp.bot_chat_log TO app_runtime');
  await knex.raw(`COMMENT ON TABLE whatsapp.bot_chat_log IS 'FIQ.1: auditoría por turno del bot (modelo/tools/latencia) + fuente del throttle (turnos/24h por teléfono) + feedback 👍/👎.'`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('whatsapp').dropTableIfExists('bot_chat_log');
};
