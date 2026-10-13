'use strict';
/**
 * `[RH.3.2]` La conversación de registro por WhatsApp: dónde va cada persona y lo que lleva contestado.
 *
 * ── Por qué una tabla aparte (y no `talent.candidates.bot_state`) ───────────────────────────
 *  En Mega Talento la conversación ERA el candidato: el primer «hola» creaba una fila en `candidatos`, y por eso hay
 *  candidatos cuyo puesto dice «Hola» y fichas de gente que nunca terminó. En la Suite la conversación NO es el
 *  candidato: se guarda aquí, y el candidato se crea con las reglas de postulación (`HrTalentIntakeService.postular`,
 *  las mismas de la web) cuando termina — con su CV, como en Mega Talento.
 *
 *  · Una fila por teléfono (últimos 10 dígitos, como `candidates.phone_key`): el bot guarda 13, la web 10.
 *  · `state` es el punto del flujo (`esperando_<campo>`, `editando_<campo>`, `confirmando`, `esperando_cv`, …).
 *  · `data` son las respuestas del registro con los nombres de columna de `talent.candidates`.
 *  · `candidate_id` se llena cuando la postulación entra (o con el proceso abierto si se rechazó por duplicada).
 *  · `outcome` dice cómo terminó: `postulada` o `rechazada` (con su `outcome_reason`, el motivo de la regla).
 *
 * Aditiva. Convención A.0mt: tenant_id + RLS forzado + grants app_runtime (sin DELETE). Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const S = 'talent';
const T = 'bot_conversations';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema(S).hasTable(T))) {
    await knex.raw(`
      CREATE TABLE ${S}.${T} (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        phone            text NOT NULL,                     -- como llegó de WhatsApp
        phone_key        text GENERATED ALWAYS AS (
                           NULLIF(right(regexp_replace(phone, '[^0-9]', '', 'g'), 10), '')) STORED,
        profile_name     text,                              -- el nombre de su perfil de WhatsApp (no es su nombre legal)
        state            text NOT NULL DEFAULT 'nuevo',
        data             jsonb NOT NULL DEFAULT '{}'::jsonb,
        candidate_id     uuid,
        outcome          text,
        outcome_reason   text,
        last_inbound_at  timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, phone_key),
        FOREIGN KEY (tenant_id, candidate_id) REFERENCES ${S}.candidates (tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT bot_conversations_phone_ck CHECK (phone_key IS NOT NULL AND length(phone_key) = 10),
        CONSTRAINT bot_conversations_state_ck CHECK (
          state IN ('nuevo', 'confirmando', 'esperando_cv', 'postulada', 'rechazada')
          OR state ~ '^(esperando|editando)_[a-z_]+$'),
        CONSTRAINT bot_conversations_data_ck CHECK (jsonb_typeof(data) = 'object'),
        CONSTRAINT bot_conversations_outcome_ck CHECK (
          (outcome IS NULL AND state NOT IN ('postulada', 'rechazada'))
          OR (outcome = 'postulada' AND state = 'postulada' AND candidate_id IS NOT NULL)
          OR (outcome = 'rechazada' AND state = 'rechazada' AND outcome_reason IS NOT NULL))
      )`);
    await knex.raw(`COMMENT ON TABLE ${S}.${T} IS 'Fase RH: la conversación de registro por WhatsApp (una por teléfono). La conversación no es el candidato: éste se crea al terminar, con las reglas de postulación.'`);
    await knex.raw(`ALTER TABLE ${S}.${T} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${S}.${T} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='${S}' AND tablename='${T}' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON ${S}.${T}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${S}.${T} TO app_runtime`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.schema.withSchema(S).dropTableIfExists(T);
};
