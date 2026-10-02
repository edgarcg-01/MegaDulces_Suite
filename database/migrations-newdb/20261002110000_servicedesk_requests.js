'use strict';
/**
 * `[MS.1.2]` — Mesa de Servicio: el TICKET (`requests`) y lo que cuelga de él. ADR-081.
 *
 * ── Cinco tablas ─────────────────────────────────────────────────────────────────────────────
 *  · `request_sequences`   — el consecutivo del folio `SRV-AAAA-NNNNN` por año. UPSERT atómico (mismo
 *                            patrón que `devtools.project_sequences` y `commercial.order_sequences`):
 *                            un `max()+1` choca con dos altas simultáneas.
 *  · `requests`            — **el ticket, y también la TAREA de quien lo atiende.** Lleva
 *                            `assigned_to/by/at`, por eso `test-newdb-task-contract.js` lo descubre y
 *                            exige declararlo en `FUENTES_TAREA`/`ADAPTADORES` (MS.1.5). Es lo
 *                            deseable: aparece en «A tu nombre» de Mi trabajo sin copiar nada.
 *  · `request_messages`    — el hilo: comentarios, cambios de estado/asignación/prioridad y NOTAS
 *                            INTERNAS que el solicitante jamás ve.
 *  · `request_attachments` — fotos y PDF. Tabla y no un jsonb, para poder VALIDAR tipo y tamaño y
 *                            firmar la URL en cada lectura. El binario vive en el bucket privado; acá
 *                            sólo la llave.
 *  · `work_log`            — tiempo trabajado por ticket. Es la paridad con la Bitácora de Sistemas,
 *                            cuyo KPI central es el tiempo y que hoy es lo único que no vive en la Suite.
 *
 * ── Dos mejoras sobre el molde (`finance.recon_tasks`) ───────────────────────────────────────
 *  1. `assigned_by` es **uuid** y se une al padrón. En `recon_tasks` es TEXT y la fuente declara
 *     «no se puede unir contra identity.users».
 *  2. Los estados NO viven sólo en un CHECK: viven en una **máquina** con invariantes entre columnas
 *     (abajo). Un ticket «asignado» sin asignado, o «en espera» sin reloj pausado, es un dato que
 *     miente, y la base lo rechaza en vez de confiar en que la capa de lógica no se equivoque.
 *
 * ── Invariantes que la base hace cumplir (con prueba negativa en el smoke, MS.1.6) ────────────
 *   · `asignado`/`en_proceso` ⇒ hay asignado.   · `assigned_to` y `assigned_at` van juntos.
 *   · `en_espera` ⇔ `paused_at` no nulo (el reloj del SLA está pausado exactamente cuando está en espera).
 *   · `resuelto`/`cerrado` ⇒ `resolved_at`.     · `cerrado`/`cancelado` ⇒ `closed_at` + `close_reason`.
 *   · una nota interna sólo puede ser `internal`.
 *   · el hilo no admite comentarios vacíos; el adjunto sólo imagen o PDF y con tamaño > 0.
 *
 * ── Qué NO se puede hacer (grants por tabla; ver la solicitud §4.2) ───────────────────────────
 * El hilo, los adjuntos, el tiempo y el folio son REGISTRO: `app_runtime` no tiene UPDATE ni DELETE
 * sobre `request_messages`/`request_attachments`/`work_log`. `requests` no tiene DELETE: un ticket
 * no se borra, se cancela. (`deleted_at` queda para correcciones administrativas por conexión
 * privilegiada, nunca desde la API.)
 *
 * Aditiva e idempotente. RLS forzado. FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

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
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.request_sequences (
      tenant_id    uuid    NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      year         integer NOT NULL,
      last_number  integer NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, year),
      CONSTRAINT request_sequences_year_ck CHECK (year BETWEEN 2000 AND 2999),
      CONSTRAINT request_sequences_num_ck CHECK (last_number >= 0)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.requests (
      id                          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id                   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      folio                       text        NOT NULL,
      queue_id                    uuid        NOT NULL,
      category_id                 uuid        NOT NULL,
      title                       text        NOT NULL,
      description                 text        NOT NULL DEFAULT '',
      priority                    text        NOT NULL DEFAULT 'media',
      priority_suggested          text,
      impact                      text        NOT NULL DEFAULT 'yo',
      blocks_work                 boolean     NOT NULL DEFAULT false,
      status                      text        NOT NULL DEFAULT 'nuevo',
      -- Quién reporta: el uuid se une al padrón; el snapshot sobrevive a que la ficha cambie después.
      requester_id                uuid        NOT NULL,
      requester_name              text,
      requester_department_code   varchar(50),
      requester_position_code     varchar(50),
      warehouse_code              varchar(20),
      channel                     text        NOT NULL DEFAULT 'web',
      -- Quién lo atiende. Es el contrato de tarea: assigned_(to|by|at), con assigned_by UUID.
      assigned_to                 uuid,
      assigned_by                 uuid,
      assigned_at                 timestamptz,
      -- Plazos y reloj del SLA.
      due_at                      timestamptz,
      first_response_due_at       timestamptz,
      first_responded_at          timestamptz,
      paused_at                   timestamptz,
      paused_minutes              integer     NOT NULL DEFAULT 0,
      sla_first_breached_at       timestamptz,
      sla_resolution_breached_at  timestamptz,
      escalated_at                timestamptz,
      -- Cierre.
      resolved_at                 timestamptz,
      resolved_by                 uuid,
      resolution_note             text,
      closed_at                   timestamptz,
      closed_by                   uuid,
      close_reason                text,
      reopened_count              integer     NOT NULL DEFAULT 0,
      -- Puente con otros sistemas (p. ej. {"bitacora_folio": "..."}). Vacío por defecto.
      external_refs               jsonb       NOT NULL DEFAULT '{}'::jsonb,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT requests_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT requests_folio_uk UNIQUE (tenant_id, folio),
      CONSTRAINT requests_folio_ck CHECK (folio ~ '^SRV-[0-9]{4}-[0-9]{5}$'),
      CONSTRAINT requests_title_ck CHECK (length(btrim(title)) BETWEEN 1 AND 200),
      CONSTRAINT requests_status_ck CHECK (status IN
        ('nuevo','asignado','en_proceso','en_espera','resuelto','cerrado','cancelado')),
      CONSTRAINT requests_priority_ck CHECK (priority IN ('baja','media','alta','urgente')),
      CONSTRAINT requests_priority_sug_ck CHECK (priority_suggested IS NULL
        OR priority_suggested IN ('baja','media','alta','urgente')),
      CONSTRAINT requests_impact_ck CHECK (impact IN ('yo','varios','sucursal','red')),
      CONSTRAINT requests_channel_ck CHECK (channel IN ('web','vendor','public_link','whatsapp','bitacora')),
      CONSTRAINT requests_close_reason_ck CHECK (close_reason IS NULL
        OR close_reason IN ('confirmado','auto','cancelado')),
      CONSTRAINT requests_paused_minutes_ck CHECK (paused_minutes >= 0),
      CONSTRAINT requests_reopened_ck CHECK (reopened_count >= 0),
      CONSTRAINT requests_external_refs_ck CHECK (jsonb_typeof(external_refs) = 'object'),
      -- ── La máquina de estados, con sus invariantes entre columnas ──
      CONSTRAINT requests_assigned_pair_ck CHECK ((assigned_to IS NULL) = (assigned_at IS NULL)),
      CONSTRAINT requests_assigned_state_ck CHECK (status NOT IN ('asignado','en_proceso') OR assigned_to IS NOT NULL),
      CONSTRAINT requests_paused_state_ck CHECK ((status = 'en_espera') = (paused_at IS NOT NULL)),
      CONSTRAINT requests_resolved_state_ck CHECK (status NOT IN ('resuelto','cerrado') OR resolved_at IS NOT NULL),
      CONSTRAINT requests_closed_state_ck CHECK (status NOT IN ('cerrado','cancelado')
        OR (closed_at IS NOT NULL AND close_reason IS NOT NULL)),
      CONSTRAINT requests_cancel_reason_ck CHECK (status <> 'cancelado' OR close_reason = 'cancelado'),
      CONSTRAINT requests_closed_reason_ck CHECK (status <> 'cerrado' OR close_reason IN ('confirmado','auto')),
      CONSTRAINT requests_queue_fk FOREIGN KEY (tenant_id, queue_id)
        REFERENCES servicedesk.queues (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT requests_category_fk FOREIGN KEY (tenant_id, category_id)
        REFERENCES servicedesk.categories (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT requests_requester_fk FOREIGN KEY (tenant_id, requester_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT requests_assigned_to_fk FOREIGN KEY (tenant_id, assigned_to)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT requests_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);

  // Los accesos reales: la bandeja (por estado), «mías» (por asignado), «mis solicitudes» (por
  // solicitante), el barrido del SLA (por vencimiento) y los reportes por sucursal.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_req_abiertos ON servicedesk.requests (tenant_id, queue_id, priority, created_at)
                  WHERE deleted_at IS NULL AND status NOT IN ('cerrado','cancelado')`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_req_asignado ON servicedesk.requests (tenant_id, assigned_to, status)
                  WHERE deleted_at IS NULL AND assigned_to IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_req_solicitante ON servicedesk.requests (tenant_id, requester_id, created_at DESC)
                  WHERE deleted_at IS NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_req_vencimiento ON servicedesk.requests (tenant_id, due_at)
                  WHERE deleted_at IS NULL AND status NOT IN ('resuelto','cerrado','cancelado') AND due_at IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_req_sucursal ON servicedesk.requests (tenant_id, warehouse_code, created_at DESC)
                  WHERE deleted_at IS NULL AND warehouse_code IS NOT NULL`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.request_messages (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      request_id    uuid        NOT NULL,
      kind          text        NOT NULL,
      visibility    text        NOT NULL DEFAULT 'public',
      author_id     uuid,
      author_label  text,
      body          text        NOT NULL DEFAULT '',
      meta          jsonb       NOT NULL DEFAULT '{}'::jsonb,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT request_messages_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT request_messages_kind_ck CHECK (kind IN
        ('comment','status','assignment','priority','system','internal_note')),
      CONSTRAINT request_messages_visibility_ck CHECK (visibility IN ('public','internal')),
      -- Una nota interna JAMÁS puede ser pública: es el fallo más caro de esta fase.
      CONSTRAINT request_messages_internal_ck CHECK (kind <> 'internal_note' OR visibility = 'internal'),
      CONSTRAINT request_messages_body_ck CHECK (kind NOT IN ('comment','internal_note') OR length(btrim(body)) > 0),
      CONSTRAINT request_messages_meta_ck CHECK (jsonb_typeof(meta) = 'object'),
      CONSTRAINT request_messages_request_fk FOREIGN KEY (tenant_id, request_id)
        REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT request_messages_author_fk FOREIGN KEY (tenant_id, author_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_msg_request ON servicedesk.request_messages (tenant_id, request_id, created_at)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.request_attachments (
      id            uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      request_id    uuid        NOT NULL,
      message_id    uuid,
      storage_key   text        NOT NULL,
      file_name     text        NOT NULL,
      content_type  text        NOT NULL,
      size_bytes    bigint      NOT NULL,
      uploaded_by   uuid,
      created_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT request_attachments_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT request_attachments_key_ck CHECK (length(btrim(storage_key)) > 0),
      CONSTRAINT request_attachments_name_ck CHECK (length(btrim(file_name)) > 0),
      CONSTRAINT request_attachments_size_ck CHECK (size_bytes > 0),
      -- Sólo imagen o PDF: la base lo exige aunque la capa de lógica ya lo valide por firma.
      CONSTRAINT request_attachments_type_ck CHECK (content_type ~ '^(image/(jpeg|png|webp|gif|heic)|application/pdf)$'),
      CONSTRAINT request_attachments_request_fk FOREIGN KEY (tenant_id, request_id)
        REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT request_attachments_message_fk FOREIGN KEY (tenant_id, message_id)
        REFERENCES servicedesk.request_messages (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT request_attachments_uploader_fk FOREIGN KEY (tenant_id, uploaded_by)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_att_request ON servicedesk.request_attachments (tenant_id, request_id)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.work_log (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      request_id  uuid        NOT NULL,
      user_id     uuid        NOT NULL,
      minutes     integer     NOT NULL,
      started_at  timestamptz,
      ended_at    timestamptz,
      source      text        NOT NULL DEFAULT 'suite',
      note        text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT work_log_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT work_log_minutes_ck CHECK (minutes > 0 AND minutes <= 1440),
      CONSTRAINT work_log_source_ck CHECK (source IN ('suite','bitacora')),
      CONSTRAINT work_log_span_ck CHECK (started_at IS NULL OR ended_at IS NULL OR ended_at >= started_at),
      CONSTRAINT work_log_request_fk FOREIGN KEY (tenant_id, request_id)
        REFERENCES servicedesk.requests (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT work_log_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_work_request ON servicedesk.work_log (tenant_id, request_id)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_work_user ON servicedesk.work_log (tenant_id, user_id, created_at DESC)`);

  // Grants por tabla: el REGISTRO no se edita ni se borra desde la API.
  await proteger(knex, 'request_sequences', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'requests', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'request_messages', 'SELECT, INSERT');
  await proteger(knex, 'request_attachments', 'SELECT, INSERT');
  await proteger(knex, 'work_log', 'SELECT, INSERT');

  await knex.raw(`COMMENT ON TABLE servicedesk.requests IS 'MS.1.2 — el ticket y, a la vez, la TAREA de quien lo atiende (contrato de tarea: assigned_(to|by|at), assigned_by uuid). Un ticket no se borra: se cancela.'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.request_messages IS 'MS.1.2 — hilo del ticket. internal_note nunca es público (CHECK). Registro: sin UPDATE ni DELETE para app_runtime.'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.request_attachments IS 'MS.1.2 — fotos/PDF. Tabla (no jsonb) para validar tipo y tamaño y firmar la URL en cada lectura. El binario vive en el bucket privado.'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.work_log IS 'MS.1.2 — tiempo trabajado por ticket; paridad con la Bitácora de Sistemas. source=bitacora reserva la unificación (MS.8).'`);
  await knex.raw(`COMMENT ON TABLE servicedesk.request_sequences IS 'MS.1.2 — consecutivo del folio SRV-AAAA-NNNNN por año (UPSERT atómico).'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.paused_minutes IS 'Minutos del reloj de la política acumulados en pausa (en_espera). Se descuentan del plazo.'`);
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.priority_suggested IS 'Lo que el sistema sugirió (categoría × impacto × bloqueo). priority es lo que confirmó quien atiende; sólo agente/coordinador fija alta y urgente.'`);
  // eslint-disable-next-line no-console
  console.log('  [MS.1.2] servicedesk: requests + request_messages + request_attachments + work_log + request_sequences');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS servicedesk.work_log');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.request_attachments');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.request_messages');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.requests');
  await knex.raw('DROP TABLE IF EXISTS servicedesk.request_sequences');
};
