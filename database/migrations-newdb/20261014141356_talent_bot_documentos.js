'use strict';
/**
 * Fase RH · `[RH.3.3.4]` — el bot recibe los documentos del EXPEDIENTE.
 *
 *  · `documents` (jsonb): lo de los documentos que vive en la CONVERSACIÓN, no en el candidato —
 *      `solicitados`: los casilleros que RH le pidió (la lista que se le muestra y contra la que se cuenta lo que falta);
 *      `pedidos_en`: cuándo;
 *      `apartados`: lo que mandó ANTES de existir como candidato (p. ej. su INE cuando se le pedía el CV). Ya está en el
 *      bucket; viaja a `candidates.documents` al postularse, así no se le vuelve a pedir.
 *  · Dos estados: `pidiendo_documentos` (RH le pidió sus documentos) y `documentos_completos` (escribió «listo»). Los dos
 *    son de alguien YA postulado: llevan `outcome = 'postulada'` y su `candidate_id`.
 *
 * ── Lo medido antes ─────────────────────────────────────────────────────────────────────────
 *  · `bot_conversations_outcome_ck` exige `state = 'postulada'` para `outcome = 'postulada'`: sin ampliarlo, pedirle
 *    documentos a un postulado violaba el CHECK.
 *
 * Aditiva: columna nueva que nace NULL; los CHECK se reemplazan por una versión que acepta todo lo que ya aceptaban.
 * Va DESPUÉS de `20261014083512_talent_bot_solicitud` (amplía la lista de estados que ésa dejó). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'talent.bot_conversations';
const ESTADOS_PREVIOS = ['nuevo', 'orientando_puesto', 'confirmando', 'esperando_cv', 'armando_solicitud', 'solicitud_pausada',
  'revisando_cv', 'corrigiendo_solicitud', 'postulada', 'rechazada'];
const ESTADOS = [...ESTADOS_PREVIOS, 'pidiendo_documentos', 'documentos_completos'];
const POSTULADOS = ['postulada', 'pidiendo_documentos', 'documentos_completos'];

const lista = (xs) => xs.map((s) => `'${s}'`).join(', ');
const checkEstados = (xs) => `CHECK (state IN (${lista(xs)}) OR state ~ '^(esperando|editando)_[a-z_]+$')`;
const checkCierre = (postulados) => `CHECK (
  (outcome IS NULL AND state NOT IN (${lista([...postulados, 'rechazada'])}))
  OR (outcome = 'postulada' AND state IN (${lista(postulados)}) AND candidate_id IS NOT NULL)
  OR (outcome = 'rechazada' AND state = 'rechazada' AND outcome_reason IS NOT NULL))`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('talent').hasColumn('bot_conversations', 'documents'))) {
    await knex.raw(`ALTER TABLE ${T} ADD COLUMN documents jsonb`);
  }
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_documents_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_documents_ck
    CHECK (documents IS NULL OR (jsonb_typeof(documents) = 'object'
      AND jsonb_typeof(coalesce(documents -> 'solicitados', '[]'::jsonb)) = 'array'
      AND jsonb_typeof(coalesce(documents -> 'apartados', '[]'::jsonb)) = 'array'))`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_state_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_state_ck ${checkEstados(ESTADOS)}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_outcome_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_outcome_ck ${checkCierre(POSTULADOS)}`);
  await knex.raw(`COMMENT ON COLUMN ${T}.documents IS '[RH.3.3.4] Documentos en la conversación: los casilleros que RH pidió (solicitados, pedidos_en) y lo que mandó antes de ser candidato (apartados, ya en el bucket; viajan a candidates.documents al postularse).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. ⚠️ Falla si hay conversaciones en los estados nuevos (no se borran). */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_outcome_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_outcome_ck ${checkCierre(['postulada'])}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_state_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT bot_conversations_state_ck ${checkEstados(ESTADOS_PREVIOS)}`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS bot_conversations_documents_ck`);
  await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS documents`);
};
