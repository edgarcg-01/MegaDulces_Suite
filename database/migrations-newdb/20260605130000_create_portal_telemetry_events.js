/**
 * Portal B2B — observabilidad (E1 del review CEO del Portal_MegaDulces).
 *
 * Sink de telemetría del portal: Core Web Vitals (LCP/INP/CLS/FCP/TTFB),
 * errores (uncaught/unhandledrejection/http) y funnel de negocio (page_view,
 * cart_line_added, order_confirmed, catalog_search). El portal manda lotes por
 * `navigator.sendBeacon` a `POST /api/telemetry/portal`.
 *
 * DECISIÓN (review CEO): tabla SIN RLS y endpoint @Public(). Razón: el beacon
 * llega también SIN sesión (página de login, o al cerrar el tab tras logout),
 * así que no hay tenant context que aplicar. Telemetría es infra transversal,
 * no dato de negocio del tenant — por eso NO seguimos el patrón RLS del resto
 * de commercial.*. `tenant_id`/`user_id` se guardan best-effort (decodificados
 * del JWT si el beacon lo trae) y quedan nullable.
 *
 * Retención: esta tabla crece rápido. Follow-up recomendado: job de cron que
 * borre filas > 90 días (o particionar por mes). No se implementa aquí.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('portal_telemetry_events');
  if (!exists) {
    await knex.schema.withSchema('commercial').createTable('portal_telemetry_events', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // 'web_vital' | 'error' | 'event'
      t.string('kind', 32).notNullable();
      // nombre del vital/evento (LCP, page_view, http_error, ...)
      t.string('name', 120).notNullable();
      // valor numérico (ms para vitals, score para CLS); null para errores/eventos
      t.double('value');
      // rating del web-vital ('good'|'needs-improvement'|'poor'); null si no aplica
      t.string('rating', 32);
      // payload libre del evento (id del vital, status http, product_id, ...)
      t.jsonb('props');

      // agrupador por carga de página (no es PII)
      t.string('session_id', 80);
      t.string('env', 24);
      t.string('release', 60);
      // path de la ruta (sin query) — el cliente ya manda solo pathname
      t.string('url', 512);

      // Atribución best-effort (nullable a propósito — el beacon puede ser anónimo)
      t.uuid('tenant_id');
      t.uuid('user_id');
      t.string('ip', 64);
      t.string('user_agent', 400);

      // ts del evento en el cliente vs ts de recepción en el server
      t.timestamp('client_ts', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

      // Índices para las agregaciones del dashboard (p75/p99 por vital, funnel,
      // tasa de error) acotadas por ventana de tiempo.
      t.index(['kind', 'name', 'created_at'], 'idx_portal_tel_kind_name_time');
      t.index(['created_at'], 'idx_portal_tel_time');
      t.index(['tenant_id', 'created_at'], 'idx_portal_tel_tenant_time');
    });

    await knex.raw(`
      ALTER TABLE commercial.portal_telemetry_events
      ADD CONSTRAINT portal_telemetry_kind_check
      CHECK (kind IN ('web_vital','error','event'))
    `);

    // SIN RLS a propósito (ver cabecera). El endpoint es público y app_runtime
    // inserta sin tenant context. Solo damos los privilegios mínimos.
    await knex.raw(`GRANT SELECT, INSERT ON commercial.portal_telemetry_events TO app_runtime`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('portal_telemetry_events');
};
