'use strict';
/**
 * `[PRV.2]` — El consentimiento del aviso de privacidad de una cola (hoy: la de RH). `FASE_MSH_PRIVACIDAD_Y_RETENCION.md` §4 y §6.1.
 *
 * Sólo base de datos: ninguna cola exige aviso todavía (la cola de RH aún no existe: es MSH.4), así que TI y Mantenimiento quedan EXACTAMENTE
 * como están. Lo que deja es la evidencia, que es justo lo que no se puede reconstruir después: quién aceptó qué texto y cuándo.
 *
 * ── Qué agrega ───────────────────────────────────────────────────────────────────────────────
 *  · `servicedesk.privacy_notices` — el aviso por CÓDIGO y VERSIÓN (`rh` v1, v2…): un texto corto que se muestra en el formulario, el texto de
 *    la casilla de consentimiento y la URL del aviso integral. Estados: `borrador` → `vigente` → `retirado`. **Una sola vigente por código.**
 *  · `servicedesk.privacy_acceptances` — la aceptación de una persona a una versión. Una fila por (versión, persona); si el aviso cambia de
 *    versión, vuelve a aceptar.
 *  · `queues.privacy_notice_code` — qué aviso exige la cola (NULL = ninguno, que es el valor de siempre).
 *
 * ── Las defensas de la base (la evidencia no se puede reescribir) ────────────────────────────
 *  1. **El texto de un aviso ya publicado no se edita.** Una aceptación apunta a una versión: si se pudiera cambiar el texto, la persona
 *     habría aceptado algo distinto de lo que dice el aviso hoy. Para cambiarlo se publica una versión NUEVA. Sólo un `borrador` se edita.
 *  2. **El estado sólo avanza:** borrador → vigente → retirado. Un aviso retirado no vuelve a ser vigente.
 *  3. **Una sola versión vigente por código** (índice único parcial): no hay dos textos «oficiales» a la vez.
 *  4. **La aceptación no se modifica ni se borra desde la API:** `app_runtime` sólo tiene INSERT y SELECT sobre ella, y un trigger rechaza
 *     el UPDATE aunque lo intente alguien con privilegios. (Se borrará, cuando toque, por el proceso de retención de PRV.4.)
 *
 * Los triggers son `SECURITY INVOKER` y se disparan sólo con UPDATE. Aditiva, idempotente y reversible; `down` se NIEGA si ya hay
 * aceptaciones (borrarlas destruiría la prueba del consentimiento).
 *
 * @param { import("knex").Knex } knex
 */
