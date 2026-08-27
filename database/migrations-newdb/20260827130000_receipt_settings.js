'use strict';
/**
 * `[RE.13.0]` — Parámetros del proceso de recepción documental, por tenant.
 *
 * Salen del código: hoy `RECEPTION_START = '2026-08-01'` y `TOLERANCIA = 1.0` son
 * constantes de módulo en `goods-receipt-proofs.service.ts`, así que mover la fecha
 * de arranque del proceso o la tolerancia del cuadre exige redeploy. Y las dos son
 * decisiones de negocio, no de código:
 *
 *   - `reception_start`   — desde qué fecha las entradas de Kepler entran al proceso.
 *                           Es la palanca del rezago: subirla al día del arranque
 *                           deja el histórico fuera del SLA (ver §7.1 del plan).
 *   - `match_tolerance`   — cuándo se considera que la factura "cuadra" con la
 *                           entrada (±$1 hoy). Es además la puerta de la aprobación
 *                           en lote del revisor.
 *   - `sla_capture_days`  — días que puede llevar una entrada sin evidencia antes de
 *                           que se marque atrasada (semáforo del capturista).
 *   - `sla_review_days`   — días que puede llevar una evidencia esperando decisión.
 *   - `bulk_max_files`    — tope de archivos por lote en la captura de CEDIS.
 *
 * Patrón calcado de `commercial.replenishment_settings` (RA-PRO.27): PK = tenant_id,
 * RLS forzado, seed idempotente. Aditiva; no toca nada vivo. El service lee esta
 * tabla con fallback a los defaults, así que funciona aunque la fila no exista.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('receipt_settings'))) {
    await knex.raw(`
      CREATE TABLE finance.receipt_settings (
        tenant_id         uuid PRIMARY KEY,
        reception_start   date    NOT NULL DEFAULT '2026-08-01',
        match_tolerance   numeric NOT NULL DEFAULT 1.00,
        sla_capture_days  integer NOT NULL DEFAULT 3,
        sla_review_days   integer NOT NULL DEFAULT 3,
        bulk_max_files    integer NOT NULL DEFAULT 50,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        CONSTRAINT chk_receipt_tolerance CHECK (match_tolerance >= 0 AND match_tolerance <= 1000),
        CONSTRAINT chk_receipt_sla CHECK (sla_capture_days BETWEEN 1 AND 90 AND sla_review_days BETWEEN 1 AND 90),
        CONSTRAINT chk_receipt_bulk CHECK (bulk_max_files BETWEEN 1 AND 500)
      )`);
    await knex.raw(`ALTER TABLE finance.receipt_settings ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.receipt_settings FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON finance.receipt_settings
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    // Trigger opcional: solo si el helper existe (nuestros INSERT pasan tenant_id explícito),
    // así la migración no tumba el batch en entornos donde todavía no esté.
    await knex.raw(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'auto_populate_tenant_id') THEN
          DROP TRIGGER IF EXISTS trg_auto_populate_tenant_id ON finance.receipt_settings;
          CREATE TRIGGER trg_auto_populate_tenant_id BEFORE INSERT ON finance.receipt_settings
            FOR EACH ROW EXECUTE FUNCTION public.auto_populate_tenant_id();
        END IF;
      END $$;`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON finance.receipt_settings TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE finance.receipt_settings IS
      'RE.13.0 — parámetros del proceso de recepción documental por tenant (arranque, tolerancia del cuadre, SLA, tope de lote).'`);
    await knex.raw(`COMMENT ON COLUMN finance.receipt_settings.reception_start IS
      'Desde qué fecha las entradas de Kepler entran al proceso. Palanca del rezago: lo anterior no se lista ni se cuenta en el SLA.'`);
    await knex.raw(`COMMENT ON COLUMN finance.receipt_settings.match_tolerance IS
      'Pesos de diferencia tolerados entre el total de la factura y el valor de la entrada. Es también la puerta de la aprobación en lote.'`);
  }

  await knex.raw(
    `INSERT INTO finance.receipt_settings (tenant_id) VALUES (?) ON CONFLICT (tenant_id) DO NOTHING`,
    [MEGA],
  );
};

exports.down = async function down(knex) {
  // No se borra: la tabla lleva configuración de negocio. Bajar la fase = dejar de leerla.
  await knex.raw(`SELECT 1`);
};
