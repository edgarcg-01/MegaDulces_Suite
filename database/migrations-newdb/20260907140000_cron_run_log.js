/**
 * [VP.3.3] `analytics.cron_run_log` — la HISTORIA de corridas de los feeds (ADR-056).
 *
 * ── POR QUÉ ──────────────────────────────────────────────────────────────────────────────
 * `analytics.cron_runs` tiene `PRIMARY KEY (tenant_id, job_key)`: **un renglón por job**, UPSERT en
 * cada corrida. Es exactamente lo que necesita el tablero de Salud BD —"¿está sano AHORA?"— y es
 * incapaz de contestar lo que se pregunta cuando un número sorprende:
 *
 *   · *"¿cuántas filas tocó el importer de precios el martes?"*
 *   · *"¿cuántas veces falló este mes?"* — y por lo tanto: *¿esto es nuevo o lleva semanas?*
 *   · *"¿cuándo dejó de correr?"* — el `last_finish` de hoy no dice desde cuándo viene el hueco.
 *
 * Es el mismo agujero que VP.3.1 cerró para los datos maestros, un piso más abajo: se conserva el
 * ESTADO y se tira el EVENTO. Y pesa distinto acá, porque cuando un tablero "bajó sin explicación"
 * lo primero que hay que poder mirar es qué corrió y qué no la noche anterior.
 *
 * ── POR QUÉ UN TRIGGER Y NO TOCAR A LOS ESCRITORES ───────────────────────────────────────
 * `cron_runs` la escriben ~15 lugares distintos: `cron-heartbeat.js` (13 importers),
 * `AnalyticsRefreshService` con knex directo, los shippers del ODS… Cablear el log en cada uno
 * sería 15 ediciones —varias sobre archivos que corren en prod— y garantiza que el próximo escritor
 * se olvide. El trigger lo hace una vez y cubre a todos, incluidos los que todavía no existen.
 * Mismo criterio que VP.3.1.
 *
 * ── SÓLO SE REGISTRAN LAS CORRIDAS QUE TERMINAN ──────────────────────────────────────────
 * `cron-heartbeat` escribe dos veces por corrida: `begin()` deja `status='running'` y `end()` lo
 * cierra en `ok`/`error`. Registrar las dos duplicaría el log sin agregar nada — lo que se pregunta
 * es por corridas TERMINADAS (cuántas filas, cuántas fallas). Se registra el cierre: **una fila por
 * corrida**. Un job que arranca y nunca cierra no deja fila acá, y eso es correcto: su síntoma es
 * `status='running'` viejo en `cron_runs`, que es justamente lo que el sensor `maxRunH` de
 * `db-health` ya vigila como COLGADO.
 *
 * ── EL TRIGGER SÍ SE TRAGA ERRORES, al revés que el de VP.3.1 ────────────────────────────
 * Acá la asimetría se invierte a propósito. En datos maestros, perder la historia es perder el
 * único registro de un cambio de dinero → el trigger lanza. Acá el hecho primario (¿corrió? ¿cómo
 * terminó?) **sobrevive igual en `cron_runs`**: el log es una comodidad histórica. Tumbar el latido
 * de un feed por no poder escribir su bitácora sería cambiar un problema chico por uno grande —
 * es el mismo criterio con el que `cron-heartbeat.js` nunca lanza.
 *
 * ── RETENCIÓN ────────────────────────────────────────────────────────────────────────────
 * A ritmo actual (~25 jobs, el más rápido cada ~2 min) son del orden de 2-3k filas/día. Se deja
 * `analytics.prune_cron_run_log(dias)` **escrita y SIN agendar**: purgar es una decisión de
 * negocio (cuánta historia se quiere) y agendar un borrado que nadie pidió es cómo se pierde
 * justo la evidencia del incidente que se está investigando.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('cron_run_log'))) {
    await knex.raw(`
      CREATE TABLE analytics.cron_run_log (
        id            bigserial PRIMARY KEY,
        tenant_id     uuid        NOT NULL,
        job_key       text        NOT NULL,
        status        text        NOT NULL,
        started_at    timestamptz,
        finished_at   timestamptz,
        rows_affected bigint,
        duration_ms   bigint,
        host          text,
        note          text,
        error         text,
        logged_at     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT crl_status_terminal CHECK (status IN ('ok','error'))
      )`);

    // "¿qué pasó con ESTE job?" — la serie de un feed, que es como se contesta
    // "¿lleva semanas fallando o es de hoy?".
    await knex.raw(`CREATE INDEX ix_crl_job ON analytics.cron_run_log
      (tenant_id, job_key, finished_at DESC)`);
    // "¿qué corrió anoche?" — la lectura cronológica cuando un tablero amaneció distinto.
    await knex.raw(`CREATE INDEX ix_crl_cronologico ON analytics.cron_run_log
      (tenant_id, finished_at DESC)`);
    // "¿qué falló?" — índice PARCIAL: los errores son la minoría y son lo que se busca.
    await knex.raw(`CREATE INDEX ix_crl_errores ON analytics.cron_run_log
      (tenant_id, finished_at DESC) WHERE status = 'error'`);

    await knex.raw(`GRANT SELECT, INSERT ON analytics.cron_run_log TO app_runtime`);
    await knex.raw(`GRANT USAGE, SELECT ON SEQUENCE analytics.cron_run_log_id_seq TO app_runtime`);
    // Sin UPDATE ni DELETE para app_runtime: una bitácora que se puede editar no es una bitácora.
    // El prune corre como owner, a mano.

    await knex.raw(`COMMENT ON TABLE analytics.cron_run_log IS
      'VP.3.3 (ADR-056) — historia de corridas TERMINADAS de feeds/crons. La escribe el trigger sobre analytics.cron_runs (que sólo conserva la última). Contesta "cuantas filas toco el martes" y "cuantas veces fallo este mes". Retención: analytics.prune_cron_run_log(dias), escrita y sin agendar a propósito.'`);
  }

  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.log_cron_run()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Sólo cierres. 'running' es un estado, no un hecho consumado.
      IF NEW.status NOT IN ('ok','error') THEN RETURN NULL; END IF;
      -- Y sólo la TRANSICIÓN a cierre: un UPSERT que reescribe un 'ok' idéntico (mismo cierre) no
      -- es una corrida nueva. Se compara last_finish, que avanza una vez por corrida.
      IF TG_OP = 'UPDATE' AND OLD.status = NEW.status
         AND OLD.last_finish IS NOT DISTINCT FROM NEW.last_finish THEN
        RETURN NULL;
      END IF;

      BEGIN
        INSERT INTO analytics.cron_run_log
          (tenant_id, job_key, status, started_at, finished_at, rows_affected, duration_ms, host, note, error)
        VALUES
          (NEW.tenant_id, NEW.job_key, NEW.status, NEW.last_start, NEW.last_finish,
           NEW.rows_affected, NEW.duration_ms, NEW.host, NEW.note, NEW.error);
      EXCEPTION WHEN OTHERS THEN
        -- A propósito, y al revés que el trigger de VP.3.1: el hecho primario (corrió, y cómo
        -- terminó) sobrevive en cron_runs. Tumbar el latido de un feed por no poder escribir su
        -- bitácora cambiaría un problema chico por uno grande.
        RAISE WARNING 'cron_run_log: no se pudo registrar % (%): %', NEW.job_key, NEW.status, SQLERRM;
      END;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;

    COMMENT ON FUNCTION analytics.log_cron_run() IS
    'VP.3.3 — AFTER INSERT/UPDATE en analytics.cron_runs. Registra UNA fila por corrida TERMINADA en analytics.cron_run_log. Nunca lanza: el hecho primario ya vive en cron_runs.';
  `);

  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_cron_run_log ON analytics.cron_runs;
    CREATE TRIGGER trg_cron_run_log
      AFTER INSERT OR UPDATE ON analytics.cron_runs
      FOR EACH ROW
      EXECUTE FUNCTION analytics.log_cron_run();
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION analytics.prune_cron_run_log(dias int DEFAULT 180)
    RETURNS bigint AS $$
    DECLARE n bigint;
    BEGIN
      DELETE FROM analytics.cron_run_log WHERE finished_at < now() - (dias || ' days')::interval;
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN n;
    END;
    $$ LANGUAGE plpgsql;

    COMMENT ON FUNCTION analytics.prune_cron_run_log(int) IS
    'VP.3.3 — purga manual de la bitácora. SIN agendar a propósito: cuánta historia se conserva es decisión de negocio, y un borrado automático que nadie pidió es cómo se pierde la evidencia del incidente que se está investigando.';
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cron_run_log ON analytics.cron_runs`).catch(() => {});
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.log_cron_run()`);
  await knex.raw(`DROP FUNCTION IF EXISTS analytics.prune_cron_run_log(int)`);
  await knex.raw(`DROP TABLE IF EXISTS analytics.cron_run_log`);
};