const MSG_TEXTO = 'El texto de un aviso de privacidad publicado no se modifica: publica una versión nueva';
const MSG_ESTADO = 'El estado de un aviso de privacidad sólo avanza: borrador, vigente, retirado';
const MSG_ACEPTACION = 'Una aceptación del aviso de privacidad no se modifica';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── avisos ────────────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.privacy_notices (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      code          text        NOT NULL,
      version       integer     NOT NULL,
      status        text        NOT NULL DEFAULT 'borrador',
      title         text        NOT NULL,
      summary_text  text        NOT NULL,
      consent_text  text        NOT NULL,
      full_url      text,
      published_at  timestamptz,
      retired_at    timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    uuid,
      PRIMARY KEY (id),
      CONSTRAINT privacy_notices_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT privacy_notices_version_uk UNIQUE (tenant_id, code, version),
      CONSTRAINT privacy_notices_code_ck CHECK (code ~ '^[a-z][a-z0-9_]{0,29}$'),
      CONSTRAINT privacy_notices_version_ck CHECK (version >= 1),
      CONSTRAINT privacy_notices_status_ck CHECK (status IN ('borrador', 'vigente', 'retirado')),
      CONSTRAINT privacy_notices_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 120),
      CONSTRAINT privacy_notices_summary_ck CHECK (length(btrim(summary_text)) BETWEEN 20 AND 3000),
      CONSTRAINT privacy_notices_consent_ck CHECK (length(btrim(consent_text)) BETWEEN 10 AND 600),
      CONSTRAINT privacy_notices_url_ck CHECK (full_url IS NULL OR full_url ~ '^https?://'),
      CONSTRAINT privacy_notices_published_ck CHECK (status = 'borrador' OR published_at IS NOT NULL)
    )`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS privacy_notices_una_vigente_uk
      ON servicedesk.privacy_notices (tenant_id, code) WHERE status = 'vigente'`);
  await knex.raw(`ALTER TABLE servicedesk.privacy_notices ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.privacy_notices FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.privacy_notices`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.privacy_notices
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin DELETE: un aviso publicado es parte de la evidencia.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON servicedesk.privacy_notices TO app_runtime`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION servicedesk.privacy_notices_protege() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.status = 'vigente' AND NEW.published_at IS NULL THEN NEW.published_at := now(); END IF;
      IF NEW.status = 'retirado' AND NEW.retired_at IS NULL THEN NEW.retired_at := now(); END IF;
      IF TG_OP = 'UPDATE' THEN
        -- 1. El texto de un aviso que ya no es borrador no se edita.
        IF OLD.status <> 'borrador' AND (
             NEW.code IS DISTINCT FROM OLD.code OR NEW.version IS DISTINCT FROM OLD.version OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
             OR NEW.title IS DISTINCT FROM OLD.title OR NEW.summary_text IS DISTINCT FROM OLD.summary_text
             OR NEW.consent_text IS DISTINCT FROM OLD.consent_text OR NEW.full_url IS DISTINCT FROM OLD.full_url) THEN
          RAISE EXCEPTION '${MSG_TEXTO}' USING ERRCODE = '23514';
        END IF;
        -- 2. El estado sólo avanza (borrador -> vigente -> retirado; también borrador -> retirado).
        IF NEW.status <> OLD.status AND NOT (
             (OLD.status = 'borrador' AND NEW.status IN ('vigente', 'retirado')) OR (OLD.status = 'vigente' AND NEW.status = 'retirado')) THEN
          RAISE EXCEPTION '${MSG_ESTADO}' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_privacy_notices_protege ON servicedesk.privacy_notices`);
  await knex.raw(`
    CREATE TRIGGER trg_privacy_notices_protege BEFORE INSERT OR UPDATE ON servicedesk.privacy_notices
      FOR EACH ROW EXECUTE FUNCTION servicedesk.privacy_notices_protege()`);
  await knex.raw(`COMMENT ON TABLE servicedesk.privacy_notices IS 'PRV.2 — avisos de privacidad por código y versión (borrador, vigente, retirado). El texto publicado no se edita: se publica una versión nueva. Una sola vigente por código.'`);

  // ── aceptaciones ───────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.privacy_acceptances (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      notice_id   uuid        NOT NULL,
      user_id     uuid        NOT NULL,
      request_id  uuid,
      accepted_at timestamptz NOT NULL DEFAULT now(),
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      PRIMARY KEY (id),
      CONSTRAINT privacy_acceptances_uk UNIQUE (tenant_id, notice_id, user_id),
      CONSTRAINT privacy_acceptances_notice_fk FOREIGN KEY (tenant_id, notice_id) REFERENCES servicedesk.privacy_notices (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT privacy_acceptances_user_fk FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT privacy_acceptances_request_fk FOREIGN KEY (tenant_id, request_id) REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS privacy_acceptances_user_ix ON servicedesk.privacy_acceptances (tenant_id, user_id)`);
  await knex.raw(`ALTER TABLE servicedesk.privacy_acceptances ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.privacy_acceptances FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.privacy_acceptances`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.privacy_acceptances
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  // La evidencia: sólo se agrega y se lee. Ni UPDATE ni DELETE desde la API.
  await knex.raw(`GRANT SELECT, INSERT ON servicedesk.privacy_acceptances TO app_runtime`);
  await knex.raw(`
    CREATE OR REPLACE FUNCTION servicedesk.privacy_acceptances_inmutable() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      RAISE EXCEPTION '${MSG_ACEPTACION}' USING ERRCODE = '23514';
    END
    $fn$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_privacy_acceptances_inmutable ON servicedesk.privacy_acceptances`);
  await knex.raw(`
    CREATE TRIGGER trg_privacy_acceptances_inmutable BEFORE UPDATE ON servicedesk.privacy_acceptances
      FOR EACH ROW EXECUTE FUNCTION servicedesk.privacy_acceptances_inmutable()`);
  await knex.raw(`COMMENT ON TABLE servicedesk.privacy_acceptances IS 'PRV.2 — quién aceptó qué versión del aviso y cuándo. Evidencia: sólo INSERT y SELECT desde la API; el UPDATE lo rechaza un trigger. Una fila por (versión, persona).'`);

  // ── la cola ────────────────────────────────────────────────────────────────────────────────
  const tiene = await knex.schema.withSchema('servicedesk').hasColumn('queues', 'privacy_notice_code');
  if (!tiene) await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN privacy_notice_code text`);
  const ck = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = 'queues_privacy_notice_code_ck' AND conrelid = to_regclass('servicedesk.queues')`);
  if (!ck.rows.length) {
    await knex.raw(`ALTER TABLE servicedesk.queues ADD CONSTRAINT queues_privacy_notice_code_ck CHECK (privacy_notice_code IS NULL OR privacy_notice_code ~ '^[a-z][a-z0-9_]{0,29}$')`);
  }
  await knex.raw(`COMMENT ON COLUMN servicedesk.queues.privacy_notice_code IS 'PRV.2 — el código del aviso de privacidad que exige esta cola (NULL = ninguno). Levantar un ticket exige haber aceptado la versión vigente de ese aviso; si no hay una vigente, no se crea (fail-closed).'`);

  // eslint-disable-next-line no-console
  console.log(`  [PRV.2] privacy_notices + privacy_acceptances (RLS forzado, 2 triggers) · queues.privacy_notice_code ${tiene ? 'ya existía' : 'agregada'} · ninguna cola exige aviso todavía`);
};

exports.down = async function down(knex) {
  const hay = await knex.raw(`SELECT count(*)::int AS n FROM servicedesk.privacy_acceptances`).catch(() => ({ rows: [{ n: 0 }] }));
  if (hay.rows[0].n > 0) {
    throw new Error('PRV.2 down: ya hay aceptaciones del aviso de privacidad; borrarlas destruiría la prueba del consentimiento');
  }
  await knex.raw(`ALTER TABLE servicedesk.queues DROP CONSTRAINT IF EXISTS queues_privacy_notice_code_ck`);
  await knex.raw(`ALTER TABLE servicedesk.queues DROP COLUMN IF EXISTS privacy_notice_code`);
  await knex.raw(`DROP TABLE IF EXISTS servicedesk.privacy_acceptances`);
  await knex.raw(`DROP FUNCTION IF EXISTS servicedesk.privacy_acceptances_inmutable()`);
  await knex.raw(`DROP TABLE IF EXISTS servicedesk.privacy_notices`);
  await knex.raw(`DROP FUNCTION IF EXISTS servicedesk.privacy_notices_protege()`);
};
