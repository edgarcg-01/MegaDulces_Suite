/**
 * MAAT.9 (3.0 P3) — HITL: acciones propuestas por Maat con aprobación humana.
 *
 * `finance.proposed_actions` = Maat pasa de solo-avisar a PROPONER trabajo
 * rastreable. Cuando detecta algo accionable (provisión 203 sin descargar,
 * factura sin recepción, saldo a conciliar…), crea una acción en estado
 * `pending_approval` (ADR-013). Un humano la Aprueba o Rechaza; al aprobar se
 * ejecuta el efecto **sobre NUESTRAS tablas** (nunca escribe en Kepler, que es
 * read-only/on-prem) — ej. marcar un hallazgo como en_revision, registrar la
 * decisión, o disparar un flag de plataforma. Todo queda auditado.
 *
 * NO hay ejecución automática: sin aprobación humana, no pasa nada (co-piloto).
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('proposed_actions'))) {
    await knex.raw(`
      CREATE TABLE finance.proposed_actions (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        kind          text NOT NULL,        -- revisar_hallazgo | conciliar_saldo | marcar_documento | nota_contable | otro
        titulo        text NOT NULL,
        descripcion   text,                 -- qué propone Maat y por qué (Markdown corto)
        payload       jsonb,                -- datos de la acción (finding_id, doc, cuenta, monto…)
        efecto        text,                 -- descripción legible del efecto al aprobar
        estado        text NOT NULL DEFAULT 'pending_approval'
                        CHECK (estado IN ('pending_approval','approved','rejected','executed','failed')),
        origen        text NOT NULL DEFAULT 'maat_chat',  -- maat_chat | motor | manual
        finding_id    uuid,                 -- si nace de un hallazgo
        importe       numeric DEFAULT 0,
        created_by    text,                 -- quién la propuso (usuario del chat)
        decided_by    text,                 -- quién aprobó/rechazó
        decided_at    timestamptz,
        executed_at   timestamptz,
        resultado     text,                 -- salida de la ejecución (audit)
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_pa_estado ON finance.proposed_actions (tenant_id, estado, created_at)`);
    await knex.raw(`ALTER TABLE finance.proposed_actions ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.proposed_actions FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='proposed_actions' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.proposed_actions
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.proposed_actions TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('proposed_actions');
};
