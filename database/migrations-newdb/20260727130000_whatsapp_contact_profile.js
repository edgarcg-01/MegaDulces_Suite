/**
 * Fase FIQ.4 (ADR-036) — Memoria persistente del contacto de WhatsApp.
 *
 * Hoy la memoria del bot es solo los últimos 8 mensajes del hilo ABIERTO (se
 * pierde al cerrar en 'done'). Esta tabla guarda continuidad cross-sesión anclada
 * al teléfono E.164 canónico: última dirección de entrega (para "¿te lo mando a la
 * misma dirección?"), preferencias, resumen y últimas coords (para FIQ.5 geoloc).
 *
 * RLS forzado + tenant_id (regla dura). UNIQUE (tenant_id, whatsapp). Idempotente.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('whatsapp').hasTable('contact_profile'))) {
    await knex.raw(`
      CREATE TABLE whatsapp.contact_profile (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        whatsapp      varchar(20) NOT NULL,        -- MSISDN canónico 52XXXXXXXXXX
        customer_id   uuid,                        -- commercial.customers (si se resolvió)
        preferences   jsonb NOT NULL DEFAULT '{}',
        summary       text,
        last_address  jsonb,
        last_lat      numeric(9,6),
        last_lng      numeric(9,6),
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await knex.raw(`
      CREATE UNIQUE INDEX uq_wa_contact_profile
        ON whatsapp.contact_profile (tenant_id, whatsapp)
    `);
    await knex.raw(`ALTER TABLE whatsapp.contact_profile ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE whatsapp.contact_profile FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='whatsapp' AND tablename='contact_profile' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON whatsapp.contact_profile
            USING (tenant_id = public.current_tenant_id())
            WITH CHECK (tenant_id = public.current_tenant_id());
        END IF;
      END $$;
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp.contact_profile TO app_runtime`);
  }
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('whatsapp').dropTableIfExists('contact_profile');
};
