'use strict';
/**
 * `[RH.15.1]` + `[RH.15.4]` — Las checadas son EVIDENCIA: no se editan, no se borran sin dejar rastro, y cada una
 * guarda cuánto se había corrido la hora de su reloj. (Fusiona las que eran dos migraciones, 2026-11-23: ninguna se
 * había aplicado en prod y las dos tocan la misma tabla.)
 *
 * LFT art. 132 fr. XXXIV (DOF 1-may-2026): el registro electrónico de la jornada hace PRUEBA PLENA
 * si se acredita que se acordó; art. 804-III/805: el patrón conserva y exhibe los controles de
 * asistencia, y si no los presenta se presume lo que dice el trabajador. Un registro que la propia
 * app puede reescribir o borrar vale poco ante una Junta.
 *
 * ── Lo medido antes (sólo lectura, código de main + base local) ────────────────────────────────
 *  · `app_runtime` tenía SELECT, INSERT, UPDATE, DELETE sobre `hr.attendance_logs`, sin disparador.
 *  · Borrar un reloj (`hr.attendance_devices`) borraba TODAS sus checadas (`ON DELETE CASCADE`).
 *  · Caminos que escriben: la ingesta (INSERT … ON CONFLICT DO NOTHING), la carga única (INSERT),
 *    `importers/checadores/link-employees.js` (UPDATE de `employee_id`), la semilla de desarrollo y
 *    una prueba de ingesta (DELETE, dentro de transacciones de prueba). Ningún endpoint edita ni borra.
 *
 * Qué hace:
 *  0. `[RH.15.4]` Agrega `hr.attendance_logs.clock_drift_seconds int` (segundos; + = adelantado; NULL = no medido:
 *     checadas anteriores y reprocesos). Antes sólo se guardaba el ÚLTIMO desfase en `hr.attendance_devices`, sin
 *     historia: una checada de hace un mes no decía si su reloj tenía bien la hora (LFT 132-XXXIV: inicio y fin).
 *     La ingesta lo llena al entregar el lote y tolera que la columna falte.
 *  1. Un disparador rechaza cambiar las columnas de EVIDENCIA (reloj, código, hora, método, tipo, origen).
 *     Ligar la checada a una persona (`employee_id`, `user_id`) sí se puede: es un dato derivado.
 *  2. Borrar se rechaza, salvo con `SET LOCAL hr.borrado_checadas = '<motivo>'` en la misma transacción;
 *     y aun así queda una copia de la fila, el motivo y quién en `hr.attendance_log_deletions`
 *     (sólo agregar). El superusuario también pasa por aquí: el disparador no distingue.
 *  3. `app_runtime` pierde DELETE: la app nunca borra checadas.
 *  4. La llave al reloj pasa de CASCADE a RESTRICT: un reloj con checadas no se puede borrar.
 *
 * Idempotente. No cambia ninguna fila. ⚠️ Crea objetos de esquema (columna, tabla, función, disparador).
 *
 * @param { import("knex").Knex } knex
 */

