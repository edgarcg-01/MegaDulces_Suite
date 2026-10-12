'use strict';
/**
 * `[RH.1.10]` Fase RH (ADR-084) — **ajustes al banco de horas extra**. Traslado de
 * `mega-talento-90/api/db/horas-extra-ajustes.sql` (ee4ff38, 08/10/2026).
 *
 * El banco NO se guarda: sale del cálculo de asistencia desde el 24-sep-2026 (ganadas − usadas), así
 * que una checada que llega tarde o un «Horario distinto» capturado después lo corrigen solo. Lo único
 * guardado son los AJUSTES de RH: el saldo inicial de quien ya traía horas de antes del banco, o una
 * corrección, en minutos con signo (+330 = suma 5 h 30 min; −60 = resta 1 h).
 *
 * ── Lo medido antes (sólo lectura, 12-oct) ──────────────────────────────────────────────────
 *  · En Mega Talento la tabla existe desde el 08-oct; con datos reales del 24-sep al 12-oct el
 *    cálculo da 12,300 min ganados y 1,710 usados (sin ajustes, el saldo de quien traía horas de
 *    antes sale negativo: por eso existe la tabla).
 *
 * Se ANULA con motivo, nunca se borra (la auditoría ve qué se quitó). Llave por (sitio, código de
 * persona), igual que el resto de la asistencia (`hr.person_schedules`, `hr.attendance_incidents`).
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('hr').hasTable('overtime_adjustments'))) {
    await knex.raw(`
      CREATE TABLE hr.overtime_adjustments (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL REFERENCES identity.tenants(id) ON DELETE RESTRICT,
        site_code        text NOT NULL,
        person_code      text NOT NULL,
        minutes          integer NOT NULL,
        effective_date   date NOT NULL DEFAULT CURRENT_DATE,  -- desde qué día cuenta
        reason           text NOT NULL,
        created_by       uuid,
        created_by_name  text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        voided_by        uuid,
        voided_by_name   text,
        voided_at        timestamptz,
        void_reason      text,
        CONSTRAINT overtime_adjustments_minutes_ck CHECK (minutes <> 0 AND abs(minutes) <= 100000),
        CONSTRAINT overtime_adjustments_reason_ck CHECK (length(btrim(reason)) >= 5),
        CONSTRAINT overtime_adjustments_void_ck CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
        UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX ix_hr_overtime_adj_persona ON hr.overtime_adjustments (tenant_id, site_code, person_code)`);
  }
  await knex.raw(`ALTER TABLE hr.overtime_adjustments ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE hr.overtime_adjustments FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='hr' AND tablename='overtime_adjustments' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON hr.overtime_adjustments
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Sin DELETE: se anula, no se borra.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON hr.overtime_adjustments TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE hr.overtime_adjustments IS
    '[RH.1.10] Ajustes de RH al banco de horas extra (saldo inicial o corrección, minutos con signo). El banco no se guarda: sale del cálculo de asistencia. Se anula con motivo, no se borra.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM hr.overtime_adjustments`).catch(() => ({ rows: [{ n: 0 }] }));
  if (rows[0].n) throw new Error(`[RH.1.10] hr.overtime_adjustments tiene ${rows[0].n} ajuste(s): no se tira una tabla con datos de RH.`);
  await knex.raw(`DROP TABLE IF EXISTS hr.overtime_adjustments`);
};
