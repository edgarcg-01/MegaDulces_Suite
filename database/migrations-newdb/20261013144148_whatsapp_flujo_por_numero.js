'use strict';
/**
 * `[RH.3.1]` WhatsApp — cada número declara su FLUJO, y el libro de mensajes deja de exigir un hilo de comercio.
 *
 * ── Lo medido antes (13-oct-2026, sólo lectura del código) ──────────────────────────────────
 *  · `phone_number_id` sólo resolvía el TENANT (`whatsapp.phone_number_tenant_map`); elegir el flujo era un if/else fijo
 *    en la ingesta (captura bancaria → comercio). El número de reclutamiento no tenía a dónde ir.
 *  · `whatsapp.messages.thread_id` es NOT NULL con FK a `conversation_threads` (hilos de COMERCIO): un mensaje de
 *    reclutamiento no cabía. Las respuestas de la captura bancaria ya no se registraban por lo mismo.
 *  · La ventana de 24 h de Meta no se medía en ningún lado de la Suite.
 *
 * ── Lo que hace ─────────────────────────────────────────────────────────────────────────────
 *  1. `phone_number_tenant_map.flow` ('commerce' | 'recruitment'), default 'commerce': el número existente sigue igual.
 *  2. `messages.thread_id` acepta NULL, y los mensajes ganan `flow`, `phone` y `phone_number_id`. Un CHECK conserva la
 *     regla vieja donde aplica: un mensaje de COMERCIO sigue exigiendo su hilo.
 *  3. Índice para la ventana de 24 h: el último mensaje ENTRANTE por (flujo, teléfono).
 *
 * «Un solo libro de WhatsApp» (FASE_RH §2): se descarta una tabla aparte para reclutamiento.
 *
 * Aditiva; los mensajes existentes quedan como 'commerce' con su hilo. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const FLUJOS_NUMERO = ['commerce', 'recruitment'];
const FLUJOS_MENSAJE = ['commerce', 'recruitment', 'bank_capture'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const existe = async (tabla, nombre) => (await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass`, [nombre, tabla])).rows.length > 0;

  // 1) El flujo de cada número.
  if (!(await knex.schema.withSchema('whatsapp').hasColumn('phone_number_tenant_map', 'flow'))) {
    await knex.raw(`ALTER TABLE whatsapp.phone_number_tenant_map ADD COLUMN flow varchar(20) NOT NULL DEFAULT 'commerce'`);
  }
  if (!(await existe('whatsapp.phone_number_tenant_map', 'phone_number_tenant_map_flow_ck'))) {
    await knex.raw(`ALTER TABLE whatsapp.phone_number_tenant_map ADD CONSTRAINT phone_number_tenant_map_flow_ck
      CHECK (flow IN (${FLUJOS_NUMERO.map((f) => `'${f}'`).join(',')}))`);
  }

  // 2) El libro de mensajes: sin hilo obligatorio, con flujo, teléfono y número.
  await knex.raw(`ALTER TABLE whatsapp.messages ALTER COLUMN thread_id DROP NOT NULL`);
  if (!(await knex.schema.withSchema('whatsapp').hasColumn('messages', 'flow'))) {
    await knex.raw(`ALTER TABLE whatsapp.messages ADD COLUMN flow varchar(20) NOT NULL DEFAULT 'commerce'`);
  }
  if (!(await knex.schema.withSchema('whatsapp').hasColumn('messages', 'phone'))) {
    await knex.raw(`ALTER TABLE whatsapp.messages ADD COLUMN phone varchar(20)`);
  }
  if (!(await knex.schema.withSchema('whatsapp').hasColumn('messages', 'phone_number_id'))) {
    await knex.raw(`ALTER TABLE whatsapp.messages ADD COLUMN phone_number_id varchar(40)`);
  }
  if (!(await existe('whatsapp.messages', 'messages_flow_ck'))) {
    await knex.raw(`ALTER TABLE whatsapp.messages ADD CONSTRAINT messages_flow_ck
      CHECK (flow IN (${FLUJOS_MENSAJE.map((f) => `'${f}'`).join(',')}))`);
  }
  // Un mensaje de comercio sigue exigiendo su hilo; los demás flujos no tienen hilo de comercio.
  if (!(await existe('whatsapp.messages', 'messages_commerce_thread_ck'))) {
    await knex.raw(`ALTER TABLE whatsapp.messages ADD CONSTRAINT messages_commerce_thread_ck
      CHECK (flow <> 'commerce' OR thread_id IS NOT NULL)`);
  }
  // Fuera de comercio, sin teléfono el mensaje no es de nadie.
  if (!(await existe('whatsapp.messages', 'messages_phone_ck'))) {
    await knex.raw(`ALTER TABLE whatsapp.messages ADD CONSTRAINT messages_phone_ck
      CHECK (flow = 'commerce' OR phone IS NOT NULL)`);
  }

  // 3) La ventana de 24 h: el último entrante por (flujo, teléfono).
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_wa_messages_flow_phone
    ON whatsapp.messages (tenant_id, flow, phone, created_at DESC) WHERE direction = 'in'`);
  await knex.raw(`COMMENT ON COLUMN whatsapp.messages.flow IS 'De qué flujo es el mensaje (el número que lo recibió/envió). Comercio exige hilo; reclutamiento y captura bancaria no.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. ⚠️ Falla si ya hay mensajes sin hilo (no se borran: hay que decidir qué hacer con ellos). */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS whatsapp.ix_wa_messages_flow_phone`);
  await knex.raw(`ALTER TABLE whatsapp.messages DROP CONSTRAINT IF EXISTS messages_phone_ck`);
  await knex.raw(`ALTER TABLE whatsapp.messages DROP CONSTRAINT IF EXISTS messages_commerce_thread_ck`);
  await knex.raw(`ALTER TABLE whatsapp.messages DROP CONSTRAINT IF EXISTS messages_flow_ck`);
  await knex.raw(`ALTER TABLE whatsapp.messages DROP COLUMN IF EXISTS phone_number_id`);
  await knex.raw(`ALTER TABLE whatsapp.messages DROP COLUMN IF EXISTS phone`);
  await knex.raw(`ALTER TABLE whatsapp.messages DROP COLUMN IF EXISTS flow`);
  await knex.raw(`ALTER TABLE whatsapp.messages ALTER COLUMN thread_id SET NOT NULL`);
  await knex.raw(`ALTER TABLE whatsapp.phone_number_tenant_map DROP CONSTRAINT IF EXISTS phone_number_tenant_map_flow_ck`);
  await knex.raw(`ALTER TABLE whatsapp.phone_number_tenant_map DROP COLUMN IF EXISTS flow`);
};
