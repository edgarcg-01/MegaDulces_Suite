/**
 * LC.1.1 (Fase LC) — Estado de watermark para feeds incrementales.
 *
 * Tabla genérica, una fila por feed (`feed_key`), para que un importer deje de releer
 * todo su universo en cada corrida y solo traiga lo que cambió desde la última vez.
 * Nace para el carril continuo del ADD de ContPAQi (`Documento.TimeStamp`), pero se
 * hizo genérica a propósito: el siguiente feed que necesite watermark no debe crear
 * otra tabla.
 *
 * `watermark_ts` para fuentes con reloj (datetime/timestamp) y `watermark_text` para
 * fuentes con token opaco (RowVersion, consecutivo, id). Se usa la que aplique.
 *
 * Sin RLS: `analytics.*` filtra tenant explícito, igual que el resto del schema.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('feed_watermarks'))) {
    await knex.raw(`
      CREATE TABLE analytics.feed_watermarks (
        tenant_id      uuid NOT NULL,
        feed_key       text NOT NULL,              -- p.ej. 'contpaqi_add_cfdis'
        label          text,                       -- descripción legible
        watermark_ts   timestamptz,                -- fuentes con reloj
        watermark_text text,                       -- fuentes con token opaco
        rows_last      integer,                    -- filas de la última pasada
        rows_total     bigint DEFAULT 0,           -- acumulado desde el arranque
        last_run       timestamptz,
        note           text,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, feed_key)
      )`);
    await knex.raw(`GRANT SELECT ON analytics.feed_watermarks TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('feed_watermarks');
};
