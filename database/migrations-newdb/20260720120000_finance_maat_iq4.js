/**
 * MAAT-IQ · MIQ.4 — Analista adversarial + descubrimiento de detectores (ADR-028).
 *
 *   finance.detector_hypotheses = bandeja de HIPÓTESIS de detectores nuevos. Un
 *     minero determinista (y, gated por API key, un agente AI) propone TIPOS de
 *     problema que aún no tienen regla; el humano aprueba/rechaza (HITL, ADR-013).
 *     Aprobar = backlog de detector a codificar/activar. Nunca crea reglas solo.
 *   finance.findings.skeptic_verdict = veredicto del ESCÉPTICO (sostiene | debil |
 *     refutado). Verificación adversarial determinista que corre tras detectar:
 *     baja el ranking de hallazgos débiles (materialidad chica, muestra mínima,
 *     estacionalidad) SIN borrarlos. No muta el score del detector (idempotente).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime.
 * Idempotente (hasTable/hasColumn).
 *
 * @param { import("knex").Knex } knex
 */

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('detector_hypotheses'))) {
    await knex.raw(`
      CREATE TABLE finance.detector_hypotheses (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        source            text NOT NULL DEFAULT 'deterministic' CHECK (source IN ('deterministic','ai')),
        titulo            text NOT NULL,
        descripcion       text NOT NULL,
        clase             text NOT NULL CHECK (clase IN ('riesgo','error_captura','oportunidad')),
        propuesta_rule_key text,
        propuesta_params  jsonb,
        evidencia         jsonb,
        score             numeric,
        status            text NOT NULL DEFAULT 'propuesta' CHECK (status IN ('propuesta','aprobada','rechazada','implementada')),
        dedup_key         text NOT NULL,
        reviewed_by       text,
        reviewed_at       timestamptz,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, dedup_key)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_hyp_status ON finance.detector_hypotheses (tenant_id, status, score DESC)`);
    await createTenantRls(knex, 'detector_hypotheses');
  }

  if (!(await knex.schema.withSchema('finance').hasColumn('findings', 'skeptic_verdict'))) {
    await knex.raw(`ALTER TABLE finance.findings ADD COLUMN skeptic_verdict text`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('detector_hypotheses');
  // columna skeptic_verdict se deja (no destructivo).
};
