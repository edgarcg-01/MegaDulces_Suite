/**
 * SM.0 — Schema `reconciliation.*` para el Supervisor de Movimientos (cuadre).
 *
 * El motor calcula el cuadre en 3 planos (inventario/caja/cruce), marca los
 * descuadres, el humano confirma la causa (HITL). Hereda ADR-016/028: motor
 * determinista (SQL), LLM fuera del cálculo, aprendizaje L2 por precisión.
 *
 * 3 tablas (espejan finance.* de Maat.2):
 *   reconciliation.rule_registry        = detectores del motor con aprendizaje L2
 *                                         (precision_score por feedback → auto-supresión).
 *   reconciliation.discrepancies        = bandeja de descuadres con evidencia
 *                                         reproducible + dedup_key idempotente.
 *   reconciliation.discrepancy_feedback = veredictos + causa asignada (dataset L2).
 *
 * Los feeds (analytics.cash_cuts de kdpv_folio_caja, analytics.stock_ledger de
 * kdij) llegan en SM.1/SM.2 con sus importers — son analytics.* (sin RLS, filtro
 * tenant explícito), no van aquí.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime.
 * Services acceden vía TenantKnexService.run(). Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE reconciliation.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE reconciliation.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='reconciliation' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON reconciliation.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON reconciliation.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS reconciliation`);
  await knex.raw(`GRANT USAGE ON SCHEMA reconciliation TO app_runtime`);

  if (!(await knex.schema.withSchema('reconciliation').hasTable('rule_registry'))) {
    await knex.raw(`
      CREATE TABLE reconciliation.rule_registry (
        tenant_id            uuid NOT NULL,
        rule_key             text NOT NULL,
        nombre               text NOT NULL,
        descripcion          text,
        plano                text NOT NULL CHECK (plano IN ('inventario','caja','cruce')),
        params               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- umbrales editables sin deploy
        enabled              boolean NOT NULL DEFAULT true,
        pinned               boolean NOT NULL DEFAULT false,      -- pin humano: nunca auto-suprimir
        precision_score      numeric,                             -- confirmados/(confirmados+falsos), L2
        findings_total       int NOT NULL DEFAULT 0,
        findings_confirmados int NOT NULL DEFAULT 0,
        findings_falsos      int NOT NULL DEFAULT 0,
        suppressed_auto      boolean NOT NULL DEFAULT false,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, rule_key)
      )`);
    await createTenantRls(knex, 'rule_registry');
  }

  if (!(await knex.schema.withSchema('reconciliation').hasTable('discrepancies'))) {
    await knex.raw(`
      CREATE TABLE reconciliation.discrepancies (
        id              uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        rule_key        text NOT NULL,
        plano           text NOT NULL CHECK (plano IN ('inventario','caja','cruce')),
        severity        text NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','critical')),
        status          text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo','en_revision','confirmado','descartado','corregido')),
        score           numeric,                -- 0..1 confianza del detector
        titulo          text NOT NULL,
        resumen         text,
        entity          jsonb,                  -- {sucursal,caja,cajero,sku,doc_folio,fecha}
        periodo         text,                   -- 'YYYY-MM' o 'YYYY-MM-DD'
        esperado        numeric,                -- valor teórico (efectivo esperado / existencia teórica)
        observado       numeric,                -- valor real (arqueo / conteo / kardex)
        diferencia      numeric,                -- observado − esperado (+ sobrante / − faltante)
        importe         numeric NOT NULL DEFAULT 0,  -- $ en juego (|diferencia| a costo/venta)
        causa_probable  text,                   -- sugerida por el detector
        causa_confirmada text,                  -- asignada por el humano (HITL)
        evidencia       jsonb,                  -- params + sample de filas → reproducible
        dedup_key       text NOT NULL,          -- rule_key+entity+periodo canónico (re-runs idempotentes)
        first_seen      timestamptz NOT NULL DEFAULT now(),
        last_seen       timestamptz NOT NULL DEFAULT now(),
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),                 -- para FKs compuestas
        UNIQUE (tenant_id, dedup_key),
        FOREIGN KEY (tenant_id, rule_key) REFERENCES reconciliation.rule_registry (tenant_id, rule_key)
      )`);
    await knex.raw(`CREATE INDEX ix_rec_disc_status ON reconciliation.discrepancies (tenant_id, status, severity)`);
    await knex.raw(`CREATE INDEX ix_rec_disc_plano ON reconciliation.discrepancies (tenant_id, plano, periodo)`);
    await knex.raw(`CREATE INDEX ix_rec_disc_rule ON reconciliation.discrepancies (tenant_id, rule_key, periodo)`);
    await createTenantRls(knex, 'discrepancies');
  }

  if (!(await knex.schema.withSchema('reconciliation').hasTable('discrepancy_feedback'))) {
    await knex.raw(`
      CREATE TABLE reconciliation.discrepancy_feedback (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        discrepancy_id uuid NOT NULL,
        verdict       text NOT NULL CHECK (verdict IN ('util','falso','duplicado','ya_corregido')),
        causa         text,                     -- causa confirmada (merma/robo/error_captura/traspaso_no_registrado/…)
        nota          text,
        created_by    text,
        created_at    timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, discrepancy_id) REFERENCES reconciliation.discrepancies (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_rec_feedback_disc ON reconciliation.discrepancy_feedback (tenant_id, discrepancy_id)`);
    await createTenantRls(knex, 'discrepancy_feedback');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('reconciliation').dropTableIfExists('discrepancy_feedback');
  await knex.schema.withSchema('reconciliation').dropTableIfExists('discrepancies');
  await knex.schema.withSchema('reconciliation').dropTableIfExists('rule_registry');
};
