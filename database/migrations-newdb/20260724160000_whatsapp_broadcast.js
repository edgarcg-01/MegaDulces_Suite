/**
 * F.8 (ADR-034) — Envíos masivos de promos por WhatsApp con opt-in.
 *
 * Tres tablas en `whatsapp.*` (RLS forzado, patrón A.0mt):
 *   - marketing_optin: consentimiento por teléfono (opted_in/opted_out). Meta
 *     BANEA el número si mandás marketing sin opt-in → esto es la fuente de verdad
 *     de a quién se le puede mandar. Opt-out ("BAJA"/"STOP") lo marca opted_out.
 *   - campaigns: una campaña = plantilla aprobada + imagen + parámetros + estado.
 *   - campaign_recipients: fan-out por destinatario con estado (pending/sent/failed)
 *     para tracking. UNIQUE (campaign, phone) → idempotente ante reintentos.
 *
 * La plantilla DEBE estar aprobada en Meta (marketing). El envío va por la cola
 * (BullMQ si WHATSAPP_USE_BULLMQ=true, con rate-limit; in-process secuencial si no).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS whatsapp`);
  await knex.raw(`GRANT USAGE ON SCHEMA whatsapp TO app_runtime`);

  const rls = async (table) => {
    await knex.raw(`ALTER TABLE whatsapp.${table} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE whatsapp.${table} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='whatsapp' AND tablename='${table}' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON whatsapp.${table}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp.${table} TO app_runtime`);
  };

  // ── marketing_optin ─────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('whatsapp').hasTable('marketing_optin'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.marketing_optin (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        phone         text NOT NULL,                 -- E.164 sin '+'
        status        text NOT NULL DEFAULT 'opted_in'
                        CHECK (status IN ('opted_in','opted_out')),
        source        text NOT NULL DEFAULT 'bot'    -- 'bot' | 'manual' | 'import'
                        CHECK (source IN ('bot','manual','import')),
        opted_in_at   timestamptz,
        opted_out_at  timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, phone)
      )`);
    await knex.raw(`CREATE INDEX ix_wa_optin_status ON whatsapp.marketing_optin (tenant_id, status)`);
    await rls('marketing_optin');
  }

  // ── campaigns ───────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('whatsapp').hasTable('campaigns'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.campaigns (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        name           text NOT NULL,
        template_name  text NOT NULL,               -- plantilla de marketing aprobada en Meta
        language       text NOT NULL DEFAULT 'es_MX',
        image_url      text,                          -- header de imagen (opcional)
        body_params    jsonb NOT NULL DEFAULT '[]'::jsonb,
        status         text NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','sending','done','cancelled')),
        total          int NOT NULL DEFAULT 0,
        sent           int NOT NULL DEFAULT 0,
        failed         int NOT NULL DEFAULT 0,
        created_by     uuid,
        started_at     timestamptz,
        finished_at    timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id)
      )`);
    await rls('campaigns');
  }

  // ── campaign_recipients ─────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('whatsapp').hasTable('campaign_recipients'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.campaign_recipients (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        campaign_id    uuid NOT NULL,
        phone          text NOT NULL,
        status         text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','sent','failed')),
        wa_message_id  text,
        error          text,
        sent_at        timestamptz,
        created_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, campaign_id, phone),
        FOREIGN KEY (tenant_id, campaign_id)
          REFERENCES whatsapp.campaigns (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_wa_camp_rcpt ON whatsapp.campaign_recipients (tenant_id, campaign_id, status)`);
    await rls('campaign_recipients');
  }

  console.log('[whatsapp_broadcast] up · marketing_optin + campaigns + campaign_recipients (RLS)');
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.withSchema('whatsapp').dropTableIfExists('campaign_recipients');
  await knex.schema.withSchema('whatsapp').dropTableIfExists('campaigns');
  await knex.schema.withSchema('whatsapp').dropTableIfExists('marketing_optin');
};
