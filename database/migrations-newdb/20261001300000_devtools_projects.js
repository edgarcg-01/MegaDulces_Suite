'use strict';
/**
 * `[DEV.0]` — Desarrolladores › Proyectos: la bitácora de proyectos del equipo de desarrollo.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 * Pedido de Sistemas (2026-10-01): *«cuando se nos ocurre un nuevo proyecto no lo escribimos»*.
 * Cada idea se da de alta como una ORDEN — folio `DEV-AAAA-NNNN`, nombre, objetivo y responsable —
 * y su objetivo se documenta con texto (escrito o dictado) más evidencia adjunta: documentos de
 * cualquier tipo, fotos tomadas con la cámara y video.
 *
 * Es **dato propio capturado por una persona (HITL)**: ninguna fuente del ERP lo tiene, así que la
 * regla «derivar del ODS» no aplica y la tabla es legítima (mismo caso que `floor_stockouts`).
 *
 * ── Cuatro tablas ────────────────────────────────────────────────────────────────────────────
 *  · `dev_team`             — a quién se le puede asignar un proyecto. NO es una lista escrita en
 *                             el frontend: es una tabla, para que sumar o quitar a alguien no pida
 *                             un despliegue. Nace con las tres personas que pidió Sistemas.
 *  · `projects`             — la orden. `assignee_user_id` se valida contra `dev_team` en el
 *                             servicio (no por FK: dar de baja a alguien del equipo no debe borrar
 *                             ni dejar huérfanos los proyectos que ya tuvo).
 *  · `project_attachments`  — un renglón por archivo. El binario vive en el bucket privado
 *                             (`ObjectStorageService`), acá sólo la llave y lo que se sabe de él.
 *  · `project_sequences`    — el consecutivo del folio por año (UPSERT atómico, mismo patrón que
 *                             `commercial.order_sequences`). Un `max()+1` choca con dos altas a la vez.
 *
 * ── El equipo se resuelve por NOMBRE, no por UUID ────────────────────────────────────────────
 * Un UUID escrito acá sólo vale en la base donde se copió. Las tres personas se buscan en
 * `identity.users` por su nombre (sin acentos ni mayúsculas) y, para Edgar, también por su
 * usuario `edgar_cortes` — medido en `platform_local` el 2026-10-01 su registro no trae `nombre`.
 * ⚠️ Quien no se encuentre NO se inventa: se registra con `RAISE NOTICE` y queda fuera. El
 * `display_name` lleva el nombre completo tal como lo dio Sistemas, para que el selector no dependa
 * de que el registro del usuario esté bien capturado.
 *
 * Aditiva e idempotente. RLS forzado + grant `app_runtime`. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT_MEGA_DULCES = '00000000-0000-0000-0000-00000000d01c';

/** Las tres personas del equipo (pedido de Sistemas 2026-10-01). `patron` es regex sobre el nombre
 *  normalizado (minúsculas, sin acentos); `usuarios` es el respaldo por `username`. */
const EQUIPO = [
  { display: 'Edgar Dayan Cortés García', patron: 'edgar.*cortes', usuarios: ['edgar_cortes'], orden: 1 },
  { display: 'Ángel David Cisneros Salazar', patron: 'david.*cisneros.*salazar', usuarios: ['david_cisneros'], orden: 2 },
  { display: 'Luis Francisco López Gutiérrez', patron: 'luis francisco.*lopez.*gutierrez', usuarios: [], orden: 3 },
];

const TABLAS = ['dev_team', 'projects', 'project_attachments', 'project_sequences'];

