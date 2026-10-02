'use strict';
/**
 * `[DEV.10]` — Seguimiento de proyectos: notas, modificaciones y el rastro de cada cambio.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Pedido de Sistemas (2026-10-01): *«que a proyectos ya hechos se les agreguen notas o
 * modificaciones»*. Editar el proyecto ya era posible, pero editar **pisa**: el objetivo viejo,
 * el responsable anterior y el «por qué se cambió» se perdían. Lo que faltaba no era poder
 * editar, era la HISTORIA.
 *
 * Una entrada por hecho, en orden de tiempo:
 *  · `nota`          — un comentario, un avance, una aclaración. La escribe (o dicta) una persona.
 *  · `modificacion`  — un cambio que se pide sobre lo ya hecho. Misma forma que la nota; se separa
 *                      porque es la que alguien tiene que ATENDER, y en la pantalla se distingue.
 *  · `cambio`        — lo escribe el SERVIDOR al editar el proyecto: qué campo, de qué a qué.
 *                      `changes` guarda el detalle estructurado; `body` el resumen legible.
 *
 * Las entradas no se editan: una nota corregida es otra nota. Sí se pueden dar de baja
 * (`deleted_at`), salvo las de tipo `cambio`, que son el rastro y no se tocan desde la API.
 *
 * Los adjuntos de una nota viven en la MISMA tabla de adjuntos (`note_id` nullable): un archivo
 * es un archivo, y separarlos en dos tablas duplicaría la subida, la firma y la baja.
 *
 * Aditiva e idempotente. RLS forzado + grant `app_runtime`. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS devtools.project_notes (
      id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id            uuid        NOT NULL,
      project_id           uuid        NOT NULL,
      kind                 text        NOT NULL,
      body                 text        NOT NULL,
      changes              jsonb,
      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      created_by_username  text,
      deleted_at           timestamptz,
      deleted_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      PRIMARY KEY (id),
      CONSTRAINT project_notes_tenant_id_uk UNIQUE (tenant_id, id),
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, project_id) REFERENCES devtools.projects (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT project_notes_kind_ck CHECK (kind IN ('nota','modificacion','cambio')),
      CONSTRAINT project_notes_body_ck CHECK (length(btrim(body)) > 0),
      -- Sólo el rastro automático trae detalle estructurado; una nota de persona no lo inventa.
      CONSTRAINT project_notes_changes_ck CHECK ((kind = 'cambio') = (changes IS NOT NULL))
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_devnotes_project ON devtools.project_notes (tenant_id, project_id, created_at DESC) WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE devtools.project_notes ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE devtools.project_notes FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON devtools.project_notes`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON devtools.project_notes
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON devtools.project_notes TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE devtools.project_notes IS 'DEV.10 — seguimiento del proyecto: notas, modificaciones pedidas y el rastro automático de cada cambio.'`);

  if (!(await knex.schema.withSchema('devtools').hasColumn('project_attachments', 'note_id'))) {
    await knex.raw(`ALTER TABLE devtools.project_attachments ADD COLUMN note_id uuid`);
    await knex.raw(`
      ALTER TABLE devtools.project_attachments
        ADD CONSTRAINT attachments_note_fk FOREIGN KEY (tenant_id, note_id)
        REFERENCES devtools.project_notes (tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_devattach_note ON devtools.project_attachments (tenant_id, note_id) WHERE note_id IS NOT NULL AND deleted_at IS NULL`);
  }
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE devtools.project_attachments DROP CONSTRAINT IF EXISTS attachments_note_fk');
  await knex.raw('ALTER TABLE devtools.project_attachments DROP COLUMN IF EXISTS note_id');
  await knex.raw('DROP TABLE IF EXISTS devtools.project_notes');
};
