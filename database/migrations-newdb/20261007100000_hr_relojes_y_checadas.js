/**
 * Fase RH · capa de datos de asistencia (1 de 3) — relojes, enrolamientos y checadas.
 *
 * Extiende el schema `hr.*` de la Fase CH (`20260817220000_hr_attendance.js`) con lo que
 * Mega Talento ya opera en producción y CH no tenía. ADR-084: la asistencia de Mega Talento
 * y la de la Suite eran el MISMO dato visto por dos equipos (el "sistema del proveedor" del
 * que leía el agente de Mega Talento era la base `hr` de CH), así que se EXTIENDE, no se
 * crea un segundo esquema.
 *
 * Qué agrega:
 *   0. `hr.attendance_sites`: el sitio de checado (relojes que comparten la numeración de
 *      personas). No es un almacén: corporativo y CEDIS son el mismo almacén 00 y sus códigos
 *      chocarían. Todas las tablas de RH que llevan `site_code` apuntan aquí.
 *   1. `hr.attendance_devices`: cómo entra cada reloj (`ingest_mode`), si está en pausa
 *      (`is_paused`: sus marcas no se aplican hasta mapear sus códigos) y el latido del
 *      lector (`last_punch_at`, `last_backfill_at`, `seen_ip`, `logs_in_db`, `agent_*`).
 *      En Mega Talento eso vivía repartido en `relojes` + `relojes_estado`.
 *   2. `hr.device_enrollments.user_id` → `identity.users`. ADR-084 D1/D2: la persona es el
 *      usuario de la Suite (`[OR.0]`); `employee_id` → `hr.employees` queda por compatibilidad
 *      y se retira en otra migración, con confirmación (no se borran columnas sin pedirlo).
 *   3. `hr.attendance_logs.user_id` (denormalizado, como `employee_id`) y `source`
 *      (agente / push / manual / carga_unica): la carga histórica tiene que poder distinguirse
 *      de lo que entró vivo.
 *   4. `hr.device_commands`: órdenes al reloj (borrar / renombrar / restaurar usuario). Son
 *      irreversibles en el equipo, por eso guardan el respaldo del usuario antes de tocarlo.
 *   5. `hr.ingest_batches`: el lote crudo tal como llegó. Si el serial no está registrado o el
 *      reloj está en pausa, el lote se guarda SIN aplicar y se puede reprocesar; reintentar no
 *      lo resuelve (lección de Mega Talento: un 409 o un 202 no se reintentan).
 *
 * Convención A.0mt: tenant_id + composite FK + RLS forzado + grants app_runtime. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS hr`);

  const rls = async (table) => {
    await knex.raw(`ALTER TABLE hr.${table} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE hr.${table} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='hr' AND tablename='${table}' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON hr.${table}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON hr.${table} TO app_runtime`);
  };
  const addColumn = async (table, column, ddl) => {
    if (!(await knex.schema.withSchema('hr').hasColumn(table, column))) {
      await knex.raw(`ALTER TABLE hr.${table} ADD COLUMN ${column} ${ddl}`);
    }
  };

  // ── 0) Sitios de checado ────────────────────────────────────────────────────
  // Un sitio es el conjunto de relojes que comparten la misma numeración de personas (el
  // "sucursal_id" de Mega Talento: corporativo tiene dos relojes con los mismos códigos). NO es
  // un almacén: corporativo y CEDIS son el almacén 00 de Kepler y sus códigos chocarían si el
  // sitio fuera el almacén. Cada sitio apunta a su almacén en `warehouse_code`.
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_sites'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_sites (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        code            text NOT NULL,                     -- 'corporativo', 'cedis', 'morelia-abastos'…
        name            text NOT NULL,
        warehouse_code  text,                              -- código Kepler del almacén (00, 01, …); lo valida RH
        is_active       boolean NOT NULL DEFAULT true,
        notes           text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        created_by      uuid,
        updated_at      timestamptz NOT NULL DEFAULT now(),
        updated_by      uuid,
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, code),
        CONSTRAINT attendance_sites_code_ck CHECK (code ~ '^[a-z0-9][a-z0-9-]*$')
      )`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_sites IS 'Fase RH: sitio de checado = relojes que comparten numeración de personas. No es un almacén; apunta a uno (warehouse_code).'`);
    await rls('attendance_sites');
  }
  // El `site_code` de los relojes (Fase CH) pasa a apuntar a un sitio. NOT VALID: lo que ya
  // exista no se valida (en prod la tabla está vacía; en desarrollo puede traer valores viejos),
  // pero todo lo nuevo sí.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_devices_site_fk') THEN
        ALTER TABLE hr.attendance_devices
          ADD CONSTRAINT attendance_devices_site_fk
          FOREIGN KEY (tenant_id, site_code) REFERENCES hr.attendance_sites (tenant_id, code)
          ON UPDATE CASCADE NOT VALID;
      END IF;
    END $$`);

  // ── 1) Relojes: modo de entrada, pausa y latido del lector ──────────────────
  await addColumn('attendance_devices', 'ingest_mode',
    `text NOT NULL DEFAULT 'agente' CHECK (ingest_mode IN ('agente','push','manual'))`);
  await addColumn('attendance_devices', 'is_paused', `boolean NOT NULL DEFAULT false`);
  await addColumn('attendance_devices', 'notes', `text`);
  await addColumn('attendance_devices', 'last_punch_at', `timestamptz`);
  await addColumn('attendance_devices', 'last_backfill_at', `timestamptz`);
  await addColumn('attendance_devices', 'seen_ip', `text`);
  await addColumn('attendance_devices', 'logs_in_db', `integer`);
  await addColumn('attendance_devices', 'agent_version', `text`);
  await addColumn('attendance_devices', 'agent_host', `text`);
  await addColumn('attendance_devices', 'updated_by', `uuid`);

  // ── 2) Enrolamiento → persona de la Suite ───────────────────────────────────
  await addColumn('device_enrollments', 'user_id', `uuid`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_enrollments_user_fk') THEN
        ALTER TABLE hr.device_enrollments
          ADD CONSTRAINT device_enrollments_user_fk
          FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE SET NULL;
      END IF;
    END $$`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_hr_enr_user ON hr.device_enrollments (tenant_id, user_id)`);
  // El código con el que la lógica de asistencia conoce a la persona DENTRO de su sitio.
  // Casi siempre es el mismo `device_user_id`; cambia cuando un reloj numera distinto a la
  // misma gente (en Mega Talento eso era `reloj_codigo_map`: el reloj de comida de
  // corporativo traía otra numeración). NULL = usar `device_user_id` tal cual.
  await addColumn('device_enrollments', 'person_code', `text`);

  // ── 3) Checadas: persona de la Suite + de dónde vino la marca ───────────────
  await addColumn('attendance_logs', 'user_id', `uuid`);
  await addColumn('attendance_logs', 'source',
    `text NOT NULL DEFAULT 'agente' CHECK (source IN ('agente','push','manual','carga_unica'))`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_logs_user_fk') THEN
        ALTER TABLE hr.attendance_logs
          ADD CONSTRAINT attendance_logs_user_fk
          FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE SET NULL;
      END IF;
    END $$`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_hr_log_user ON hr.attendance_logs (tenant_id, user_id, punched_at DESC)`);

  // ── 4) Órdenes al reloj ─────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('device_commands'))) {
    await knex.raw(`
      CREATE TABLE hr.device_commands (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        device_id       uuid NOT NULL,
        device_user_id  text NOT NULL,                     -- el usuario del reloj sobre el que se actúa
        command         text NOT NULL CHECK (command IN ('borrar','renombrar','restaurar')),
        payload         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- p. ej. el nombre nuevo
        status          text NOT NULL DEFAULT 'pendiente'
                          CHECK (status IN ('pendiente','enviado','hecho','error','cancelado')),
        attempts        integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
        detail          text,                              -- lo que contestó el reloj o el agente
        backup          jsonb,                             -- el usuario tal como estaba ANTES de tocarlo
        requested_by    uuid,
        requested_at    timestamptz NOT NULL DEFAULT now(),
        completed_at    timestamptz,
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, device_id) REFERENCES hr.attendance_devices (tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT device_commands_done_ck CHECK ((status IN ('hecho','error','cancelado')) = (completed_at IS NOT NULL))
      )`);
    await knex.raw(`CREATE INDEX ix_hr_cmd_pending ON hr.device_commands (tenant_id, device_id, requested_at) WHERE status IN ('pendiente','enviado')`);
    await knex.raw(`COMMENT ON TABLE hr.device_commands IS 'Fase RH: órdenes al reloj (borrar/renombrar/restaurar). Irreversibles en el equipo: backup guarda el usuario antes de tocarlo. Máximo 3 intentos.'`);
    await rls('device_commands');
  }

  // ── 5) Lotes crudos de ingesta ──────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('ingest_batches'))) {
    await knex.raw(`
      CREATE TABLE hr.ingest_batches (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        device_id       uuid,                              -- NULL si el serial no está registrado
        serial_number   text NOT NULL,
        source          text NOT NULL CHECK (source IN ('agente','push','manual','carga_unica')),
        received_at     timestamptz NOT NULL DEFAULT now(),
        records         integer NOT NULL DEFAULT 0,
        accepted        integer NOT NULL DEFAULT 0,
        status          text NOT NULL
                          CHECK (status IN ('aplicado','sin_registrar','en_pausa','error')),
        raw             jsonb,                             -- el lote tal como llegó; sólo si NO se aplicó
        error           text,
        reprocessed_at  timestamptz,
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, device_id) REFERENCES hr.attendance_devices (tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT ingest_batches_counts_ck CHECK (accepted BETWEEN 0 AND records),
        -- Lo aplicado ya está en attendance_logs: guardar el crudo cada vez sería una copia
        -- (un respaldo completo de un reloj son ~50 mil checadas, cada hora). Sólo se guarda
        -- cuando NO se pudo aplicar, que es cuando hace falta para reprocesar.
        CONSTRAINT ingest_batches_raw_ck CHECK (status = 'aplicado' OR raw IS NOT NULL)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_batch_recent ON hr.ingest_batches (tenant_id, received_at DESC)`);
    await knex.raw(`CREATE INDEX ix_hr_batch_pending ON hr.ingest_batches (tenant_id, serial_number) WHERE status IN ('sin_registrar','en_pausa') AND reprocessed_at IS NULL`);
    await knex.raw(`COMMENT ON TABLE hr.ingest_batches IS 'Fase RH: lote crudo como llegó del lector. Un serial sin registrar o en pausa se guarda sin aplicar y se reprocesa; no se reintenta.'`);
    await rls('ingest_batches');
  }

  // ── 6) Checadas vistas por sitio ────────────────────────────────────────────
  // La forma exacta con la que trabaja la lógica de asistencia de Mega Talento (su tabla
  // `checadas`): sitio, código de la persona en el sitio, fecha y hora de pared. Derivada,
  // no copiada: si cambia el mapeo de un enrolamiento, cambia aquí sin migrar nada.
  // `security_invoker` para que respete el RLS de quien consulta.
  await knex.raw(`
    CREATE OR REPLACE VIEW hr.v_site_punches WITH (security_invoker = true) AS
    SELECT
      l.tenant_id,
      d.site_code,
      COALESCE(e.person_code, l.device_user_id)              AS person_code,
      COALESCE(e.user_id, l.user_id)                         AS user_id,
      e.device_name                                          AS person_name,
      d.serial_number,
      l.device_user_id,
      l.punched_at,
      l.punched_local,
      to_char(l.punched_local, 'YYYY-MM-DD')                 AS work_date,
      to_char(l.punched_local, 'HH24:MI:SS')                 AS punch_time,
      l.punch_type,
      l.verify_mode,
      l.source
    FROM hr.attendance_logs l
    JOIN hr.attendance_devices d
      ON d.tenant_id = l.tenant_id AND d.id = l.device_id
    LEFT JOIN hr.device_enrollments e
      ON e.tenant_id = l.tenant_id AND e.device_id = l.device_id AND e.device_user_id = l.device_user_id
    WHERE COALESCE(e.match_status, 'pendiente') <> 'ignorado'`);
  await knex.raw(`GRANT SELECT ON hr.v_site_punches TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW hr.v_site_punches IS 'Fase RH: checadas por (sitio, código de la persona en el sitio), con la forma que usa la lógica de asistencia. Derivada, no copia. Excluye enrolamientos ignorados.'`);

  await knex.raw(`GRANT USAGE ON SCHEMA hr TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS hr.v_site_punches`);
  await knex.raw(`ALTER TABLE hr.device_enrollments DROP COLUMN IF EXISTS person_code`);
  await knex.raw(`ALTER TABLE hr.attendance_devices DROP CONSTRAINT IF EXISTS attendance_devices_site_fk`);
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_sites');
  await knex.schema.withSchema('hr').dropTableIfExists('ingest_batches');
  await knex.schema.withSchema('hr').dropTableIfExists('device_commands');
  await knex.raw(`DROP INDEX IF EXISTS hr.ix_hr_log_user`);
  await knex.raw(`ALTER TABLE hr.attendance_logs DROP CONSTRAINT IF EXISTS attendance_logs_user_fk`);
  await knex.raw(`ALTER TABLE hr.attendance_logs DROP COLUMN IF EXISTS source`);
  await knex.raw(`ALTER TABLE hr.attendance_logs DROP COLUMN IF EXISTS user_id`);
  await knex.raw(`DROP INDEX IF EXISTS hr.ix_hr_enr_user`);
  await knex.raw(`ALTER TABLE hr.device_enrollments DROP CONSTRAINT IF EXISTS device_enrollments_user_fk`);
  await knex.raw(`ALTER TABLE hr.device_enrollments DROP COLUMN IF EXISTS user_id`);
  for (const col of ['updated_by', 'agent_host', 'agent_version', 'logs_in_db', 'seen_ip',
    'last_backfill_at', 'last_punch_at', 'notes', 'is_paused', 'ingest_mode']) {
    await knex.raw(`ALTER TABLE hr.attendance_devices DROP COLUMN IF EXISTS ${col}`);
  }
};
