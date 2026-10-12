'use strict';
/**
 * `[RH.2.1]` Reclutamiento — capa de datos. Esquema `talent.*` con lo que Mega Talento USA, y nada más.
 *
 * ── Lo medido antes (base de Mega Talento, sólo lectura, 12-oct-2026) ──────────────────────
 *  · `candidatos` 1,656 (≈300–700 por mes) · `candidatos_transiciones` 935 · `candidatos_eventos` 123
 *    · `puestos` 7.
 *  · `requisiciones` 0 y `evaluaciones` 0 → NO se portan: existen en el código y nadie las usó.
 *  · Etapas vigentes del portal (`portal_status`, `proceso.model.ts` de Mega Talento): filtro_inicial →
 *    entrevista_rh → aptitudes → psicometria; contratado y rechazado son desenlaces. Pasos registrados
 *    hacia cada una: aptitudes 521 · entrevista_rh 392 · psicometria 6 · contratado 13 (el último el 14-ago).
 *  · `portal_data` trae dictamen 905 · cuestionarioLiderazgo 864 · riesgo 515 · destacado 173 ·
 *    solicitud 279. Se queda como bolsa jsonb: son señales que calcula el bot y lee el portal tal cual.
 *  · `empleados.candidato_id` (permanencia) = 0 filas con valor → la liga candidato→persona no se
 *    porta hoy; cuando se use, se deriva.
 *
 * ── Decisiones ─────────────────────────────────────────────────────────────────────────────
 *  · Una fila por candidato en `talent.candidates`, con el MISMO `id` de Mega Talento: la carga
 *    única es idempotente y las ligas que ya mandó RH (con ese id) siguen apuntando a alguien.
 *    El id viejo de Firestore (`portal_candidate_id`, 3 de cada 4 vivos) va en `legacy_portal_id`.
 *  · El teléfono se guarda como llegó y se DERIVA `phone_key` (últimos 10 dígitos). El bot guarda
 *    13 dígitos (521…) y el portal 10 → la misma persona quedaba dos veces. NO es UNIQUE: esos
 *    duplicados ya existen y la carga no los puede fusionar sola; se ven y se fusionan a mano.
 *  · `stage` (la etapa del portal) y `bot_state` (el punto del flujo de WhatsApp) son DOS cosas,
 *    como en Mega Talento: el bot no pisa la etapa de RH. Los dos son texto sin CHECK: el catálogo
 *    vive en la lógica (mismo criterio que `hr.attendance_incidents.incident_type`).
 *  · Lista negra (`no_rehire`) y spam son MARCAS sobre el candidato, con motivo, quién y cuándo
 *    (CHECK: no hay marca sin motivo). La papelera es `deleted_at`: nada se borra.
 *  · La bitácora de etapas y los eventos son de sólo agregar para la app (SELECT, INSERT).
 *  · FUSIONAR dos registros de la misma persona NO mueve su historia, como hacía Mega Talento
 *    (`UPDATE candidatos_eventos SET candidato_id=…`): el absorbido va a la papelera con
 *    `merged_into_id` y la ficha junta la historia de los dos. Así la bitácora sigue intacta y la
 *    fusión se deshace restaurando. `deletion_reason` dice por qué está en la papelera.
 *  · El acceso público (formulario y evaluación) NO usa el id como llave, como hacía Mega Talento
 *    (cualquiera con el UUID leía y editaba el expediente): será un token firmado con vencimiento
 *    (`[RH.2.3]`), que no necesita columna.
 *  · Actores: `uuid` de `identity.users` + `*_name` para lo que llega de Mega Talento como texto.
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const S = 'talent';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS ${S}`);

  const rls = async (table, grants = 'SELECT, INSERT, UPDATE') => {
    await knex.raw(`ALTER TABLE ${S}.${table} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${S}.${table} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='${S}' AND tablename='${table}' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON ${S}.${table}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT ${grants} ON ${S}.${table} TO app_runtime`);
  };

  // ── 1) Vacantes (antes `puestos`) ──────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema(S).hasTable('job_postings'))) {
    await knex.raw(`
      CREATE TABLE ${S}.job_postings (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        name                text NOT NULL CHECK (btrim(name) <> ''),
        description         text,
        area                text,
        branch_codes        text[] NOT NULL DEFAULT '{}',    -- plazas donde aplica (sitio de RH)
        branches_text       text,                            -- como lo escribió RH ("Zamora y La Piedad")
        salary_text         text,                            -- texto libre, como se publica
        schedule_text       text,
        requirements        text,
        image_url           text,
        competencies_sheet  text,
        extra               jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active           boolean NOT NULL DEFAULT true,
        sort_order          integer NOT NULL DEFAULT 999,
        created_by          uuid,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX ix_talent_jobs_active ON ${S}.job_postings (tenant_id, is_active, sort_order)`);
    await knex.raw(`COMMENT ON TABLE ${S}.job_postings IS 'Fase RH: vacantes publicadas (antes puestos de Mega Talento).'`);
    await rls('job_postings');
  }

  // ── 2) Candidatos ──────────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema(S).hasTable('candidates'))) {
    await knex.raw(`
      CREATE TABLE ${S}.candidates (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- el mismo id de Mega Talento
        tenant_id              uuid NOT NULL,
        legacy_portal_id       text,                         -- id viejo de Firestore (las ligas lo traen)
        phone                  text,                         -- como llegó
        phone_key              text GENERATED ALWAYS AS (
                                 NULLIF(right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10), '')) STORED,
        full_name              text,
        email                  text,
        city_branch            text,                         -- la plaza que eligió
        position_interest      text,
        job_posting_id         uuid,
        source                 text,                         -- whatsapp, portal, referido…
        origin                 text,
        stage                  text,                         -- etapa de RH (filtro_inicial, aptitudes, …)
        bot_state              text,                         -- punto del flujo de WhatsApp
        traffic_light          text CHECK (traffic_light IS NULL OR traffic_light IN ('verde','amarillo','rojo')),
        -- Lo que pregunta el bot
        commute_time           text,
        availability           text,
        previous_employer      text,
        desired_salary         text,
        rfc                    text,
        nss                    text,
        relative_in_company    text,
        rehire_note            text,                         -- «ya trabajé aquí»: como lo contó la persona
        -- Expediente
        cv_url                 text,
        cv_back_url            text,
        cv_format              text,
        license_url            text,
        documents              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- archivos recibidos por WhatsApp
        requested_documents    jsonb NOT NULL DEFAULT '[]'::jsonb,
        application            jsonb,                        -- solicitud electrónica
        aptitude_rubric        jsonb,
        aptitude_eval          jsonb,
        portal_data            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- señales del bot y del portal
        -- Marcas
        no_rehire              boolean NOT NULL DEFAULT false,
        no_rehire_reason       text,
        no_rehire_by           uuid,
        no_rehire_by_name      text,
        no_rehire_at           timestamptz,
        is_spam                boolean NOT NULL DEFAULT false,
        spam_reason            text,
        spam_by                uuid,
        spam_by_name           text,
        spam_at                timestamptz,
        -- Tiempos
        notified_at            timestamptz,
        notified_to            jsonb,
        last_interaction_at    timestamptz,
        last_activity_at       timestamptz,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_at             timestamptz NOT NULL DEFAULT now(),
        deleted_at             timestamptz,                  -- papelera: nada se borra
        deleted_by             uuid,
        deletion_reason        text CHECK (deletion_reason IS NULL OR deletion_reason IN ('manual','cierre_seguimiento','fusionado')),
        merged_into_id         uuid,                         -- el registro que lo absorbió
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, merged_into_id) REFERENCES ${S}.candidates (tenant_id, id),
        FOREIGN KEY (tenant_id, job_posting_id) REFERENCES ${S}.job_postings (tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT candidates_no_rehire_ck CHECK (
          NOT no_rehire OR (no_rehire_reason IS NOT NULL AND btrim(no_rehire_reason) <> '' AND no_rehire_at IS NOT NULL)),
        CONSTRAINT candidates_spam_ck CHECK (
          NOT is_spam OR (spam_reason IS NOT NULL AND btrim(spam_reason) <> '' AND spam_at IS NOT NULL)),
        CONSTRAINT candidates_trash_ck CHECK ((deleted_at IS NULL) = (deletion_reason IS NULL)),
        CONSTRAINT candidates_merge_ck CHECK (
          merged_into_id IS NULL OR (coalesce(deletion_reason, '') = 'fusionado' AND merged_into_id <> id))
      )`);
    await knex.raw(`CREATE INDEX ix_talent_cand_phone ON ${S}.candidates (tenant_id, phone_key)`);
    await knex.raw(`CREATE INDEX ix_talent_cand_no_rehire ON ${S}.candidates (tenant_id, phone_key) WHERE no_rehire`);
    await knex.raw(`CREATE INDEX ix_talent_cand_stage ON ${S}.candidates (tenant_id, stage, created_at DESC) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_talent_cand_merged ON ${S}.candidates (tenant_id, merged_into_id) WHERE merged_into_id IS NOT NULL`);
    await knex.raw(`CREATE INDEX ix_talent_cand_legacy ON ${S}.candidates (tenant_id, legacy_portal_id) WHERE legacy_portal_id IS NOT NULL`);
    await knex.raw(`COMMENT ON TABLE ${S}.candidates IS 'Fase RH: candidatos (antes candidatos de Mega Talento, bot + portal). Mismo id. Lista negra y spam son marcas con motivo; la papelera es deleted_at.'`);
    await knex.raw(`COMMENT ON COLUMN ${S}.candidates.phone_key IS 'Últimos 10 dígitos del teléfono. El bot guardaba 13 y el portal 10: así se reconoce a la misma persona. No es UNIQUE a propósito (hay duplicados históricos).'`);
    await rls('candidates');
  }

  // ── 3) Bitácora de etapas (sólo agregar) ───────────────────────────────────────────────
  if (!(await knex.schema.withSchema(S).hasTable('candidate_stage_transitions'))) {
    await knex.raw(`
      CREATE TABLE ${S}.candidate_stage_transitions (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        candidate_id    uuid NOT NULL,
        stage_from      text,
        stage_to        text NOT NULL,
        hours_in_from   numeric CHECK (hours_in_from IS NULL OR hours_in_from >= 0),
        changed_by      uuid,
        changed_by_name text,
        changed_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, candidate_id) REFERENCES ${S}.candidates (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_talent_trans_cand ON ${S}.candidate_stage_transitions (tenant_id, candidate_id, changed_at)`);
    await knex.raw(`CREATE INDEX ix_talent_trans_from ON ${S}.candidate_stage_transitions (tenant_id, stage_from, changed_at)`);
    await knex.raw(`COMMENT ON TABLE ${S}.candidate_stage_transitions IS 'Fase RH: cada cambio de etapa de un candidato (KPI de tiempo por etapa). Sólo agregar.'`);
    await rls('candidate_stage_transitions', 'SELECT, INSERT');
  }

  // ── 4) Eventos del proceso (contacto, entrevista, contratación, nota) ──────────────────
  if (!(await knex.schema.withSchema(S).hasTable('candidate_events'))) {
    await knex.raw(`
      CREATE TABLE ${S}.candidate_events (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        candidate_id  uuid NOT NULL,
        event_type    text NOT NULL CHECK (event_type IN ('contacto','entrevista','contratacion','nota')),
        channel       text CHECK (channel IS NULL OR channel IN ('llamada','whatsapp','presencial','bot','portal')),
        note          text,
        actor_id      uuid,
        actor_name    text,                                  -- usuario de RH, o «bot»
        occurred_at   timestamptz NOT NULL DEFAULT now(),
        created_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, candidate_id) REFERENCES ${S}.candidates (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_talent_ev_cand ON ${S}.candidate_events (tenant_id, candidate_id, occurred_at)`);
    await knex.raw(`CREATE INDEX ix_talent_ev_type ON ${S}.candidate_events (tenant_id, event_type, occurred_at)`);
    await knex.raw(`COMMENT ON TABLE ${S}.candidate_events IS 'Fase RH: lo que pasó con un candidato y cuándo (concentrado de RH). Sólo agregar.'`);
    await rls('candidate_events', 'SELECT, INSERT');
  }

  await knex.raw(`GRANT USAGE ON SCHEMA ${S} TO app_runtime`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.schema.withSchema(S).dropTableIfExists('candidate_events');
  await knex.schema.withSchema(S).dropTableIfExists('candidate_stage_transitions');
  await knex.schema.withSchema(S).dropTableIfExists('candidates');
  await knex.schema.withSchema(S).dropTableIfExists('job_postings');
  await knex.raw(`DROP SCHEMA IF EXISTS ${S}`);
};
