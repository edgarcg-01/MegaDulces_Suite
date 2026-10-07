'use strict';
/**
 * `[MS.7.1]` — Mesa de Servicio multi-área: QUIÉN atiende QUÉ cola. `FASE_MS7_MANTENIMIENTO.md` (decisión M1).
 *
 * ── Qué es y por qué es un DATO ──────────────────────────────────────────────────────────────
 * Hasta hoy `SERVICIO_ATENDER` / `SERVICIO_COORDINAR` eran claves GLOBALES: cualquiera que las tuviera veía los
 * tickets de TODAS las colas (`puedeVer = esAgente || solicitante`). Para sumar Mantenimiento, RH y las demás áreas
 * sin que cada una vea los tickets de la otra, el «dónde» pasa a esta tabla y las claves siguen siendo la
 * «capacidad» (puede atender / puede repartir):
 *
 *     poder efectivo sobre un ticket  =  capacidad (clave)  ∩  pertenencia a SU cola (esta tabla)
 *
 * Se rechazó una clave por área (`SERVICIO_MANTENIMIENTO_ATENDER`): obligaría a tocar el enum, el árbol de permisos y
 * los roles por cada departamento, o sea el `if (cola === …)` que la regla 1 de la fase prohíbe. Efecto colateral:
 * **no hay permisos nuevos → nadie necesita volver a iniciar sesión.**
 *
 * ── Roles ────────────────────────────────────────────────────────────────────────────────────
 *  · `coordinador` — el responsable del área: reparte, reasigna y administra a los miembros de SU cola.
 *  · `tecnico`     — atiende los tickets de la cola.
 *
 * ── Backfill (lo que impide que alguien pierda acceso) ────────────────────────────────────────
 * Quien hoy atiende TI (permiso EFECTIVO de `SERVICIO_ATENDER` o `SERVICIO_COORDINAR`, con el MISMO cálculo que
 * `agents.service.ts`: el override de la persona gana, y si no hay, la unión de sus roles) se respalda como miembro de
 * la cola `ti`; `coordinador` si tiene `SERVICIO_COORDINAR`. ⚠️ **Esta migración se aplica ANTES de desplegar el
 * código que filtra por cola**: con la tabla vacía, nadie vería ningún ticket. Es aditiva: el código viejo la ignora.
 *
 * ── Dos columnas de la cola que la misma fase necesita ───────────────────────────────────────
 *  · `default_assignee_id` — el responsable por omisión del área (NULL = los tickets sin regla quedan «Sin asignar»).
 *  · `priority_model`      — `impacto` (el de hoy; TI no cambia) o `riesgo_operacion` (la matriz de Mantenimiento).
 *    Se elige por este VALOR configurado, nunca por el nombre de la cola. Nace sólo la columna; la lógica llega en MS.7.7.
 *
 * Aditiva, idempotente y reversible. RLS forzado + grants por tabla a `app_runtime` (sin DELETE: quitar a alguien es
 * `active = false`, y la fila conserva quién y cuándo). FKs compuestas `(tenant_id, id)`.
 *
 * @param { import("knex").Knex } knex
 */