exports.up = async function up(knex) {
  await knex.raw('CREATE SCHEMA IF NOT EXISTS devtools');
  await knex.raw('GRANT USAGE ON SCHEMA devtools TO app_runtime');

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS devtools.dev_team (
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      user_id       uuid        NOT NULL REFERENCES identity.users (id) ON DELETE CASCADE,
      display_name  text        NOT NULL,
      sort_order    integer     NOT NULL DEFAULT 100,
      active        boolean     NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      created_by    uuid,
      updated_at    timestamptz NOT NULL DEFAULT now(),
      updated_by    uuid,
      PRIMARY KEY (tenant_id, user_id),
      CONSTRAINT dev_team_display_ck CHECK (length(btrim(display_name)) > 0)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS devtools.projects (
      id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id            uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      folio                text        NOT NULL,
      title                text        NOT NULL,
      -- El objetivo: instrucciones escritas o dictadas. Puede ir vacío al dar de alta (la idea se
      -- anota primero y se documenta después), por eso NULL y no ''.
      objective            text,
      priority             text        NOT NULL DEFAULT 'media',
      status               text        NOT NULL DEFAULT 'nuevo',
      assignee_user_id     uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      due_date             date,
      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      created_by_username  text,
      updated_at           timestamptz NOT NULL DEFAULT now(),
      updated_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      deleted_at           timestamptz,
      deleted_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      PRIMARY KEY (id),
      CONSTRAINT projects_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT projects_folio_uk UNIQUE (tenant_id, folio),
      CONSTRAINT projects_title_ck CHECK (length(btrim(title)) > 0),
      CONSTRAINT projects_priority_ck CHECK (priority IN ('baja','media','alta','urgente')),
      CONSTRAINT projects_status_ck CHECK (status IN ('nuevo','en_progreso','en_pausa','terminado','cancelado'))
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_devprojects_lista ON devtools.projects (tenant_id, created_at DESC) WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_devprojects_assignee ON devtools.projects (tenant_id, assignee_user_id) WHERE deleted_at IS NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS devtools.project_attachments (
      id                   uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id            uuid        NOT NULL,
      project_id           uuid        NOT NULL,
      -- Qué ES el archivo (para pintarlo): se deriva del MIME al subir.
      kind                 text        NOT NULL,
      -- Cómo LLEGÓ: subido de un archivo, tomado con la cámara, o grabado en pantalla.
      source               text        NOT NULL DEFAULT 'archivo',
      file_name            text        NOT NULL,
      mime_type            text        NOT NULL,
      size_bytes           bigint      NOT NULL,
      storage_key          text        NOT NULL,
      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      created_by_username  text,
      deleted_at           timestamptz,
      deleted_by           uuid        REFERENCES identity.users (id) ON DELETE SET NULL,
      PRIMARY KEY (id),
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, project_id) REFERENCES devtools.projects (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT attachments_kind_ck CHECK (kind IN ('documento','imagen','video','audio')),
      CONSTRAINT attachments_source_ck CHECK (source IN ('archivo','camara','grabacion')),
      CONSTRAINT attachments_size_ck CHECK (size_bytes > 0)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_devattach_project ON devtools.project_attachments (tenant_id, project_id) WHERE deleted_at IS NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS devtools.project_sequences (
      tenant_id    uuid    NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      year         integer NOT NULL,
      last_number  integer NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, year)
    )`);

  for (const t of TABLAS) {
    await knex.raw(`ALTER TABLE devtools.${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE devtools.${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON devtools.${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON devtools.${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON devtools.${t} TO app_runtime`);
  }
  await knex.raw(`COMMENT ON TABLE devtools.projects IS 'DEV.0 — bitácora de proyectos del equipo de desarrollo (orden con folio DEV-AAAA-NNNN). Dato propio HITL.'`);
  await knex.raw(`COMMENT ON TABLE devtools.dev_team IS 'DEV.0 — a quién se le puede asignar un proyecto. Editable sin despliegue.'`);

  // ── Siembra del equipo. Sólo si el tenant existe en esta base. ─────────────────────────────
  const tenant = await knex.raw('SELECT 1 FROM identity.tenants WHERE id = ?', [TENANT_MEGA_DULCES]);
  if (!tenant.rows.length) return;
  // La política es FORZADA: si quien migra no es superusuario, el INSERT sin tenant en sesión
  // choca con el WITH CHECK. `set_config(..., true)` lo deja sólo para esta transacción.
  await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [TENANT_MEGA_DULCES]);
  const norm = `translate(lower(coalesce(u.nombre,'')), 'áéíóúüñ', 'aeiouun')`;
  for (const p of EQUIPO) {
    const r = await knex.raw(
      `SELECT u.id FROM identity.users u
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL
          AND (${norm} ~ ? OR u.username = ANY(?::text[]))
        ORDER BY (${norm} ~ ?) DESC, u.created_at
        LIMIT 1`,
      [TENANT_MEGA_DULCES, p.patron, p.usuarios, p.patron],
    );
    const userId = r.rows[0]?.id;
    if (!userId) {
      await knex.raw(`DO $$ BEGIN RAISE NOTICE 'DEV.0: no se encontró a % en identity.users — queda fuera del equipo'; END $$`.replace('%', p.display.replace(/'/g, "''")));
      continue;
    }
    await knex.raw(
      `INSERT INTO devtools.dev_team (tenant_id, user_id, display_name, sort_order)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [TENANT_MEGA_DULCES, userId, p.display, p.orden],
    );
  }
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS devtools.project_attachments');
  await knex.raw('DROP TABLE IF EXISTS devtools.project_sequences');
  await knex.raw('DROP TABLE IF EXISTS devtools.projects');
  await knex.raw('DROP TABLE IF EXISTS devtools.dev_team');
  await knex.raw('DROP SCHEMA IF EXISTS devtools');
};
