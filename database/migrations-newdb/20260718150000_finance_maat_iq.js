/**
 * MAAT-IQ — el modelo que aprende (ADR-028 + ADR-021 Horus-L).
 *
 * MIQ.2: espina de aprendizaje SUPERVISADO, determinista y auditable (SIN
 * fine-tuning del LLM). El feedback humano (confirmar/descartar) es la etiqueta;
 * un modelo de ranking (regresión logística in-proc) predice P(hallazgo real y
 * material) y ordena la bandeja. Los coeficientes viven en tabla → explicable.
 *
 * 2 tablas nuevas + 2 columnas en finance.findings:
 *   finance.finding_features = feature store (1 fila por hallazgo). `features`
 *                              jsonb = vector numérico; `label` = etiqueta del
 *                              feedback (1 real / 0 falso / NULL sin etiquetar).
 *                              Es el dataset de entrenamiento y la cola de
 *                              active-learning (uncertainty sampling).
 *   finance.finding_model    = modelos entrenados, versionados. `coef` guarda
 *                              intercepto + pesos + media/desv por feature (para
 *                              estandarizar al scorear) + feature_names + métricas.
 *   finance.findings.model_score   = P(real&material) del modelo vigente (0..1).
 *   finance.findings.model_version = versión que la calculó (0 = cold-start, usa
 *                              el score del detector).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime.
 * Idempotente (hasTable/hasColumn). NO toca datos existentes.
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

  if (!(await knex.schema.withSchema('finance').hasTable('finding_features'))) {
    await knex.raw(`
      CREATE TABLE finance.finding_features (
        tenant_id   uuid NOT NULL,
        finding_id  uuid NOT NULL,
        rule_key    text NOT NULL,
        features    jsonb NOT NULL,          -- {f_log_importe, f_score, f_sev, ...} vector numérico
        label       int,                     -- 1 real (util/corregido) · 0 falso (falso/duplicado) · NULL sin feedback
        labeled_at  timestamptz,
        importe     numeric NOT NULL DEFAULT 0,
        model_score numeric,                 -- P(real) del último scoring (cache para active-learning)
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, finding_id),
        FOREIGN KEY (tenant_id, finding_id) REFERENCES finance.findings (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_fin_feat_label ON finance.finding_features (tenant_id, label)`);
    await knex.raw(`CREATE INDEX ix_fin_feat_rule ON finance.finding_features (tenant_id, rule_key)`);
    await createTenantRls(knex, 'finding_features');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('finding_model'))) {
    await knex.raw(`
      CREATE TABLE finance.finding_model (
        tenant_id     uuid NOT NULL,
        version       int  NOT NULL,
        algo          text NOT NULL DEFAULT 'logreg',
        feature_names jsonb NOT NULL,        -- orden canónico de features
        coef          jsonb NOT NULL,        -- {intercept, weights[], mean[], std[]}
        n_train       int  NOT NULL DEFAULT 0,
        n_pos         int  NOT NULL DEFAULT 0,
        metrics       jsonb,                 -- {accuracy, precision, recall, auc, ...}
        notes         text,
        trained_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, version)
      )`);
    await createTenantRls(knex, 'finding_model');
  }

  if (!(await knex.schema.withSchema('finance').hasColumn('findings', 'model_score'))) {
    await knex.raw(`ALTER TABLE finance.findings ADD COLUMN model_score numeric`);
  }
  if (!(await knex.schema.withSchema('finance').hasColumn('findings', 'model_version'))) {
    await knex.raw(`ALTER TABLE finance.findings ADD COLUMN model_version int NOT NULL DEFAULT 0`);
  }
  // Orden de la bandeja por prioridad aprendida (model_score) cuando exista.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_findings_model ON finance.findings (tenant_id, status, model_score DESC)`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('finding_features');
  await knex.schema.withSchema('finance').dropTableIfExists('finding_model');
  // columnas se dejan (no destructivo); si se requiere revertir, hacerlo a mano.
};
