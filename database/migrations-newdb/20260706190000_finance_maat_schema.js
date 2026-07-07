/**
 * MAAT.0 — Schema `finance.*` para la AI de Finanzas (ADR-028).
 *
 * 7 tablas:
 *   finance.knowledge        = base de conocimiento curada (lo que Maat "sabe"
 *                              además de la data): definiciones, hechos, reglas
 *                              de negocio e issues conocidos. Seed desde
 *                              KEPLER_CONTABILIDAD_MODELO.md; crece vía chat.
 *   finance.baselines        = estadísticos "lo normal" (L1): μ/σ/p95 por
 *                              cuenta×sucursal×mes, proveedor×SKU, DPO, Benford.
 *   finance.rule_registry    = detectores del motor de patrones con aprendizaje
 *                              L2 (precision_score por feedback → auto-supresión).
 *   finance.findings         = hallazgos v2 (supersede analytics.expense_findings)
 *                              con evidencia reproducible + dedup_key idempotente.
 *   finance.finding_feedback = veredictos de Finanzas (útil/falso/…) — el dataset
 *                              de entrenamiento del L2+.
 *   finance.chat_sessions / finance.chat_messages = audit trail completo del chat
 *                              (tool calls, tokens, 👍/👎).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado (current_tenant_id()) +
 * grants app_runtime. Los services acceden vía TenantKnexService.run().
 * Idempotente (hasTable). NO toca tablas existentes.
 *
 * @param { import("knex").Knex } knex
 */

async function createTenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  await knex.raw(`GRANT USAGE ON SCHEMA finance TO app_runtime`);

  if (!(await knex.schema.withSchema('finance').hasTable('knowledge'))) {
    await knex.raw(`
      CREATE TABLE finance.knowledge (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        kind        text NOT NULL CHECK (kind IN ('definicion','hecho','regla_negocio','issue_conocido')),
        title       text NOT NULL,
        body        text NOT NULL,          -- markdown corto
        source      text NOT NULL DEFAULT 'seed' CHECK (source IN ('seed','chat','finanzas')),
        status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
        created_by  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, kind, title)     -- seeds/saves idempotentes por upsert
      )`);
    await knex.raw(`CREATE INDEX ix_fin_knowledge_kind ON finance.knowledge (tenant_id, kind, status)`);
    await createTenantRls(knex, 'knowledge');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('baselines'))) {
    await knex.raw(`
      CREATE TABLE finance.baselines (
        tenant_id   uuid NOT NULL,
        scope       text NOT NULL,          -- cuenta_suc_mes | proveedor_sku | proveedor_dpo | benford_cuenta
        key_text    text NOT NULL,          -- clave canónica serializada (PK estable)
        key         jsonb NOT NULL,         -- {cuenta,sucursal} / {proveedor,sku} / …
        stats       jsonb NOT NULL,         -- {mean,stddev,p50,p95,n,months,…}
        computed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, scope, key_text)
      )`);
    await createTenantRls(knex, 'baselines');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('rule_registry'))) {
    await knex.raw(`
      CREATE TABLE finance.rule_registry (
        tenant_id            uuid NOT NULL,
        rule_key             text NOT NULL,
        nombre               text NOT NULL,
        descripcion          text,
        clase                text NOT NULL CHECK (clase IN ('riesgo','error_captura','oportunidad')),
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

  if (!(await knex.schema.withSchema('finance').hasTable('findings'))) {
    await knex.raw(`
      CREATE TABLE finance.findings (
        id          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        rule_key    text NOT NULL,
        clase       text NOT NULL CHECK (clase IN ('riesgo','error_captura','oportunidad')),
        severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
        status      text NOT NULL DEFAULT 'nuevo' CHECK (status IN ('nuevo','en_revision','confirmado','descartado','corregido')),
        score       numeric,                -- 0..1 confianza del detector
        titulo      text NOT NULL,
        resumen     text,
        entity      jsonb,                  -- {cuenta,proveedor,sucursal,doc_tipo,doc_folio,sku}
        periodo     text,                   -- 'YYYY-MM'
        importe     numeric DEFAULT 0,      -- $ en juego
        evidencia   jsonb,                  -- params + sample de filas → reproducible
        dedup_key   text NOT NULL,          -- rule_key+entity+periodo canónico (re-runs idempotentes)
        first_seen  timestamptz NOT NULL DEFAULT now(),
        last_seen   timestamptz NOT NULL DEFAULT now(),
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),             -- para FKs compuestas
        UNIQUE (tenant_id, dedup_key),
        FOREIGN KEY (tenant_id, rule_key) REFERENCES finance.rule_registry (tenant_id, rule_key)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_findings_status ON finance.findings (tenant_id, status, severity)`);
    await knex.raw(`CREATE INDEX ix_fin_findings_rule ON finance.findings (tenant_id, rule_key, periodo)`);
    await createTenantRls(knex, 'findings');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('finding_feedback'))) {
    await knex.raw(`
      CREATE TABLE finance.finding_feedback (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        finding_id  uuid NOT NULL,
        verdict     text NOT NULL CHECK (verdict IN ('util','falso','duplicado','ya_corregido')),
        nota        text,
        created_by  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, finding_id) REFERENCES finance.findings (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_fin_feedback_finding ON finance.finding_feedback (tenant_id, finding_id)`);
    await createTenantRls(knex, 'finding_feedback');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('chat_sessions'))) {
    await knex.raw(`
      CREATE TABLE finance.chat_sessions (
        id          uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        user_id     uuid,
        username    text,
        started_at  timestamptz NOT NULL DEFAULT now(),
        last_at     timestamptz NOT NULL DEFAULT now(),
        turns       int NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_chat_sessions_user ON finance.chat_sessions (tenant_id, username, last_at)`);
    await createTenantRls(knex, 'chat_sessions');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('chat_messages'))) {
    await knex.raw(`
      CREATE TABLE finance.chat_messages (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        session_id  uuid NOT NULL,
        role        text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
        content     text,
        tool_calls  jsonb,                  -- [{name, input, ms, rows}] — evidencia de cada respuesta
        tokens_in   int,
        tokens_out  int,
        feedback    text CHECK (feedback IN ('up','down')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, session_id) REFERENCES finance.chat_sessions (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_fin_chat_messages_session ON finance.chat_messages (tenant_id, session_id, created_at)`);
    await createTenantRls(knex, 'chat_messages');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('chat_messages');
  await knex.schema.withSchema('finance').dropTableIfExists('chat_sessions');
  await knex.schema.withSchema('finance').dropTableIfExists('finding_feedback');
  await knex.schema.withSchema('finance').dropTableIfExists('findings');
  await knex.schema.withSchema('finance').dropTableIfExists('rule_registry');
  await knex.schema.withSchema('finance').dropTableIfExists('baselines');
  await knex.schema.withSchema('finance').dropTableIfExists('knowledge');
};
