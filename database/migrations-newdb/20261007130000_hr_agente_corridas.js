/**
 * Fase RH · `[RH.1.5]` — la bitácora del agente de alertas de asistencia, una fila por sitio.
 *
 * Viene de `agente_corridas` de Mega Talento. No es adorno:
 *   · la pantalla puede decir «revisado solo, hace 12 min» en vez de pedir que alguien apriete
 *     un botón;
 *   · la HUELLA (`último dato | checadas en la ventana`) deja SALTAR un sitio cuyos datos no se
 *     movieron, en vez de re-analizar todos cada media hora;
 *   · un fallo queda guardado con su mensaje REAL, por sitio. El latido de `analytics.cron_runs`
 *     dice si la pasada corrió; esto dice qué pasó en cada sitio.
 *
 * La ventana guardada (`window_from`/`window_to`) termina en el último día CON DATO del sitio,
 * nunca en hoy: los relojes se descargan a ritmos distintos y medir contra hoy convierte "nadie
 * bajó el reloj" en faltas para todo el sitio (Mega Talento ya marcó así 77 de 162 personas).
 * `first_data` antes de `window_from` = historia que la ventana rodante no cubre: se declara.
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS hr`);
  if (await knex.schema.withSchema('hr').hasTable('attendance_agent_runs')) return;

  await knex.raw(`
    CREATE TABLE hr.attendance_agent_runs (
      tenant_id       uuid NOT NULL,
      site_code       text NOT NULL,
      window_from     date,
      window_to       date,
      first_data      date,
      last_data       date,
      fingerprint     text,                                -- 'último dato|checadas en la ventana'
      skipped         boolean NOT NULL DEFAULT false,      -- la huella no cambió: no se re-analizó
      persons         integer,
      ex_workers      integer,                             -- personas cuyo análisis se cortó en su última checada
      created         integer,
      updated         integer,
      deleted         integer,
      pending         integer,                             -- alertas esperando a RH en el sitio
      duration_ms     integer,
      error           text,
      ran_at          timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, site_code),
      FOREIGN KEY (tenant_id, site_code) REFERENCES hr.attendance_sites (tenant_id, code) ON UPDATE CASCADE ON DELETE CASCADE
    )`);
  await knex.raw(`ALTER TABLE hr.attendance_agent_runs ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE hr.attendance_agent_runs FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='hr' AND tablename='attendance_agent_runs' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON hr.attendance_agent_runs
          USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON hr.attendance_agent_runs TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE hr.attendance_agent_runs IS 'Fase RH: última corrida del agente de alertas por sitio (antes agente_corridas). La ventana termina en el último día con dato del sitio, no en hoy.'`);
  await knex.raw(`GRANT USAGE ON SCHEMA hr TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('hr').dropTableIfExists('attendance_agent_runs');
};
