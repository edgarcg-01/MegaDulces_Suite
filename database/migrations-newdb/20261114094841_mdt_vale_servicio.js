'use strict';
/**
 * `[MDT.1.5]` El vale de servicio de MDTask como dominio propio de la Suite (D8, D8b).
 *
 * En MDTask el vale (su código lo llama «ticket») es la constancia de un servicio que una persona atiende
 * y firma: quién lo pidió, qué se hizo, con qué materiales, y tres firmas (realizado, revisado, recibido).
 * NO es la Mesa de Servicio (Edgar, D8: «la mesa de servicio es muy independiente»), y la tabla no se
 * llama `tickets` (ADR-081). En pantalla sigue siendo «Vale de servicio».
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · El vale de MDTask (código del clon, sin base): una tabla sin llaves ni CHECK; folio = el mayor + 1
 *    FUERA de transacción (dos altas a la vez → la segunda da 500), arrancando en 513 para continuar el
 *    talonario; cualquiera con acceso hace cualquier transición; las firmas no son obligatorias y se
 *    podían quitar ya cerrado; cada cambio pisa la fila (no hay historial).
 *  · Prod (2026-11-14): el puesto `jefe_mantenimiento` tiene 1 persona con rol `administrativo`, y ese rol
 *    lo comparten 7 puestos más → repartir «atender» por ese rol se la daría a todos (D8b: no se hace).
 *  · Uso del vale en MDTask: NO MEDIDO (el censo `[MDT.0.1]` lo corre David).
 *
 * ── Las tablas (schema `platform`, como el motor de checklist: es un dominio entre áreas) ─────
 *  · `work_order_sequences` el consecutivo del folio por tenant, SIN año (el de MDTask es corrido).
 *                           UPSERT atómico dentro de la transacción del alta (patrón de
 *                           `servicedesk.request_sequences`). Contador PROPIO: el de pedidos lo comparten
 *                           cinco documentos y salta números; un vale impreso va consecutivo.
 *  · `work_orders`          el vale y, a la vez, la TAREA de quien lo atiende: `assigned_(to|by|at)` →
 *                           `FUENTES_TAREA` (`test-newdb-task-contract.js` lo exige).
 *  · `work_order_signatures` las firmas como evidencia: el trazo va al bucket; quitar = apartar.
 *  · `work_order_events`    el historial: sólo se inserta. Reabrir ya no borra el cierre anterior.
 *
 * ── Invariantes que cobra la BASE (no la pantalla) ─────────────────────────────────────────
 *  · abierto ⇒ sin responsable ni inicio; en proceso o completado ⇒ con responsable e inicio.
 *  · completado ⇔ `completed_at`, y exige el detalle del trabajo; cancelado ⇔ `cancelled_at`, con motivo.
 *  · el folio no cambia nunca (trigger); un vale completado no pierde firmas (trigger, D8b).
 *  · una firma viva por papel y vale; ninguna obligatoria para cerrar (D8b: la opción reversible).
 *  · sin DELETE para `app_runtime`: un vale no se borra, se cancela.
 *
 * ── Llaves: PILOTO (mismo motivo que `[MDT.2.5]`) ──────────────────────────────────────────
 *  `VALE_SERVICIO_LEVANTAR` / `_ATENDER` / `_GESTIONAR` sólo a Dirección, RH y superadmin hasta el corte.
 *  La persona a la que se le ASIGNA un vale lo trabaja por ser la asignada, sin llave extra. El reparto
 *  amplio (levantar: todo rol con personas; atender: un rol propio de Mantenimiento) es del corte `[MDT.C2]`.
 *
 * Aditiva e idempotente. RLS forzado. FKs compuestas `(tenant_id, …)`.
 *
 * @param { import("knex").Knex } knex
 */

const PILOTO = ['direccion', 'superadmin', 'recursos_humanos'];
const LLAVES = ['VALE_SERVICIO_LEVANTAR', 'VALE_SERVICIO_ATENDER', 'VALE_SERVICIO_GESTIONAR'];

