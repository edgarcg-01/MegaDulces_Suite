'use strict';
/**
 * `[MS.1.3]` — Mesa de Servicio: AVISOS y datos de contacto. ADR-081.
 *
 * ── El hueco que cierra ───────────────────────────────────────────────────────────────────────
 * Hoy NO existe forma de avisar a una persona por correo ni por WhatsApp: `identity.users` no tiene
 * ni email ni teléfono (`MAILER_PORT` lo dice en su propio encabezado). El teléfono normalizado
 * (`public.mx_normalize_phone`, canónico `52XXXXXXXXXX`) existe pero sólo se usa para CLIENTES.
 *
 * ── Tres piezas ──────────────────────────────────────────────────────────────────────────────
 *  · `identity.users.email` / `.phone` — opcionales. Se declara el formato en la base.
 *  · `notification_prefs`  — por usuario: correo sí/no, WhatsApp sí/no y **CUÁNDO aceptó WhatsApp**.
 *                            El canal exige consentimiento explícito: el CHECK hace imposible activar
 *                            WhatsApp sin la fecha de aceptación.
 *  · `notification_log`    — CADA aviso, con su resultado. Mide ENTREGA, no intención (ADR-053): es lo
 *                            que permite que la pantalla diga «aviso no enviado» en vez de fingir que
 *                            llegó (ADR-056: lo que no se pudo medir se DECLARA). Y es el canal `app`:
 *                            el worker —donde corren los crons— no tiene WebSocket (ADR-080), así que
 *                            lo que nace en el SLA o en el auto-cierre sale por correo/WhatsApp **y**
 *                            deja una fila `app` que la campana recoge por poll.
 *
 * ── ⚠️ `identity.users` es una tabla caliente ────────────────────────────────────────────────
 * Un `ALTER TABLE ... ADD COLUMN` espera el lock y **encola a todos detrás de sí** (tumba el login):
 * ya encoló 11 sesiones sobre `role_permissions` (GOTCHAS §38). Por eso `SET LOCAL lock_timeout = '3s'`
 * —si no consigue el lock en 3 s falla limpio y se reintenta, en vez de bloquear— y guarda
 * `hasColumn`. Las columnas son NULL sin default: en PG 11+ es un cambio de catálogo, sin reescribir.
 *
 * ⛔ **`down()` NO borra `email` ni `phone`**: regla del proyecto, «no borrar columnas sin pedir
 * confirmación». Quitarlas es una decisión de una persona, no de un rollback automático.
 *
 * Aditiva e idempotente. RLS forzado en las tablas nuevas.
 *
 * @param { import("knex").Knex } knex
 */

async function proteger(knex, tabla, privilegios) {
  await knex.raw(`ALTER TABLE servicedesk.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT ${privilegios} ON servicedesk.${tabla} TO app_runtime`);
}

