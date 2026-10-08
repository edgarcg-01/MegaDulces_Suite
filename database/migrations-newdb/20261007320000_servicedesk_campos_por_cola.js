'use strict';
/**
 * `[MS.7.4]` — Campos propios por cola. `FASE_MS7_MANTENIMIENTO.md` (decisión M8).
 *
 * Cada cola declara qué MÁS pregunta al reportar (un sí/no, una opción de una lista, un texto o una foto) sin tocar código: lo que
 * hoy sería un `if (cola === ...)` pasa a ser una fila de configuración. La respuesta se guarda en `requests.extra` (un objeto
 * `{ codigo: valor }`).
 *
 * ── Qué agrega ────────────────────────────────────────────────────────────────────────────────
 * · `servicedesk.queue_fields` — la definición del campo: código, pregunta, tipo (`boolean|select|text|photo`), si es requerido,
 *   opciones (sólo `select`), orden y si está activo. Apagar no borra (los tickets viejos conservan sus respuestas y la pregunta con
 *   que se hicieron). El código y el tipo NO cambian: cambiarlos invalidaría lo ya guardado.
 * · `requests.extra jsonb NOT NULL DEFAULT '{}'` — lo contestado. La base exige que sea un OBJETO.
 *
 * ── Qué NO agrega ─────────────────────────────────────────────────────────────────────────────
 * · Ningún campo sembrado: ni Mantenimiento ni TI lo usan hoy (la foto sigue siendo un adjunto opcional, decisión de Sistemas).
 *   `requests.is_test` del plan no se construye aquí: nadie lo pidió y un campo sin dueño es deuda.
 *
 * Aditiva, idempotente y reversible. RLS forzado + grants por tabla a `app_runtime` (sin DELETE: apagar no borra).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS servicedesk.queue_fields (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      queue_id    uuid        NOT NULL,
      code        text        NOT NULL,
      label       text        NOT NULL,
      type        text        NOT NULL,
      required    boolean     NOT NULL DEFAULT false,
      options     jsonb       NOT NULL DEFAULT '[]'::jsonb,
      sort_order  integer     NOT NULL DEFAULT 100,
      active      boolean     NOT NULL DEFAULT true,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid,
      PRIMARY KEY (id),
      CONSTRAINT queue_fields_tenant_id_uk UNIQUE (tenant_id, id),
      CONSTRAINT queue_fields_code_uk UNIQUE (tenant_id, queue_id, code),
      CONSTRAINT queue_fields_queue_fk FOREIGN KEY (tenant_id, queue_id) REFERENCES servicedesk.queues (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT queue_fields_code_ck CHECK (code ~ '^[a-z][a-z0-9_]{0,29}$'),
      CONSTRAINT queue_fields_label_ck CHECK (length(btrim(label)) BETWEEN 1 AND 80),
      CONSTRAINT queue_fields_type_ck CHECK (type IN ('boolean', 'select', 'text', 'photo')),
      CONSTRAINT queue_fields_options_array_ck CHECK (jsonb_typeof(options) = 'array'),
      -- Un select necesita de 2 a 20 opciones; los demás tipos no llevan ninguna.
      CONSTRAINT queue_fields_options_ck CHECK (
        (type = 'select' AND jsonb_array_length(options) BETWEEN 2 AND 20)
        OR (type <> 'select' AND jsonb_array_length(options) = 0)
      )
    )`);
  await knex.raw(`ALTER TABLE servicedesk.queue_fields ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE servicedesk.queue_fields FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON servicedesk.queue_fields`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON servicedesk.queue_fields
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON servicedesk.queue_fields TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE servicedesk.queue_fields IS 'MS.7.4 — campos propios de una cola (sí/no, opción, texto, foto). Apagar no borra; el código y el tipo no cambian.'`);

  const tieneExtra = await knex.schema.withSchema('servicedesk').hasColumn('requests', 'extra');
  if (!tieneExtra) {
    await knex.raw(`ALTER TABLE servicedesk.requests ADD COLUMN extra jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await knex.raw(`ALTER TABLE servicedesk.requests ADD CONSTRAINT requests_extra_object_ck CHECK (jsonb_typeof(extra) = 'object')`);
  }
  await knex.raw(`COMMENT ON COLUMN servicedesk.requests.extra IS 'MS.7.4 — respuestas a los campos propios de la cola { codigo: valor }. Los tickets anteriores quedan con {}.'`);

  // eslint-disable-next-line no-console
  console.log(`  [MS.7.4] queue_fields creada · requests.extra ${tieneExtra ? 'ya existía' : 'agregada (los tickets existentes quedan con {})'}`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE servicedesk.requests DROP CONSTRAINT IF EXISTS requests_extra_object_ck`);
  await knex.raw(`ALTER TABLE servicedesk.requests DROP COLUMN IF EXISTS extra`);
  await knex.raw('DROP TABLE IF EXISTS servicedesk.queue_fields');
};