const AUDIT = `
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  deleted_at timestamptz,
  deleted_by uuid`;

async function proteger(knex, tabla, privilegios) {
  await knex.raw(`ALTER TABLE platform.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE platform.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON platform.${tabla}`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON platform.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT ${privilegios} ON platform.${tabla} TO app_runtime`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('CREATE SCHEMA IF NOT EXISTS platform');
  await knex.raw('GRANT USAGE ON SCHEMA platform TO app_runtime');

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.work_order_sequences (
      tenant_id    uuid    NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      last_number  integer NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id),
      CONSTRAINT work_order_sequences_num_ck CHECK (last_number >= 0)
    )`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.work_orders (
      id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id          uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      folio              integer     NOT NULL,
      status             text        NOT NULL DEFAULT 'open',
      service_date       date        NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Mexico_City')::date),
      requesting_area    text        NOT NULL,
      warehouse_code     varchar(20),
      location_detail    text,
      requested_by       uuid,
      requester_name     text        NOT NULL,
      assigned_to        uuid,
      assigned_by        uuid,
      assigned_at        timestamptz,
      supervisor_id      uuid,
      supervisor_name    text,
      activity           text        NOT NULL,
      work_detail        text,
      materials_used     text,
      outcome            text,
      follow_up_notes    text,
      general_notes      text,
      needs_follow_up    boolean,
      started_at         timestamptz,
      completed_at       timestamptz,
      cancelled_at       timestamptz,
      cancelled_by       uuid,
      cancel_reason      text,
      source             text        NOT NULL DEFAULT 'suite',
      source_ref         text,
      ${AUDIT},
      PRIMARY KEY (id),
      CONSTRAINT work_orders_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT work_orders_folio_uk UNIQUE (tenant_id, folio),
      CONSTRAINT work_orders_folio_ck CHECK (folio > 0),
      CONSTRAINT work_orders_status_ck CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
      CONSTRAINT work_orders_area_ck CHECK (length(btrim(requesting_area)) BETWEEN 1 AND 120),
      CONSTRAINT work_orders_requester_ck CHECK (length(btrim(requester_name)) BETWEEN 1 AND 120),
      CONSTRAINT work_orders_activity_ck CHECK (length(btrim(activity)) BETWEEN 1 AND 300),
      CONSTRAINT work_orders_textos_ck CHECK (
        coalesce(length(work_detail), 0) <= 4000 AND coalesce(length(materials_used), 0) <= 4000
        AND coalesce(length(outcome), 0) <= 4000 AND coalesce(length(follow_up_notes), 0) <= 4000
        AND coalesce(length(general_notes), 0) <= 4000 AND coalesce(length(location_detail), 0) <= 200),
      CONSTRAINT work_orders_assign_pair_ck CHECK ((assigned_to IS NULL) = (assigned_at IS NULL)),
      CONSTRAINT work_orders_open_ck CHECK (status <> 'open' OR (assigned_to IS NULL AND started_at IS NULL)),
      -- MDTask dejaba cerrar sin responsable: lo cargado de allá entra tal cual y se declara (source).
      CONSTRAINT work_orders_working_ck CHECK (
        status NOT IN ('in_progress', 'completed') OR source = 'mdtask'
        OR (assigned_to IS NOT NULL AND started_at IS NOT NULL)),
      CONSTRAINT work_orders_completed_ck CHECK (
        (status = 'completed') = (completed_at IS NOT NULL)
        AND (status <> 'completed' OR length(btrim(coalesce(work_detail, ''))) > 0)),
      CONSTRAINT work_orders_cancelled_ck CHECK (
        (status = 'cancelled') = (cancelled_at IS NOT NULL)
        AND (status <> 'cancelled' OR length(btrim(coalesce(cancel_reason, ''))) > 0)),
      CONSTRAINT work_orders_source_ck CHECK (source IN ('suite', 'mdtask') AND ((source = 'mdtask') = (source_ref IS NOT NULL))),
      CONSTRAINT work_orders_requested_by_fk FOREIGN KEY (tenant_id, requested_by) REFERENCES identity.users (tenant_id, id),
      CONSTRAINT work_orders_assigned_to_fk FOREIGN KEY (tenant_id, assigned_to) REFERENCES identity.users (tenant_id, id),
      CONSTRAINT work_orders_assigned_by_fk FOREIGN KEY (tenant_id, assigned_by) REFERENCES identity.users (tenant_id, id),
      CONSTRAINT work_orders_supervisor_fk FOREIGN KEY (tenant_id, supervisor_id) REFERENCES identity.users (tenant_id, id)
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS work_orders_source_ref_uk
    ON platform.work_orders (tenant_id, source_ref) WHERE source_ref IS NOT NULL`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS work_orders_assigned_ix
    ON platform.work_orders (tenant_id, assigned_to) WHERE status IN ('open', 'in_progress')`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS work_orders_status_ix ON platform.work_orders (tenant_id, status, folio DESC)`);

  // El folio no cambia nunca: es lo que se imprime y se busca.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION platform.work_orders_folio_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.folio IS DISTINCT FROM OLD.folio THEN
        RAISE EXCEPTION 'el folio de un vale no cambia (% → %)', OLD.folio, NEW.folio USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw('DROP TRIGGER IF EXISTS work_orders_folio_inmutable_tg ON platform.work_orders');
  await knex.raw(`CREATE TRIGGER work_orders_folio_inmutable_tg BEFORE UPDATE ON platform.work_orders
    FOR EACH ROW EXECUTE FUNCTION platform.work_orders_folio_inmutable()`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.work_order_signatures (
      id              uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id       uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      work_order_id   uuid        NOT NULL,
      role            text        NOT NULL,
      signer_name     text        NOT NULL,
      signer_user_id  uuid,
      storage_key     text        NOT NULL,
      mime            text        NOT NULL,
      size_bytes      integer     NOT NULL,
      signed_on       date        NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Mexico_City')::date),
      signed_at       timestamptz DEFAULT now(),
      captured_by     uuid,
      created_at      timestamptz NOT NULL DEFAULT now(),
      deleted_at      timestamptz,
      deleted_by      uuid,
      PRIMARY KEY (id),
      CONSTRAINT work_order_signatures_role_ck CHECK (role IN ('performed', 'reviewed', 'received')),
      CONSTRAINT work_order_signatures_name_ck CHECK (length(btrim(signer_name)) BETWEEN 1 AND 120),
      CONSTRAINT work_order_signatures_mime_ck CHECK (mime IN ('image/png', 'image/jpeg')),
      CONSTRAINT work_order_signatures_size_ck CHECK (size_bytes > 0),
      CONSTRAINT work_order_signatures_key_uk UNIQUE (tenant_id, storage_key),
      CONSTRAINT work_order_signatures_del_ck CHECK ((deleted_at IS NULL) = (deleted_by IS NULL)),
      CONSTRAINT work_order_signatures_wo_fk FOREIGN KEY (tenant_id, work_order_id)
        REFERENCES platform.work_orders (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT work_order_signatures_signer_fk FOREIGN KEY (tenant_id, signer_user_id) REFERENCES identity.users (tenant_id, id)
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS work_order_signatures_vivas_uk
    ON platform.work_order_signatures (tenant_id, work_order_id, role) WHERE deleted_at IS NULL`);

  // D8b: una firma no se quita de un vale completado (en MDTask sí se podía).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION platform.work_order_signatures_no_quitar_cerrado() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (
          SELECT 1 FROM platform.work_orders w
           WHERE w.tenant_id = NEW.tenant_id AND w.id = NEW.work_order_id AND w.status = 'completed') THEN
        RAISE EXCEPTION 'una firma no se quita de un vale completado' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw('DROP TRIGGER IF EXISTS work_order_signatures_no_quitar_cerrado_tg ON platform.work_order_signatures');
  await knex.raw(`CREATE TRIGGER work_order_signatures_no_quitar_cerrado_tg BEFORE UPDATE ON platform.work_order_signatures
    FOR EACH ROW EXECUTE FUNCTION platform.work_order_signatures_no_quitar_cerrado()`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS platform.work_order_events (
      id              uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id       uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      work_order_id   uuid        NOT NULL,
      kind            text        NOT NULL,
      from_status     text,
      to_status       text,
      note            text,
      actor           uuid,
      at              timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (id),
      CONSTRAINT work_order_events_kind_ck CHECK (kind IN (
        'created', 'assigned', 'taken', 'updated', 'completed', 'cancelled', 'reopened', 'signed', 'signature_removed')),
      CONSTRAINT work_order_events_note_ck CHECK (
        kind NOT IN ('cancelled', 'reopened') OR length(btrim(coalesce(note, ''))) > 0),
      CONSTRAINT work_order_events_wo_fk FOREIGN KEY (tenant_id, work_order_id)
        REFERENCES platform.work_orders (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS work_order_events_wo_ix ON platform.work_order_events (tenant_id, work_order_id, at)`);

  await proteger(knex, 'work_order_sequences', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'work_orders', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'work_order_signatures', 'SELECT, INSERT, UPDATE');
  await proteger(knex, 'work_order_events', 'SELECT, INSERT');

  await knex.raw(`COMMENT ON TABLE platform.work_orders IS 'MDT.1.5 — el vale de servicio (de MDTask) y, a la vez, la TAREA de quien lo atiende (contrato de tarea: assigned_(to|by|at), assigned_by uuid). No se borra: se cancela.'`);

  // ── Las tres llaves, en PILOTO. Tabla real `identity.role_permissions`. ──────────────────
  const marcas = PILOTO.map(() => '?').join(',');
  for (const llave of LLAVES) {
    await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, role_name IN (${marcas}))
        WHERE permissions -> ?::text IS NULL
          AND role_name NOT LIKE 'retirado%'
          AND deleted_at IS NULL`,
      [llave, ...PILOTO, llave],
    );
    const { rows } = await knex.raw(
      `SELECT role_name FROM identity.role_permissions
        WHERE permissions -> ?::text = 'true'::jsonb AND role_name <> 'superadmin' AND deleted_at IS NULL ORDER BY 1`,
      [llave],
    );
    const { rows: [hay] } = await knex.raw('SELECT count(*)::int n FROM identity.role_permissions WHERE deleted_at IS NULL');
    if (hay.n > 0 && !rows.length) {
      throw new Error(`Ningún rol (fuera de superadmin) quedó con ${llave}: la pantalla nacería sin dueño (regla 20)`);
    }
    // eslint-disable-next-line no-console
    console.log(`  [MDT.2.3] ${llave}: en true → ${rows.length} rol(es): ${rows.map((r) => r.role_name).join(', ') || '(ninguno)'}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const llave of LLAVES) {
    await knex.raw(
      `UPDATE identity.role_permissions SET permissions = permissions - ?::text WHERE permissions -> ?::text IS NOT NULL`,
      [llave, llave],
    );
  }
  await knex.raw('DROP TABLE IF EXISTS platform.work_order_events');
  await knex.raw('DROP TABLE IF EXISTS platform.work_order_signatures');
  await knex.raw('DROP TABLE IF EXISTS platform.work_orders');
  await knex.raw('DROP TABLE IF EXISTS platform.work_order_sequences');
  await knex.raw('DROP FUNCTION IF EXISTS platform.work_orders_folio_inmutable()');
  await knex.raw('DROP FUNCTION IF EXISTS platform.work_order_signatures_no_quitar_cerrado()');
};
