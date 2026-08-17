/**
 * Fase CH — Checadores (control de asistencia) → schema `hr.*`.
 *
 * Espejo de los relojes checadores ZKTeco MB360 de la red (protocolo nativo
 * TCP 4370) más la capa de identidad que el equipo NO tiene. Decode verificado
 * en vivo 2026-08-17 contra los 7 equipos alcanzables (93,957 checadas):
 *
 *   - La IP NO es identidad: 5 de 7 equipos reportan `IPAddress = 192.168.1.201`
 *     (default de fábrica que quedó viejo) mientras viven en otra IP real. La
 *     llave estable es `~SerialNumber`.
 *   - `user_id` NO es único entre equipos: el `2` es "Tania" en .0.81 y .0.153
 *     pero "Lupita" en .0.196. La llave del enrolamiento es (device, user_id) y
 *     la persona real se resuelve con crosswalk HITL (`device_enrollments`).
 *   - .0.80 y .0.81 son la MISMA plantilla renumerada (`id_80 = id_81 + 100`:
 *     Tania 102/2, Ubaldo 107/7, Joan 152/52). Insumo para el auto-match.
 *   - El equipo entrega hora LOCAL de pared, sin zona. Se guarda el naive
 *     (`punched_local`, fidelidad de lo que mostró el reloj) y el canónico
 *     (`punched_at`) convertido con la zona declarada del equipo.
 *
 * Idempotencia de la ingesta: la PK natural de una checada es
 * (device, device_user_id, punched_at) — NO el `uid` interno, porque ese es el
 * índice del ring buffer del equipo y se reinicia cuando se purgan registros,
 * lo que colisionaría contra el histórico ya importado.
 *
 * Convención A.0mt: tenant_id + audit; hr.* con RLS forzado + grants app_runtime.
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

  // ── 1) Los relojes físicos ─────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_devices'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_devices (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        serial_number     text NOT NULL,                 -- ~SerialNumber: la ÚNICA identidad estable
        label             text,                          -- sitio/área en lenguaje humano (lo llena el operador)
        site_code         text,                           -- crosswalk a sucursal (commercial.warehouses.kepler_code)
        -- conexión (mutable: DHCP / recableado)
        ip_address        text,
        port              integer NOT NULL DEFAULT 4370,
        comm_key          integer NOT NULL DEFAULT 0,
        timezone          text NOT NULL DEFAULT 'America/Mexico_City',
        -- identidad reportada por el equipo (se refresca en cada sync)
        model             text,                           -- ~DeviceName (MB360 / MB360/ID)
        platform          text,                           -- ~Platform
        firmware          text,
        mac               text,
        reported_ip       text,                           -- IPAddress del equipo: NO confiable, se guarda para diagnóstico
        -- contadores y capacidad (para alertar antes de que se llene el buffer)
        user_count        integer,
        record_count      integer,
        capacity_users    integer,
        capacity_records  integer,
        -- estado operativo
        is_active         boolean NOT NULL DEFAULT true,
        last_seen_at      timestamptz,
        last_sync_at      timestamptz,
        last_error        text,
        clock_drift_seconds integer,                      -- hora del equipo − hora del server
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, serial_number)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_dev_active ON hr.attendance_devices (tenant_id, is_active)`);
    await rls('attendance_devices');
  }

  // ── 2) La persona real (lo que el checador no sabe) ─────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('employees'))) {
    await knex.raw(`
      CREATE TABLE hr.employees (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        employee_code  text,                              -- código de nómina, cuando exista el padrón
        full_name      text NOT NULL,
        short_name     text,                              -- alias corto (así lo escriben en el reloj)
        site_code      text,
        department     text,
        position       text,
        status         text NOT NULL DEFAULT 'activo' CHECK (status IN ('activo','baja','suspendido')),
        hired_at       date,
        terminated_at  date,
        notes          text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        created_by     uuid,
        updated_by     uuid,
        UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_hr_emp_code ON hr.employees (tenant_id, employee_code) WHERE employee_code IS NOT NULL`);
    await knex.raw(`CREATE INDEX ix_hr_emp_name ON hr.employees (tenant_id, full_name)`);
    await rls('employees');
  }

  // ── 3) Crosswalk (equipo, user_id) → persona ────────────────────────────
  // Un empleado puede estar enrolado en varios equipos con IDs distintos; esta
  // tabla es la que unifica. `employee_id` arranca NULL y se resuelve por
  // auto-match + confirmación humana (match_status).
  if (!(await knex.schema.withSchema('hr').hasTable('device_enrollments'))) {
    await knex.raw(`
      CREATE TABLE hr.device_enrollments (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        device_id       uuid NOT NULL,
        device_user_id  text NOT NULL,                    -- user_id tal cual en el equipo (~PIN2Width=14 → texto)
        device_uid      integer,                          -- uid interno del equipo (índice, mutable)
        device_name     text,                             -- nombre tal cual lo escribieron en el reloj
        privilege       integer,                          -- 0=usuario 2=registrador 6=supervisor 14=admin
        role            text,
        has_password    boolean NOT NULL DEFAULT false,
        card            bigint,
        group_id        text,
        employee_id     uuid,
        match_status    text NOT NULL DEFAULT 'pendiente'
                          CHECK (match_status IN ('pendiente','auto','confirmado','rechazado','ignorado')),
        match_score     numeric,
        match_reason    text,
        first_seen_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at    timestamptz NOT NULL DEFAULT now(),
        is_present      boolean NOT NULL DEFAULT true,     -- false = ya no está enrolado en el equipo
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        updated_by      uuid,
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, device_id, device_user_id),
        FOREIGN KEY (tenant_id, device_id)   REFERENCES hr.attendance_devices (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, employee_id) REFERENCES hr.employees (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_hr_enr_emp ON hr.device_enrollments (tenant_id, employee_id)`);
    await knex.raw(`CREATE INDEX ix_hr_enr_pending ON hr.device_enrollments (tenant_id, match_status) WHERE employee_id IS NULL`);
    await rls('device_enrollments');
  }

  // ── 4) Las checadas (append-only: la verdad del reloj) ──────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_logs'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_logs (
        tenant_id       uuid NOT NULL,
        device_id       uuid NOT NULL,
        device_user_id  text NOT NULL,
        punched_at      timestamptz NOT NULL,             -- canónico (naive convertido con la zona del equipo)
        punched_local   timestamp NOT NULL,               -- lo que mostró el reloj, sin zona
        device_uid      integer,                          -- índice en el buffer del equipo (diagnóstico)
        verify_mode     smallint,                         -- 1=huella 15=rostro 2=password 3/4=tarjeta
        verify_label    text,
        punch_type      smallint,                         -- 0=entrada 1=salida 2/3=comida 4/5=extra
        punch_label     text,
        work_code       integer,
        employee_id     uuid,                             -- denormalizado al resolver el crosswalk
        imported_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, device_id, device_user_id, punched_at),
        FOREIGN KEY (tenant_id, device_id)   REFERENCES hr.attendance_devices (tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, employee_id) REFERENCES hr.employees (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_hr_log_time ON hr.attendance_logs (tenant_id, punched_at DESC)`);
    await knex.raw(`CREATE INDEX ix_hr_log_emp ON hr.attendance_logs (tenant_id, employee_id, punched_at DESC)`);
    await knex.raw(`CREATE INDEX ix_hr_log_dev ON hr.attendance_logs (tenant_id, device_id, punched_at DESC)`);
    await knex.raw(`CREATE INDEX ix_hr_log_unmapped ON hr.attendance_logs (tenant_id, device_id, device_user_id) WHERE employee_id IS NULL`);
    await rls('attendance_logs');
  }

  // ── 5) Observabilidad de la ingesta (7 equipos, 3 sobre WAN: fallan solos) ──
  if (!(await knex.schema.withSchema('hr').hasTable('device_sync_runs'))) {
    await knex.raw(`
      CREATE TABLE hr.device_sync_runs (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        device_id         uuid,
        serial_number     text,
        ip_address        text,
        started_at        timestamptz NOT NULL DEFAULT now(),
        finished_at       timestamptz,
        duration_ms       integer,
        status            text NOT NULL DEFAULT 'running'
                            CHECK (status IN ('running','ok','error','unreachable')),
        users_read        integer NOT NULL DEFAULT 0,
        logs_read         integer NOT NULL DEFAULT 0,
        logs_inserted     integer NOT NULL DEFAULT 0,
        enrollments_upserted integer NOT NULL DEFAULT 0,
        clock_drift_seconds integer,
        error             text,
        UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_sync_recent ON hr.device_sync_runs (tenant_id, started_at DESC)`);
    await rls('device_sync_runs');
  }

  // ── 6) Vista de jornada: primera entrada / última salida por persona-día ──
  // Se apoya en la zona MX para cortar el día (un turno nocturno cruzando
  // medianoche cae en dos días; eso se resuelve en la capa de reglas, no aquí).
  await knex.raw(`
    CREATE OR REPLACE VIEW hr.attendance_days AS
    SELECT
      l.tenant_id,
      l.employee_id,
      l.device_id,
      l.device_user_id,
      (l.punched_at AT TIME ZONE 'America/Mexico_City')::date        AS work_date,
      min(l.punched_at)                                              AS first_punch_at,
      max(l.punched_at)                                              AS last_punch_at,
      count(*)                                                       AS punch_count,
      round(EXTRACT(EPOCH FROM (max(l.punched_at) - min(l.punched_at))) / 3600.0, 2) AS span_hours,
      count(*) FILTER (WHERE l.punch_type = 0)                       AS check_ins,
      count(*) FILTER (WHERE l.punch_type = 1)                       AS check_outs,
      bool_or(l.verify_mode = 15)                                    AS used_face,
      bool_or(l.verify_mode = 1)                                     AS used_finger
    FROM hr.attendance_logs l
    GROUP BY 1, 2, 3, 4, 5`);
  await knex.raw(`GRANT SELECT ON hr.attendance_days TO app_runtime`);
  await knex.raw(`GRANT USAGE ON SCHEMA hr TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS hr.attendance_days`);
  await knex.schema.withSchema('hr').dropTableIfExists('device_sync_runs');
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_logs');
  await knex.schema.withSchema('hr').dropTableIfExists('device_enrollments');
  await knex.schema.withSchema('hr').dropTableIfExists('employees');
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_devices');
};