const EVIDENCIA = [
  'tenant_id', 'device_id', 'device_user_id', 'punched_at', 'punched_local', 'device_uid',
  'verify_mode', 'verify_label', 'punch_type', 'punch_label', 'work_code', 'imported_at', 'source',
  // `[RH.15.4]` el desfase del reloj al entregarla (paso 0): también es evidencia.
  'clock_drift_seconds',
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 0) `[RH.15.4]` El desfase del reloj en cada checada (antes del disparador: así queda en su lista) ──
  if (!(await knex.schema.withSchema('hr').hasColumn('attendance_logs', 'clock_drift_seconds'))) {
    await knex.raw(`ALTER TABLE hr.attendance_logs ADD COLUMN clock_drift_seconds integer`);
    await knex.raw(`COMMENT ON COLUMN hr.attendance_logs.clock_drift_seconds IS
      '[RH.15.4] Desfase del reloj al entregar el lote (s; + adelantado). NULL = no medido (anteriores a RH.15.4 o reproceso).'`);
  }

  // ── 1) La bitácora de lo borrado (sólo agregar) ────────────────────────────────────────────
  if (!(await knex.schema.withSchema('hr').hasTable('attendance_log_deletions'))) {
    await knex.raw(`
      CREATE TABLE hr.attendance_log_deletions (
        id          bigserial PRIMARY KEY,
        tenant_id   uuid NOT NULL,
        fila        jsonb NOT NULL,               -- la checada completa, tal como estaba
        motivo      text NOT NULL,
        borrado_por text NOT NULL DEFAULT current_user,
        borrado_en  timestamptz NOT NULL DEFAULT now(),
        created_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT attendance_log_deletions_motivo_ck CHECK (length(btrim(motivo)) >= 5)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_log_del ON hr.attendance_log_deletions (tenant_id, borrado_en DESC)`);
    await knex.raw(`ALTER TABLE hr.attendance_log_deletions ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE hr.attendance_log_deletions FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hr' AND tablename = 'attendance_log_deletions' AND policyname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON hr.attendance_log_deletions
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT ON hr.attendance_log_deletions TO app_runtime`);
  }

  // ── 2) El disparador ───────────────────────────────────────────────────────────────────────
  // Sólo las que EXISTEN: la función se compila al usarse y una columna que falta la rompería en cada UPDATE.
  const existentes = new Set((await knex.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'hr' AND table_name = 'attendance_logs'`,
  )).rows.map((r) => r.column_name));
  const distintos = EVIDENCIA.filter((c) => existentes.has(c)).map((c) => `NEW.${c} IS DISTINCT FROM OLD.${c}`).join(' OR ');
  await knex.raw(`
    CREATE OR REPLACE FUNCTION hr.checadas_son_evidencia() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, hr, public AS $f$
    DECLARE motivo text := nullif(btrim(current_setting('hr.borrado_checadas', true)), '');
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF ${distintos} THEN
          RAISE EXCEPTION 'RH.15.1: una checada es evidencia; su reloj, código, hora, método y tipo no se cambian'
            USING ERRCODE = 'check_violation',
                  HINT = 'Las correcciones van por incidencias. Ligar la checada a una persona (employee_id, user_id) sí se permite.';
        END IF;
        RETURN NEW;
      END IF;
      -- DELETE
      IF motivo IS NULL OR length(motivo) < 5 THEN
        RAISE EXCEPTION 'RH.15.1: las checadas no se borran'
          USING ERRCODE = 'check_violation',
                HINT = 'Si de verdad hay que borrar (pruebas, datos de demostración): SET LOCAL hr.borrado_checadas = ''<motivo>''; queda copia en hr.attendance_log_deletions.';
      END IF;
      INSERT INTO hr.attendance_log_deletions (tenant_id, fila, motivo) VALUES (OLD.tenant_id, to_jsonb(OLD), motivo);
      RETURN OLD;
    END $f$`);
  await knex.raw(`DROP TRIGGER IF EXISTS checadas_son_evidencia ON hr.attendance_logs`);
  await knex.raw(`
    CREATE TRIGGER checadas_son_evidencia BEFORE UPDATE OR DELETE ON hr.attendance_logs
      FOR EACH ROW EXECUTE FUNCTION hr.checadas_son_evidencia()`);

  // ── 3) La app no borra checadas ────────────────────────────────────────────────────────────
  await knex.raw(`REVOKE DELETE ON hr.attendance_logs FROM app_runtime`);

  // ── 4) Un reloj con checadas no se borra ───────────────────────────────────────────────────
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_logs_tenant_id_device_id_fkey' AND confdeltype = 'c') THEN
        ALTER TABLE hr.attendance_logs DROP CONSTRAINT attendance_logs_tenant_id_device_id_fkey;
        ALTER TABLE hr.attendance_logs ADD CONSTRAINT attendance_logs_tenant_id_device_id_fkey
          FOREIGN KEY (tenant_id, device_id) REFERENCES hr.attendance_devices (tenant_id, id) ON DELETE RESTRICT;
      END IF;
    END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. La bitácora de borrados se conserva. */
exports.down = async function down(knex) {
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_logs_tenant_id_device_id_fkey' AND confdeltype = 'r') THEN
        ALTER TABLE hr.attendance_logs DROP CONSTRAINT attendance_logs_tenant_id_device_id_fkey;
        ALTER TABLE hr.attendance_logs ADD CONSTRAINT attendance_logs_tenant_id_device_id_fkey
          FOREIGN KEY (tenant_id, device_id) REFERENCES hr.attendance_devices (tenant_id, id) ON DELETE CASCADE;
      END IF;
    END $$`);
  await knex.raw(`GRANT DELETE ON hr.attendance_logs TO app_runtime`);
  await knex.raw(`DROP TRIGGER IF EXISTS checadas_son_evidencia ON hr.attendance_logs`);
  await knex.raw(`DROP FUNCTION IF EXISTS hr.checadas_son_evidencia()`);
  await knex.raw(`ALTER TABLE hr.attendance_logs DROP COLUMN IF EXISTS clock_drift_seconds`);
};
