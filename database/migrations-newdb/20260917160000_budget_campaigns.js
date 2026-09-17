/**
 * Fase PU.5 — Presupuestos: Marketing (catálogo de campañas) (ADR-066, spec §9/§6/§10).
 *
 * "Si Marketing no tiene un módulo, iniciar con un catálogo de campañas y captura controlada dentro de
 * Presupuestos" (spec §6). Una campaña es una DIMENSIÓN sobre las partidas del presupuesto (reusa el
 * ledger de PU.1, no inventa dinero): sus partidas se etiquetan con `campaign_id`, su gasto real = el
 * ejercido de esas partidas.
 *
 *   budget.campaigns               — responsable, objetivo, vigencia, canales, tipo, método de
 *                                    evaluación y REGLA DE ATRIBUCIÓN declarada (spec §9/§10).
 *   budget.budget_lines.campaign_id — etiqueta partida→campaña (aditivo, nullable).
 *   budget.campaign_contributions   — aportaciones de proveedor SEPARADAS, con condición/evidencia y
 *                                    estado (incierta/confirmada/aplicada). NO reducen el gasto
 *                                    automáticamente — sólo lo confirmado (spec §9).
 *
 * Aditivo + idempotente + RLS forzado (convención A.0mt).
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('budget').hasTable('campaigns'))) {
    await knex.raw(`
      CREATE TABLE budget.campaigns (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        name              text NOT NULL,
        objective         text,
        responsible       text,
        campaign_type     text NOT NULL DEFAULT 'publicidad'
                            CHECK (campaign_type IN ('publicidad','materiales','eventos','promociones','descuento_comercial','otro')),
        channels          text,
        start_date        date,
        end_date          date,
        status            text NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador','activa','cerrada')),
        planned_budget    numeric(14,2) NOT NULL DEFAULT 0 CHECK (planned_budget >= 0),
        evaluation_method text,
        attribution_rule  text,
        notes             text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
      )`);
    await knex.raw(`CREATE INDEX ix_budget_campaigns_status ON budget.campaigns (tenant_id, status)`);
    await tenantRls(knex, 'budget', 'campaigns');
  }

  // Etiqueta partida → campaña (aditivo).
  if (!(await knex.schema.withSchema('budget').hasColumn('budget_lines', 'campaign_id'))) {
    await knex.raw(`ALTER TABLE budget.budget_lines ADD COLUMN campaign_id uuid`);
    await knex.raw(`ALTER TABLE budget.budget_lines
                      ADD CONSTRAINT fk_budget_line_campaign
                      FOREIGN KEY (tenant_id, campaign_id) REFERENCES budget.campaigns (tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`CREATE INDEX ix_budget_lines_campaign ON budget.budget_lines (tenant_id, campaign_id)`);
  }

  // Aportaciones de proveedor — separadas, nunca restan automáticamente (spec §9).
  if (!(await knex.schema.withSchema('budget').hasTable('campaign_contributions'))) {
    await knex.raw(`
      CREATE TABLE budget.campaign_contributions (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        campaign_id  uuid NOT NULL,
        supplier     text NOT NULL,
        amount       numeric(14,2) NOT NULL CHECK (amount > 0),
        condition    text,
        status       text NOT NULL DEFAULT 'incierta' CHECK (status IN ('incierta','confirmada','aplicada')),
        evidence     text,
        created_by   text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_by   text,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, campaign_id) REFERENCES budget.campaigns (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_campaign_contrib_campaign ON budget.campaign_contributions (tenant_id, campaign_id, status)`);
    await tenantRls(knex, 'budget', 'campaign_contributions');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('budget').dropTableIfExists('campaign_contributions');
  if (await knex.schema.withSchema('budget').hasColumn('budget_lines', 'campaign_id')) {
    await knex.raw(`ALTER TABLE budget.budget_lines DROP CONSTRAINT IF EXISTS fk_budget_line_campaign`);
    await knex.raw(`DROP INDEX IF EXISTS budget.ix_budget_lines_campaign`);
    await knex.raw(`ALTER TABLE budget.budget_lines DROP COLUMN campaign_id`);
  }
  await knex.schema.withSchema('budget').dropTableIfExists('campaigns');
};
