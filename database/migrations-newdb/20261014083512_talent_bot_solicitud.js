'use strict';
/**
 * `[RH.3.3.3]` — La solicitud de empleo que el bot arma por chat para quien no tiene CV, y los estados del armado.
 *
 * ── Por qué una columna en la conversación (y no en `talent.candidates.application`) ───────────────────────────────
 *  El candidato todavía NO existe mientras se arma: se crea al terminar, con su CV (regla de RH.3.2). Las respuestas
 *  viven en la conversación mientras tanto y, al aceptar su CV, viajan a `candidates.application` (columna que ya
 *  existía para «la solicitud electrónica»).
 *
 *  · `bot_conversations.application` (jsonb, NULL = no ha empezado): `{ respuestas, consentimiento?, foto_key?,
 *    cv_key?, iniciada_en, terminada_en? }`. El consentimiento de lo sensible guarda la VERSIÓN del texto y la fecha.
 *  · Estados nuevos del CHECK: `armando_solicitud`, `solicitud_pausada`, `revisando_cv`, `corrigiendo_solicitud`.
 *
 * ── Lo medido antes ───────────────────────────────────────────────────────────────────────────────────────────────
 *  La migración `20261013150116` (la tabla) ya está en `main` (#398) y NO aplicada en producción. No se edita: el
 *  cambio va aquí, aditivo. Idempotente (`hasColumn`; el CHECK se reemplaza por nombre).
 *
 * @param { import("knex").Knex } knex
 */

const T = 'talent.bot_conversations';
const ESTADOS = ['nuevo', 'orientando_puesto', 'confirmando', 'esperando_cv', 'armando_solicitud', 'solicitud_pausada',
  'revisando_cv', 'corrigiendo_solicitud', 'postulada', 'rechazada'];
const ESTADOS_PREVIOS = ['nuevo', 'orientando_puesto', 'confirmando', 'esperando_cv', 'postulada', 'rechazada'];

const checkEstados = (lista) => `CHECK (state IN (${lista.map((s) => `'${s}'`).join(', ')}) OR state ~ '^(esperando|editando)_[a-z_]+$')`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('talent').hasColumn('bot_conversations', 'application'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN application jsonb`);
  }
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_application_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_application_ck
    CHECK (application IS NULL OR (jsonb_typeof(application) = 'object' AND jsonb_typeof(application -> 'respuestas') = 'object'))`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_state_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_state_ck ${checkEstados(ESTADOS)}`);
  await knex.raw(`COMMENT ON COLUMN ${T}.application IS '[RH.3.3.3] La solicitud de empleo armada por chat (respuestas, consentimiento de lo sensible con su versión, foto y CV). Viaja a candidates.application al postularse.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. ⚠️ Falla si hay conversaciones en los estados nuevos (no se borran). */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_state_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_state_ck ${checkEstados(ESTADOS_PREVIOS)}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_application_ck`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS application`);
};