exports.up = async function up(knex) {
  // ── 1. Datos de contacto en identity.users ────────────────────────────────────────────────
  // SET LOCAL vive lo que dura la transacción de la migración: no contamina la conexión del pool.
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const tieneEmail = await knex.schema.withSchema('identity').hasColumn('users', 'email');
  const tienePhone = await knex.schema.withSchema('identity').hasColumn('users', 'phone');
  if (!tieneEmail) await knex.raw(`ALTER TABLE identity.users ADD COLUMN email text`);
  if (!tienePhone) await knex.raw(`ALTER TABLE identity.users ADD COLUMN phone text`);

  const checks = await knex.raw(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'identity.users'::regclass AND conname IN ('users_email_fmt_ck','users_phone_fmt_ck')`);
  const ya = new Set(checks.rows.map((r) => r.conname));
  if (!ya.has('users_email_fmt_ck')) {
    await knex.raw(`ALTER TABLE identity.users ADD CONSTRAINT users_email_fmt_ck
      CHECK (email IS NULL OR email ~* '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$')`);
  }
  if (!ya.has('users_phone_fmt_ck')) {
    // Canónico de `mx_normalize_phone`: 52 + 10 dígitos. La capa de lógica normaliza ANTES de guardar.
    await knex.raw(`ALTER TABLE identity.users ADD CONSTRAINT users_phone_fmt_ck
      CHECK (phone IS NULL OR phone ~ '^52[0-9]{10}$')`);
  }
  await knex.raw(`COMMENT ON COLUMN identity.users.email IS 'MS.1.3 — correo para avisos (opcional). Antes no existía forma de avisar a una persona.'`);
  await knex.raw(`COMMENT ON COLUMN identity.users.phone IS 'MS.1.3 — teléfono canónico 52XXXXXXXXXX (public.mx_normalize_phone) para WhatsApp. Opcional. Usarlo exige notification_prefs.whatsapp_opt_in_at.'`);

  // ── 2. Preferencias de aviso ──────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.notification_prefs (
      tenant_id           uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      user_id             uuid        NOT NULL,
      email_enabled       boolean     NOT NULL DEFAULT true,
      whatsapp_enabled    boolean     NOT NULL DEFAULT false,
      whatsapp_opt_in_at  timestamptz,
      created_at          timestamptz NOT NULL DEFAULT now(),
      updated_at          timestamptz NOT NULL DEFAULT now(),
      updated_by          uuid,
      PRIMARY KEY (tenant_id, user_id),
      -- El consentimiento no es opcional: WhatsApp encendido SIN fecha de aceptación no puede existir.
      CONSTRAINT notification_prefs_optin_ck CHECK (NOT whatsapp_enabled OR whatsapp_opt_in_at IS NOT NULL),
      CONSTRAINT notification_prefs_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE CASCADE
    )`);

  // ── 3. Registro de cada aviso ─────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.notification_log (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      request_id    uuid,
      recipient_id  uuid        NOT NULL,
      event         text        NOT NULL,
      channel       text        NOT NULL,
      status        text        NOT NULL,
      error         text,
      dedup_key     text,
      payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at    timestamptz NOT NULL DEFAULT now(),
      sent_at       timestamptz,
      PRIMARY KEY (id),
      CONSTRAINT notification_log_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT notification_log_event_ck CHECK (length(btrim(event)) > 0),
      CONSTRAINT notification_log_channel_ck CHECK (channel IN ('app','email','whatsapp')),
      CONSTRAINT notification_log_status_ck CHECK (status IN ('sent','failed','skipped')),
      -- Un aviso enviado tiene hora de envío; uno fallido tiene motivo. Lo demás sería un dato mudo.
      CONSTRAINT notification_log_sent_ck CHECK (status <> 'sent' OR sent_at IS NOT NULL),
      CONSTRAINT notification_log_failed_ck CHECK (status NOT IN ('failed','skipped') OR error IS NOT NULL),
      CONSTRAINT notification_log_payload_ck CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT notification_log_request_fk FOREIGN KEY (tenant_id, request_id)
        REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT notification_log_recipient_fk FOREIGN KEY (tenant_id, recipient_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  // Anti-repetición: un mismo evento a una misma persona por un mismo canal se ENVÍA una sola vez.
  // Sólo cuenta lo 'sent': un intento fallido debe poder reintentarse.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sd_notif_dedup ON servicedesk.notification_log (tenant_id, dedup_key, channel)
                  WHERE dedup_key IS NOT NULL AND status = 'sent'`);
  // La campana (canal app) lee lo suyo, lo más nuevo primero.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_notif_app ON servicedesk.notification_log (tenant_id, recipient_id, created_at DESC)
                  WHERE channel = 'app'`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_notif_request ON servicedesk.notification_log (tenant_id, request_id, created_at)
                  WHERE request_id IS NOT NULL`);

  await proteger(knex, 'notification_prefs', 'SELECT, INSERT, UPDATE, DELETE');
  await proteger(knex, 'notification_log', 'SELECT, INSERT');

  await knex.raw(`COMMENT ON TABLE servicedesk.notification_prefs IS 'MS.1.3 — preferencias de aviso por usuario. whatsapp_enabled exige whatsapp_opt_in_at (consentimiento explícito).'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.notification_log IS 'MS.1.3 — cada aviso con su resultado (entrega, no intención). channel=app es lo que la campana recoge por poll: el worker no emite por WebSocket. Registro: sin UPDATE ni DELETE.'`);
  // eslint-disable-next-line no-console
  console.log('  [MS.1.3] identity.users.email/phone + servicedesk.notification_prefs + notification_log');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS servicedesk.notification_log');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.notification_prefs');
  // ⛔ NO se borran identity.users.email / .phone: «no borrar columnas sin pedir confirmación».
  // Quitar las dos columnas es decisión de una persona. Las restricciones de formato sí quedan.
  // eslint-disable-next-line no-console
  console.log('  [MS.1.3] down: las columnas identity.users.email/phone se CONSERVAN a propósito (requieren confirmación para borrarse)');
};