/** `identity.users u` tiene permiso efectivo `?`: el override de la persona manda; si no hay, la unión de sus roles. */
const EFECTIVO = `COALESCE(
  (SELECT up.allow FROM identity.user_permissions up
    WHERE up.tenant_id = u.tenant_id AND up.user_id = u.id AND up.permission_key = '%KEY%'),
  EXISTS (
    SELECT 1
      FROM (SELECT ur.role_name FROM identity.user_roles ur WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id
            UNION SELECT u.role_name) roles
      JOIN identity.role_permissions rp ON rp.tenant_id = u.tenant_id AND lower(rp.role_name) = lower(roles.role_name)
     WHERE rp.permissions ->> '%KEY%' = 'true'
  )
)`;
const efectivo = (key) => EFECTIVO.split('%KEY%').join(key);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.queue_members (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      queue_id    uuid        NOT NULL,
      user_id     uuid        NOT NULL,
      role        text        NOT NULL DEFAULT 'tecnico',
      active      boolean     NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid,
      PRIMARY KEY (id),
      CONSTRAINT queue_members_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT queue_members_pair_uk UNIQUE (tenant_id, queue_id, user_id),
      CONSTRAINT queue_members_role_ck CHECK (role IN ('coordinador','tecnico')),
      CONSTRAINT queue_members_queue_fk FOREIGN KEY (tenant_id, queue_id)
        REFERENCES servicedesk.queues (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT queue_members_user_fk FOREIGN KEY (tenant_id, user_id)
        REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT
    )`);
  await knex.raw(`ALTER TABLE servicedesk.queue_members ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.queue_members FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.queue_members`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.queue_members
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON servicedesk.queue_members TO app_runtime`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_qmembers_user ON servicedesk.queue_members (tenant_id, user_id) WHERE active`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sd_qmembers_queue ON servicedesk.queue_members (tenant_id, queue_id) WHERE active`);
  await knex.raw(
    `COMMENT ON TABLE servicedesk.queue_members IS 'MS.7.1 — quién atiende qué cola (coordinador | tecnico). La clave SERVICIO_* es la CAPACIDAD; esta tabla dice DÓNDE. Poder efectivo = clave ∩ pertenencia. Quitar = active=false (sin DELETE).'`,
  );

  const tieneAsignado = await knex.schema.withSchema('servicedesk').hasColumn('queues', 'default_assignee_id');
  if (!tieneAsignado) {
    await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN default_assignee_id uuid`);
    await knex.raw(`
      ALTER TABLE servicedesk.queues ADD CONSTRAINT queues_default_assignee_fk
        FOREIGN KEY (tenant_id, default_assignee_id) REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT`);
  }
  const tieneModelo = await knex.schema.withSchema('servicedesk').hasColumn('queues', 'priority_model');
  if (!tieneModelo) {
    await knex.raw(`ALTER TABLE servicedesk.queues ADD COLUMN priority_model text NOT NULL DEFAULT 'impacto'`);
    await knex.raw(`
      ALTER TABLE servicedesk.queues ADD CONSTRAINT queues_priority_model_ck
        CHECK (priority_model IN ('impacto','riesgo_operacion'))`);
  }
  await knex.raw(
    `COMMENT ON COLUMN servicedesk.queues.default_assignee_id IS 'MS.7.1 — responsable por omisión del área: los tickets sin regla le caen a esta persona. NULL = quedan «Sin asignar» y los ven los miembros.'`,
  );
  await knex.raw(
    `COMMENT ON COLUMN servicedesk.queues.priority_model IS 'MS.7.1 — qué matriz sugiere la prioridad: impacto (el de TI) o riesgo_operacion. Se elige por este VALOR, nunca por el nombre de la cola. La lógica llega en MS.7.7.'`,
  );

  // ── Backfill: quien hoy atiende TI sigue atendiendo TI ────────────────────────────────────────
  const { rowCount } = await knex.raw(
    `INSERT INTO servicedesk.queue_members (tenant_id, queue_id, user_id, role)
     SELECT u.tenant_id, q.id, u.id,
            CASE WHEN ${efectivo('SERVICIO_COORDINAR')} THEN 'coordinador' ELSE 'tecnico' END
       FROM identity.users u
       JOIN servicedesk.queues q ON q.tenant_id = u.tenant_id AND q.code = 'ti' AND q.deleted_at IS NULL
      WHERE u.deleted_at IS NULL
        AND COALESCE(u.kind, 'interno') <> 'servicio'
        AND (${efectivo('SERVICIO_ATENDER')} OR ${efectivo('SERVICIO_COORDINAR')})
     ON CONFLICT (tenant_id, queue_id, user_id) DO NOTHING`,
  );
  // eslint-disable-next-line no-console
  console.log(`  [MS.7.1] queue_members creada · columnas de la cola (${tieneAsignado ? 'ya estaban' : 'default_assignee_id'} / ${tieneModelo ? 'ya estaba' : 'priority_model'}) · backfill a TI: ${rowCount ?? 0} persona(s)`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE servicedesk.queues DROP CONSTRAINT IF EXISTS queues_priority_model_ck`);
  await knex.raw(`ALTER TABLE servicedesk.queues DROP COLUMN IF EXISTS priority_model`);
  await knex.raw(`ALTER TABLE servicedesk.queues DROP CONSTRAINT IF EXISTS queues_default_assignee_fk`);
  await knex.raw(`ALTER TABLE servicedesk.queues DROP COLUMN IF EXISTS default_assignee_id`);
  await knex.raw('DROP TABLE IF EXISTS servicedesk.queue_members');
};
