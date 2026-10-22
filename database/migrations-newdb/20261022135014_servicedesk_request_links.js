'use strict';
/**
 * `[MS.ADJ.2.1]` Enlaces de Google (Docs, Hojas, Presentaciones, Formularios, Drive) como adjunto de una solicitud.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 * Decisión D1 (`FASE_MS_ADJUNTOS`): a la Mesa sólo se suben imágenes y PDF; lo demás se COMPARTE por enlace de Google. El
 * enlace no es un archivo (no tiene tipo, tamaño ni bucket), así que no cabe en `request_attachments`: tabla propia,
 * de la misma forma (ligada al ticket y al mensaje, inmutable) para que la visibilidad se decida con la MISMA regla.
 *
 * ── Qué exige la base (aunque la capa de lógica ya valide, `domain/enlaces.ts`) ───────────────
 *  · `url` https y de EXACTAMENTE `docs.google.com` o `drive.google.com` (nada de `docs.google.com.evil.com` ni `@`),
 *    sin espacios, ≤ 500 caracteres;
 *  · `kind` de la lista cerrada.
 * Registro: sólo `SELECT, INSERT` para `app_runtime` (como los adjuntos: no se edita ni se borra desde la API). RLS por tenant.
 *
 * Aditiva: no toca ninguna tabla existente. Va ANTES del código que la lee y la escribe.
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.request_links (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      request_id  uuid        NOT NULL,
      message_id  uuid,
      url         text        NOT NULL,
      kind        text        NOT NULL,
      created_by  uuid,
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT request_links_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT request_links_url_ck CHECK (
        length(url) <= 500
        AND url ~ '^https://(docs|drive)\\.google\\.com/[^[:space:]@]*$'
      ),
      CONSTRAINT request_links_kind_ck CHECK (kind IN ('documento','hoja','presentacion','formulario','archivo','carpeta')),
      CONSTRAINT request_links_request_fk FOREIGN KEY (tenant_id, request_id)
        REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT request_links_message_fk FOREIGN KEY (tenant_id, message_id)
        REFERENCES servicedesk.request_messages (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT request_links_creator_fk FOREIGN KEY (tenant_id, created_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_links_request ON servicedesk.request_links (tenant_id, request_id)`);

  await knex.raw(`ALTER TABLE servicedesk.request_links ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.request_links FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.request_links`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.request_links
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT ON servicedesk.request_links TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE servicedesk.request_links IS 'MS.ADJ.2.1 — enlaces de Google (docs/drive) adjuntos a un ticket o mensaje. La URL es canónica (la normaliza domain/enlaces.ts); el servidor nunca la pide. Registro: sin UPDATE ni DELETE.'`);
  // eslint-disable-next-line no-console
  console.log('  [MS.ADJ.2.1] servicedesk.request_links');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS servicedesk.request_links');
};
