/**
 * SM.8 / P5 — Cerrar el loop: acciones sobre los hallazgos + medición de efectividad.
 *
 * Hereda ADR-013 (HITL: el motor propone, el humano aprueba/ejecuta) y Horus-L L3
 * (efectividad por diff-in-diff). Una acción se ancla a un foco (sucursal[/caja/cajero])
 * con una fecha de intervención → luego se mide si la tasa de descuadre bajó vs antes.
 *
 * RLS forzado + grants app_runtime. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS reconciliation`);
  if (await knex.schema.withSchema('reconciliation').hasTable('actions')) return;
  await knex.raw(`
    CREATE TABLE reconciliation.actions (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      discrepancy_id uuid,                    -- hallazgo origen (opcional)
      palanca        text NOT NULL,           -- 'arqueo_ciego' | 'arqueo_relevo' | 'limitar_jornada' | 'supervision' | 'otro'
      titulo         text NOT NULL,
      detalle        text,
      -- Alcance de la intervención (para medir diff-in-diff):
      warehouse_code text,
      caja           text,
      cajero_code    text,
      fecha_intervencion date NOT NULL,       -- corte before/after
      responsable    text,
      status         text NOT NULL DEFAULT 'propuesta' CHECK (status IN ('propuesta','aceptada','en_curso','hecha','descartada')),
      baseline_faltante  numeric,             -- snapshot al proponer (30d antes)
      created_by     text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rec_action_status ON reconciliation.actions (tenant_id, status)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_rec_action_scope ON reconciliation.actions (tenant_id, warehouse_code, caja, cajero_code)`);
  await knex.raw(`ALTER TABLE reconciliation.actions ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE reconciliation.actions FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='reconciliation' AND tablename='actions' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON reconciliation.actions
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation.actions TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('reconciliation').dropTableIfExists('actions');
};
