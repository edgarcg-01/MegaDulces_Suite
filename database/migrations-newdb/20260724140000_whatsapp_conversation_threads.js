/**
 * F.0.4 (ADR-006/007/034) — Estado del comercio conversacional por WhatsApp.
 *
 * Dos tablas en schema propio `whatsapp.*`:
 *   - conversation_threads: un hilo por número (estado del diálogo + carrito en
 *     curso + domicilio + customer/order resueltos). Un hilo "abierto" a la vez
 *     por teléfono (state != 'done').
 *   - messages: bitácora de mensajes in/out. Idempotencia por (tenant_id,
 *     wa_message_id) — es el dedup del webhook de Meta (reintrega el mismo
 *     mensaje) y del enqueue.
 *
 * El pedido NO vive aquí: al confirmar, el orquestador llama createIntake
 * (commercial.orders, delivery_channel='whatsapp', status='pending_approval') y
 * guarda el order_id en el hilo. Cadena de reparto = la de Fase LM.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado (current_tenant_id()) +
 * grants app_runtime. Idempotente. Permisos nuevos WHATSAPP_BOT_VER/GESTIONAR
 * anclados a REPARTO_DESPACHAR (quien opera la bandeja); customer_b2b nunca.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS whatsapp`);
  await knex.raw(`GRANT USAGE ON SCHEMA whatsapp TO app_runtime`);

  // ── conversation_threads ────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('whatsapp').hasTable('conversation_threads'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.conversation_threads (
        id                uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        phone             text NOT NULL,              -- E.164 sin '+'
        wa_id             text NOT NULL,              -- wa_id del contacto (Meta)
        profile_name      text,
        customer_id       uuid,                       -- commercial.customers (si se resuelve)
        state             text NOT NULL DEFAULT 'greeting'
                            CHECK (state IN ('greeting','shopping','address','review','handoff','done')),
        cart              jsonb NOT NULL DEFAULT '[]'::jsonb,
        delivery_address  jsonb,
        order_id          uuid,                       -- orden creada al confirmar (pending_approval)
        handoff_at        timestamptz,                -- derivado a operador humano
        last_message_at   timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id)
      )`);
    // Un solo hilo ABIERTO por número (parcial: excluye los cerrados).
    await knex.raw(`
      CREATE UNIQUE INDEX uq_wa_thread_open
        ON whatsapp.conversation_threads (tenant_id, phone)
        WHERE state <> 'done'`);
    await knex.raw(`CREATE INDEX ix_wa_thread_state ON whatsapp.conversation_threads (tenant_id, state, last_message_at)`);
    await knex.raw(`ALTER TABLE whatsapp.conversation_threads ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE whatsapp.conversation_threads FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='whatsapp' AND tablename='conversation_threads' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON whatsapp.conversation_threads
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp.conversation_threads TO app_runtime`);
  }

  // ── messages ──────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('whatsapp').hasTable('messages'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.messages (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        thread_id      uuid NOT NULL,
        direction      text NOT NULL CHECK (direction IN ('in','out')),
        wa_message_id  text,                          -- id del proveedor (dedup)
        type           text NOT NULL DEFAULT 'text',
        body           text,
        payload        jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, thread_id)
          REFERENCES whatsapp.conversation_threads (tenant_id, id) ON DELETE CASCADE
      )`);
    // Dedup idempotente de mensajes con id de proveedor (los salientes del
    // simulador pueden no traer id → índice parcial sobre NOT NULL).
    await knex.raw(`
      CREATE UNIQUE INDEX uq_wa_message_provider_id
        ON whatsapp.messages (tenant_id, wa_message_id)
        WHERE wa_message_id IS NOT NULL`);
    await knex.raw(`CREATE INDEX ix_wa_messages_thread ON whatsapp.messages (tenant_id, thread_id, created_at)`);
    await knex.raw(`ALTER TABLE whatsapp.messages ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE whatsapp.messages FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='whatsapp' AND tablename='messages' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON whatsapp.messages
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp.messages TO app_runtime`);
  }

  // ── Permisos (backfill idempotente, patrón `-> 'KEY' IS NULL`) ──────────────
  // Ancla: quien opera el reparto (REPARTO_DESPACHAR) ve/gestiona la bandeja de
  // pedidos WhatsApp. customer_b2b nunca.
  const ver = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('WHATSAPP_BOT_VER',
              CASE WHEN role_name = 'customer_b2b' THEN false
                   ELSE COALESCE((permissions->>'REPARTO_DESPACHAR')::boolean, false) END)
      WHERE permissions -> 'WHATSAPP_BOT_VER' IS NULL`,
  );
  const gest = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('WHATSAPP_BOT_GESTIONAR',
              CASE WHEN role_name = 'customer_b2b' THEN false
                   ELSE COALESCE((permissions->>'REPARTO_DESPACHAR')::boolean, false) END)
      WHERE permissions -> 'WHATSAPP_BOT_GESTIONAR' IS NULL`,
  );
  console.log(
    `[whatsapp_conversation_threads] up · WHATSAPP_BOT_VER=${ver.rowCount ?? 0} WHATSAPP_BOT_GESTIONAR=${gest.rowCount ?? 0} (← REPARTO_DESPACHAR)`,
  );
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'WHATSAPP_BOT_VER' WHERE permissions -> 'WHATSAPP_BOT_VER' IS NOT NULL`);
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'WHATSAPP_BOT_GESTIONAR' WHERE permissions -> 'WHATSAPP_BOT_GESTIONAR' IS NOT NULL`);
  await knex.schema.withSchema('whatsapp').dropTableIfExists('messages');
  await knex.schema.withSchema('whatsapp').dropTableIfExists('conversation_threads');
};
