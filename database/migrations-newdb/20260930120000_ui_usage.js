'use strict';
/**
 * [UX.0] `analytics.ui_usage` + `analytics.ui_usage_users` — QUÉ PANTALLAS SE USAN.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────
 *
 * Medido el 2026-09-30: la Suite tiene **285 pantallas desplegadas** y **cero** telemetría de
 * uso. Caddy no loguea accesos (`log` no aparece en su Caddyfile), el API no loguea rutas HTTP,
 * y la única tabla de eventos es `commercial.portal_telemetry_events`, que sólo cubre el portal
 * B2B. O sea que hoy **nadie puede decir qué pantalla se abre y cuál no**.
 *
 * No es una curiosidad: es el agujero que fundó la Fase IC. El módulo de inventario estaba
 * completo y en prod con **6 folios, todos `cancelled`** — *"no faltaba módulo, faltaba que se
 * usara"*. Sin esta tabla, priorizar una auditoría de 285 pantallas es opinión.
 *
 * ── Qué se guarda, y qué NO ──────────────────────────────────────────────────────────────
 *
 * Se guarda el **patrón de ruta de Nest** (`/commercial/orders/:id`), nunca la URL con datos
 * dentro. Dos razones: la cardinalidad (con IDs serían millones de filas por nada) y que una
 * URL cruda arrastra identificadores de clientes y documentos a una tabla de métricas.
 * Tampoco se guarda el query string.
 *
 * El grano es el **día**, no la hora: la pregunta es *"¿esta pantalla se usa?"*, y por hora
 * multiplicaba las filas por 24 para responder lo mismo. Medido en régimen: unos pocos
 * centenares de filas por día.
 *
 * ── Dos tablas y no una, porque son dos preguntas ────────────────────────────────────────
 *
 *  · `ui_usage`       — cuántas veces y cuánto tardó, por (día, método, ruta, rol).
 *  · `ui_usage_users` — QUIÉN, por (día, ruta, usuario). Contar usuarios distintos dentro de
 *    `ui_usage` obligaría a deduplicar entre descargas del buffer, y un contador que suma dos
 *    veces al mismo usuario es un número que miente. Acá la unicidad la pone la PK.
 *
 * ── ⛔ La latencia que guarda es la del SERVIDOR, y eso hay que decirlo ───────────────────
 *
 * `ms_total`/`ms_max` miden lo que tardó el handler, no lo que esperó la persona: no incluyen
 * la red, ni el render de Angular, ni las otras consultas que la misma pantalla dispara en
 * paralelo. Sirve para encontrar el endpoint caro, no para prometer una experiencia.
 *
 * Sin RLS y con `tenant_id`, igual que `analytics.cron_runs` y `analytics.period_close`: son
 * tablas operativas que escribe un proceso de fondo sin contexto de tenant.
 *
 * Aditiva: sólo crea dos tablas nuevas.
 */

exports.up = async function up(knex) {
  const [{ hay }] = (await knex.raw(
    `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') AS hay`)).rows;
  if (!hay) await knex.raw('CREATE SCHEMA analytics');

  if (!(await knex.schema.withSchema('analytics').hasTable('ui_usage'))) {
    await knex.schema.withSchema('analytics').createTable('ui_usage', (t) => {
      t.uuid('tenant_id').notNullable();
      t.date('fecha').notNullable();
      t.text('metodo').notNullable();
      // El PATRÓN, no la URL: `/commercial/orders/:id`, jamás `/commercial/orders/9f3c…`.
      t.text('ruta').notNullable();
      // `(anonimo)` y no NULL: una columna de la PK no puede ser nula, y "sin sesión" es un
      // valor legítimo que hay que poder contar (el verificador de precios es público).
      t.text('role_name').notNullable().defaultTo('(anonimo)');
      t.integer('hits').notNullable().defaultTo(0);
      t.bigInteger('ms_total').notNullable().defaultTo(0);
      t.integer('ms_max').notNullable().defaultTo(0);
      t.integer('errores').notNullable().defaultTo(0);
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'fecha', 'metodo', 'ruta', 'role_name']);
    });
    await knex.raw(`CREATE INDEX ix_ui_usage_ruta ON analytics.ui_usage (ruta, fecha DESC)`);
    await knex.raw(`CREATE INDEX ix_ui_usage_fecha ON analytics.ui_usage (fecha DESC)`);
  }

  if (!(await knex.schema.withSchema('analytics').hasTable('ui_usage_users'))) {
    await knex.schema.withSchema('analytics').createTable('ui_usage_users', (t) => {
      t.uuid('tenant_id').notNullable();
      t.date('fecha').notNullable();
      t.text('ruta').notNullable();
      t.uuid('user_id').notNullable();
      t.text('role_name');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'fecha', 'ruta', 'user_id']);
    });
    await knex.raw(
      `CREATE INDEX ix_ui_usage_users_ruta ON analytics.ui_usage_users (ruta, fecha DESC)`);
  }

  for (const tbl of ['ui_usage', 'ui_usage_users']) {
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.${tbl} TO app_runtime`);
  }

  await knex.raw(`COMMENT ON TABLE analytics.ui_usage IS
    'UX.0 - Uso y latencia del API por (dia, metodo, PATRON de ruta, rol). Alimentada por UsageMetricsInterceptor, que acumula en memoria y descarga cada 60 s. Existe porque al 2026-09-30 la Suite tenia 285 pantallas desplegadas y CERO telemetria: ni Caddy loguea accesos ni el API loguea rutas, asi que nadie podia decir que pantalla se usa. Guarda el PATRON (/commercial/orders/:id), nunca la URL con datos: por cardinalidad y para no arrastrar identificadores de clientes a una tabla de metricas. Grano DIARIO a proposito. ⛔ ms_total/ms_max son tiempo de SERVIDOR: no incluyen red, render, ni las otras consultas que la misma pantalla dispara -- sirven para hallar el endpoint caro, no para prometer una experiencia. Sin RLS con tenant_id, como cron_runs.'`);
  await knex.raw(`COMMENT ON TABLE analytics.ui_usage_users IS
    'UX.0 - QUIEN abrio que, por (dia, ruta, usuario). Tabla aparte de ui_usage porque contar usuarios distintos ahi obligaria a deduplicar entre descargas del buffer, y un contador que suma dos veces al mismo usuario es un numero que miente: aca la unicidad la pone la PK.'`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('ui_usage_users');
  await knex.schema.withSchema('analytics').dropTableIfExists('ui_usage');
};
