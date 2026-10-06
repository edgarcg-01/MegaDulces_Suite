/**
 * Fase RH · capa de datos de asistencia (3 de 3) — incidencias y cierre semanal.
 *
 * Las incidencias (vacaciones, permisos, incapacidades, horas extra, horario distinto…) y el
 * cierre de la semana jueves→miércoles son la base de la prenómina. Vienen de
 * `asistencia_incidencias` (+ bitácora) y `asistencia_cierres` de Mega Talento, con sus reglas
 * pasadas a CHECK donde la base las puede sostener sola:
 *
 *   - Flujo de 6 estados: capturada → calificada → cerrada → auditada, más rechazada y anulada.
 *     Nada se borra: anular deja la incidencia con quién, cuándo y por qué.
 *   - Separación de funciones: quien audita no puede ser quien capturó ni quien calificó.
 *   - La bitácora es de sólo agregar: `app_runtime` puede insertar y leer, no editar ni borrar.
 *   - Un cierre cubre una semana completa jueves→miércoles; reabrirlo exige motivo; sólo puede
 *     haber un cierre vigente por sitio y semana. El snapshot es la foto de esa semana.
 *
 * Los actores van como `uuid` (`identity.users`) y, para lo que llega de Mega Talento, como
 * nombre (`*_name`), porque allá se guardaban como texto. La carga única llena los nombres; lo
 * nuevo llena los dos.
 *
 * `incident_type` queda como texto: el catálogo (VAC, PSG, PCG, FI, INC, PAT, MAT, RT, AMO, SR,
 * HE, OTR, HD, horario_distinto…) vive en la lógica y crece; un CHECK haría fallar la carga.
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS hr`);

  const rls = async (table, grants = 'SELECT, INSERT, UPDATE, DELETE') => {
    await knex.raw(`ALTER TABLE hr.${table} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE hr.${table} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='hr' AND tablename='${table}' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON hr.${table}
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT ${grants} ON hr.${table} TO app_runtime`);
  };

  // ── 1) Incidencias ──────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_incidents'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_incidents (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        site_code              text NOT NULL,
        person_code            text NOT NULL,                -- código del reloj, como lo usa la lógica
        user_id                uuid,
        incident_type          text NOT NULL,
        date_from              date NOT NULL,
        date_to                date NOT NULL,
        minutes                integer CHECK (minutes IS NULL OR minutes >= 0),
        note                   text,
        status                 text NOT NULL DEFAULT 'capturada'
                                 CHECK (status IN ('capturada','calificada','rechazada','cerrada','auditada','anulada')),
        authorized_by_name     text,                         -- quién autorizó (de palabra, en papel)
        base_schedule_minutes  integer,                      -- horario de base para "horario distinto", en minutos del día
        created_by             uuid,
        created_by_name        text,
        created_at             timestamptz NOT NULL DEFAULT now(),
        rated_by               uuid,
        rated_by_name          text,
        rated_at               timestamptz,
        rejection_reason       text,
        audited_by             uuid,
        audited_by_name        text,
        audited_at             timestamptz,
        audit_note             text,
        voided_by              uuid,
        voided_by_name         text,
        voided_at              timestamptz,
        void_reason            text,
        updated_at             timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE SET NULL,
        CONSTRAINT attendance_incidents_range_ck CHECK (date_to >= date_from),
        CONSTRAINT attendance_incidents_audit_sod_ck CHECK (
          audited_by IS NULL
          OR (audited_by IS DISTINCT FROM created_by AND audited_by IS DISTINCT FROM rated_by)),
        CONSTRAINT attendance_incidents_voided_ck CHECK ((status = 'anulada') = (voided_at IS NOT NULL)),
        CONSTRAINT attendance_incidents_audited_ck CHECK (status <> 'auditada' OR audited_at IS NOT NULL),
        CONSTRAINT attendance_incidents_rejected_ck CHECK (status <> 'rechazada' OR rejection_reason IS NOT NULL)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_inc_site_dates ON hr.attendance_incidents (tenant_id, site_code, date_from, date_to)`);
    await knex.raw(`CREATE INDEX ix_hr_inc_person ON hr.attendance_incidents (tenant_id, site_code, person_code)`);
    await knex.raw(`CREATE INDEX ix_hr_inc_status ON hr.attendance_incidents (tenant_id, site_code, status)`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_incidents IS 'Fase RH: incidencias de asistencia (antes asistencia_incidencias). 6 estados; nada se borra; quien audita no captura ni califica.'`);
    await rls('attendance_incidents');
  }

  // ── 2) Bitácora de incidencias (sólo agregar) ───────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_incident_log'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_incident_log (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        incident_id    uuid NOT NULL,
        action         text NOT NULL,                        -- creada, calificada, rechazada, anulada, auditada…
        status_before  text,
        status_after   text,
        actor_id       uuid,
        actor_name     text,
        acted_at       timestamptz NOT NULL DEFAULT now(),
        detail         text,
        row_snapshot   jsonb,                                -- la incidencia completa después de la acción
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, incident_id) REFERENCES hr.attendance_incidents (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_hr_inclog_incident ON hr.attendance_incident_log (tenant_id, incident_id, acted_at)`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_incident_log IS 'Fase RH: bitácora de cada acción sobre una incidencia. Sólo agregar: app_runtime no puede editar ni borrar.'`);
    await rls('attendance_incident_log', 'SELECT, INSERT');
  }

  // ── 3) Cierre semanal (jueves → miércoles) ──────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_closures'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_closures (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        site_code         text NOT NULL,
        period_start      date NOT NULL,                     -- jueves
        period_end        date NOT NULL,                     -- miércoles
        closed_by         uuid,
        closed_by_name    text,
        closed_at         timestamptz NOT NULL DEFAULT now(),
        summary           jsonb,
        snapshot          jsonb NOT NULL,                    -- la foto de la semana al cerrarla
        reopened_by       uuid,
        reopened_by_name  text,
        reopened_at       timestamptz,
        reopen_reason     text,
        UNIQUE (tenant_id, id),
        CONSTRAINT attendance_closures_week_ck CHECK (
          EXTRACT(ISODOW FROM period_start) = 4 AND period_end = period_start + 6),
        CONSTRAINT attendance_closures_reopen_ck CHECK (
          reopened_at IS NULL OR (reopen_reason IS NOT NULL AND btrim(reopen_reason) <> ''))
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_hr_closure_open ON hr.attendance_closures (tenant_id, site_code, period_start) WHERE reopened_at IS NULL`);
    await knex.raw(`COMMENT ON TABLE hr.attendance_closures IS 'Fase RH: cierre de la semana jueves→miércoles para prenómina (antes asistencia_cierres). Uno vigente por sitio y semana; reabrir exige motivo.'`);
    await rls('attendance_closures');
  }

  await knex.raw(`GRANT USAGE ON SCHEMA hr TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_closures');
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_incident_log');
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_incidents');
};
