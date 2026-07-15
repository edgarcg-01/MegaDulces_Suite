/**
 * FISCAL.3 — Cola de trabajos en Postgres (reemplazo de BullMQ).
 *
 * El proyecto NO usa Redis/BullMQ (regla). Los pipelines pesados (descarga masiva
 * CFDI: solicitud→verificación→paquete→parse) se orquestan sobre esta tabla +
 * Cron + FOR UPDATE SKIP LOCKED. Idempotente por dedup_key. Backoff exponencial
 * y DLQ (status='dead') vía attempts/max_attempts. RLS forzado (tenant scoped).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('jobs'))) {
    await knex.raw(`
      CREATE TABLE fiscal.jobs (
        id            uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL,
        queue         text NOT NULL,
        type          text NOT NULL,
        payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
        status        text NOT NULL DEFAULT 'pending',   -- pending|running|done|failed|dead
        attempts      int  NOT NULL DEFAULT 0,
        max_attempts  int  NOT NULL DEFAULT 8,
        run_after     timestamptz NOT NULL DEFAULT now(),
        dedup_key     text,
        last_error    text,
        result        jsonb,
        locked_at     timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id)
      )`);
    await knex.raw(`ALTER TABLE fiscal.jobs ADD CONSTRAINT fiscal_jobs_status_check
      CHECK (status IN ('pending','running','done','failed','dead'))`);
    // Claim: due jobs pendientes, orden FIFO por run_after.
    await knex.raw(`CREATE INDEX ix_fiscal_jobs_due ON fiscal.jobs (tenant_id, status, run_after)`);
    // Dedup idempotente por (tenant, dedup_key) cuando se provee.
    await knex.raw(`CREATE UNIQUE INDEX ux_fiscal_jobs_dedup ON fiscal.jobs (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL`);
    await knex.raw(`ALTER TABLE fiscal.jobs ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.jobs FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.jobs
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.jobs TO app_runtime`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.schema.withSchema('fiscal').dropTableIfExists('jobs');
};
