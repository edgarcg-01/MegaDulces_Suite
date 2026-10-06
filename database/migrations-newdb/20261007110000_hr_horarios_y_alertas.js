/**
 * Fase RH · capa de datos de asistencia (2 de 3) — horarios, reglas y alertas.
 *
 * Trae a `hr.*` lo que Mega Talento usa para juzgar un día de trabajo. Las formas copian a
 * propósito las de Mega Talento (`horarios_sucursal`, `horarios_confirmados`,
 * `asistencia_config`, `asistencia_alertas`, `asistencia_revision`) para que su lógica, que ya
 * está probada en producción, se TRASLADE sin reescribirse (ADR-084, opción rápida).
 *
 * La persona se identifica igual que en Mega Talento — (sitio, código del reloj) — y además
 * por `user_id` (`identity.users`, ADR-084 D1). El código del reloj es la llave que la lógica
 * ya usa; `user_id` es la que usa la Suite. Los dos conviven hasta que todas las personas
 * estén mapeadas.
 *
 * `site_code` = el código de sucursal de Kepler (`commercial.warehouses.kepler_code`), igual
 * que en `hr.attendance_devices`. El mapeo desde los nombres de plaza de Mega Talento lo valida
 * RH en `[RH.0.4]`; no se adivina.
 *
 * Qué crea:
 *   1. `hr.work_schedules`   — horarios por sitio (entrada, comida, salida, días, tolerancia).
 *   2. `hr.person_schedules` — el horario CONFIRMADO de una persona. Manda sobre cualquier
 *      deducción: hay quien llega 8 minutos antes todos los días y no es retardo, y eso no lo
 *      revela el dato, lo tiene que decir RH. Un rotativo tiene 2 o 3 entradas.
 *   3. `hr.attendance_rules`  — umbrales del agente de alertas; `site_code` NULL = global.
 *   4. `hr.attendance_alerts` — lo que el agente sugiere y RH decide. Una por (persona, día, regla).
 *   5. `hr.attendance_reviews` — la justificación de un día puesta a mano.
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
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

  // ── 1) Horarios por sitio ───────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('work_schedules'))) {
    await knex.raw(`
      CREATE TABLE hr.work_schedules (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        site_code          text NOT NULL,
        name               text NOT NULL,
        weekdays           smallint[] NOT NULL DEFAULT '{}',   -- 0 = domingo … 6 = sábado
        starts_at          time NOT NULL,
        lunch_starts_at    time,
        lunch_ends_at      time,
        ends_at            time NOT NULL,
        tolerance_minutes  integer NOT NULL DEFAULT 0 CHECK (tolerance_minutes >= 0),
        is_active          boolean NOT NULL DEFAULT true,
        created_at         timestamptz NOT NULL DEFAULT now(),
        created_by         uuid,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        updated_by         uuid,
        UNIQUE (tenant_id, id),
        CONSTRAINT work_schedules_weekdays_ck CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[]),
        CONSTRAINT work_schedules_lunch_ck CHECK ((lunch_starts_at IS NULL) = (lunch_ends_at IS NULL))
      )`);
    await knex.raw(`CREATE INDEX ix_hr_sched_site ON hr.work_schedules (tenant_id, site_code) WHERE is_active`);
    await knex.raw(`COMMENT ON TABLE hr.work_schedules IS 'Fase RH: horario por sitio (antes horarios_sucursal de Mega Talento). site_code = código Kepler.'`);
    await rls('work_schedules');
  }

  // ── 2) Horario confirmado por persona ───────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('person_schedules'))) {
    await knex.raw(`
      CREATE TABLE hr.person_schedules (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        site_code           text NOT NULL,
        person_code         text NOT NULL,                   -- código del reloj, como lo usa la lógica
        user_id             uuid,                            -- la persona en la Suite, cuando esté mapeada
        schedule_id         uuid,                            -- horario de sitio asignado, si lo hay
        shift_starts        time[] NOT NULL DEFAULT '{}',    -- {09:30} fijo · {07:00,15:00} rotativo
        ends_at             time,
        lunch_minutes       integer CHECK (lunch_minutes IS NULL OR lunch_minutes BETWEEN 0 AND 240),
        works_saturday      boolean NOT NULL DEFAULT false,
        saturday_starts_at  time,
        saturday_ends_at    time,
        note                text,                            -- por qué (lo dijo el jefe, el contrato…)
        confirmed_by        uuid,
        confirmed_by_name   text,                            -- quién respondió, tal como lo registró Mega Talento
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, site_code, person_code),
        FOREIGN KEY (tenant_id, user_id)     REFERENCES identity.users (tenant_id, id) ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, schedule_id) REFERENCES hr.work_schedules (tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT person_schedules_has_schedule_ck CHECK (cardinality(shift_starts) > 0 OR schedule_id IS NOT NULL),
        CONSTRAINT person_schedules_rotating_ck CHECK (cardinality(shift_starts) <= 3),
        CONSTRAINT person_schedules_saturday_ck CHECK (works_saturday OR (saturday_starts_at IS NULL AND saturday_ends_at IS NULL))
      )`);
    await knex.raw(`CREATE INDEX ix_hr_psched_user ON hr.person_schedules (tenant_id, user_id)`);
    await knex.raw(`COMMENT ON TABLE hr.person_schedules IS 'Fase RH: horario confirmado por RH para una persona (antes horarios_confirmados). Manda sobre cualquier horario deducido.'`);
    await rls('person_schedules');
  }

  // ── 3) Reglas del agente de alertas ─────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_rules'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_rules (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        site_code   text,                                    -- NULL = regla global
        config      jsonb NOT NULL DEFAULT '{}'::jsonb,      -- umbrales y reglasActivas, como en Mega Talento
        updated_at  timestamptz NOT NULL DEFAULT now(),
        updated_by  uuid,
        UNIQUE (tenant_id, id),
        CONSTRAINT attendance_rules_config_ck CHECK (jsonb_typeof(config) = 'object')
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_hr_rules_site ON hr.attendance_rules (tenant_id, COALESCE(site_code, ''))`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_rules IS 'Fase RH: umbrales del agente de alertas (antes asistencia_config). site_code NULL = global; un sitio sólo sobrescribe lo que declara.'`);
    await rls('attendance_rules');
  }

  // ── 4) Alertas: lo que el agente sugiere y RH decide ────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_alerts'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_alerts (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                 uuid NOT NULL,
        site_code                 text NOT NULL,
        person_code               text NOT NULL,
        person_name               text,                      -- como se vio al analizar
        user_id                   uuid,
        work_date                 date NOT NULL,
        rule                      text NOT NULL,             -- retardo, falta, checada_duplicada, desayuno_excedido…
        severity                  text NOT NULL DEFAULT 'media' CHECK (severity IN ('baja','media','alta')),
        detail                    text,
        evidence                  jsonb NOT NULL DEFAULT '{}'::jsonb,
        suggested_justification   text,
        status                    text NOT NULL DEFAULT 'sugerida_ia'
                                    CHECK (status IN ('sugerida_ia','aprobada','rechazada','descartada')),
        origin                    text NOT NULL DEFAULT 'agente_ia',
        code                      text,                      -- código corto para que el jefe conteste por WhatsApp
        decided_by                uuid,
        decided_by_name           text,
        decided_at                timestamptz,
        supervisor_justification  text,
        responded_by              text,                      -- quién contestó por WhatsApp (nombre o teléfono)
        responded_at              timestamptz,
        analyzed_at               timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, site_code, person_code, work_date, rule),
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT attendance_alerts_decided_ck CHECK ((status = 'sugerida_ia') = (decided_at IS NULL))
      )`);
    await knex.raw(`CREATE INDEX ix_hr_alert_site_date ON hr.attendance_alerts (tenant_id, site_code, work_date)`);
    await knex.raw(`CREATE INDEX ix_hr_alert_open ON hr.attendance_alerts (tenant_id, site_code) WHERE status = 'sugerida_ia'`);
    // No es UNIQUE a propósito: Mega Talento no garantiza que un código no se haya repetido en la
    // historia, y la carga única no puede fallar por eso. La unicidad entre alertas ABIERTAS la
    // asegura la lógica al generar el código.
    await knex.raw(`CREATE INDEX ix_hr_alert_code ON hr.attendance_alerts (tenant_id, code) WHERE code IS NOT NULL`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_alerts IS 'Fase RH: sugerencias del agente de asistencia (antes asistencia_alertas). El agente sugiere; RH decide.'`);
    await rls('attendance_alerts');
  }

  // ── 5) Revisiones de un día ─────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_reviews'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_reviews (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        site_code      text NOT NULL,
        person_code    text NOT NULL,
        user_id        uuid,
        work_date      date NOT NULL,
        justification  text,
        status         text NOT NULL DEFAULT 'pendiente',
        updated_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     uuid,
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, site_code, person_code, work_date),
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE SET NULL
      )`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_reviews IS 'Fase RH: justificación de un día (antes asistencia_revision). Convive con las incidencias hasta que [RH.1.5] decida un solo mecanismo.'`);
    await rls('attendance_reviews');
  }

  await knex.raw(`GRANT USAGE ON SCHEMA hr TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_reviews');
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_alerts');
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_rules');
  await knex.schema.withSchema('hr').dropTableIfExists('person_schedules');
  await knex.schema.withSchema('hr').dropTableIfExists('work_schedules');
};
