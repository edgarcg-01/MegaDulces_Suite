/**
 * Heartbeat de ejecución de crons/feeds. Cada job (insert/update) registra su última
 * corrida: cuándo empezó, cuándo terminó, OK o error, filas y duración. Salud BD lee
 * esta tabla (grupo "Crons") y alerta si un job falla o no corre en su cadencia — así se
 * detecta de raíz el caso "el cron corría pero fallaba al escribir" (ECONNRESET Wincaja).
 *
 * Sin RLS (patrón analytics.*, tenant_id explícito). PK (tenant_id, job_key): un renglón
 * por job, UPSERT en cada corrida. Grant app_runtime (los feeds escriben con ese rol o postgres).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('cron_runs'))) {
    await knex.raw(`
      CREATE TABLE analytics.cron_runs (
        tenant_id     uuid NOT NULL,
        job_key       text NOT NULL,
        label         text,
        last_start    timestamptz,
        last_finish   timestamptz,
        status        text NOT NULL DEFAULT 'running',  -- running | ok | error
        rows_affected bigint,
        duration_ms   bigint,
        note          text,
        error         text,
        host          text,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, job_key),
        CONSTRAINT cron_runs_status_valid CHECK (status IN ('running','ok','error'))
      )`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.cron_runs TO app_runtime`);
    await knex.raw(`COMMENT ON TABLE analytics.cron_runs IS 'Heartbeat de ejecución de crons/feeds (Salud BD grupo Crons).'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.cron_runs`);
};
