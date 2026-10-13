'use strict';
/**
 * `[PF.6]` La foto de «Para cuidar hoy» (Compras › Catálogo › Productos), calculada por el WORKER cada
 * minuto para que nadie la espere.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-09) ────────────────────────────────────────
 *  · Calcularla toma 2.9–3.6 s con los datos calientes y 6.5 s la primera vez (datos fríos): junta los
 *    245 líderes, los lotes con caducidad y los 928 productos que no se venden.
 *  · La API NO corre trabajos programados (`DISABLE_CRONS=true`, ADR-043) y está prevista para varias
 *    réplicas: una memoria por proceso no sirve. El worker calcula, esta tabla la comparte.
 *
 * ── Qué es ──────────────────────────────────────────────────────────────────────────────────
 *  · Un CACHÉ de una derivación (materializar por costo, GOTCHAS §19): no inventa nada, cada valor sale de
 *    `kepler_ods`/las matvistas en cada pasada. Una fila por (tenant, variante): `costo` (con dinero y
 *    márgenes) y `sin_costo` (para quien no tiene permiso de costo). Las dos salen de UNA sola pasada.
 *  · `calculado_at` es lo que la API compara para decidir si sirve la foto o calcula en vivo (y lo dice).
 *
 * Aditiva e idempotente. RLS forzado + grant `app_runtime`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('analytics').hasTable('product_flow_watch'))) {
    await knex.raw(`
      CREATE TABLE analytics.product_flow_watch (
        tenant_id     uuid        NOT NULL,
        variante      text        NOT NULL,
        payload       jsonb       NOT NULL,
        calculado_at  timestamptz NOT NULL,
        duracion_ms   integer     NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, variante),
        CONSTRAINT product_flow_watch_variante_chk CHECK (variante IN ('costo', 'sin_costo')),
        CONSTRAINT product_flow_watch_duracion_chk CHECK (duracion_ms >= 0),
        CONSTRAINT product_flow_watch_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE CASCADE
      )`);
  }
  await knex.raw(`ALTER TABLE analytics.product_flow_watch ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE analytics.product_flow_watch FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON analytics.product_flow_watch`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON analytics.product_flow_watch
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.product_flow_watch TO app_runtime`);
  await knex.raw(`
    COMMENT ON TABLE analytics.product_flow_watch IS
      '[PF.6] Foto de Para cuidar hoy (lideres, lo que no se vende, caducidad), calculada por el worker cada '
      'minuto. Cache de una derivacion: cada pasada recalcula desde kepler_ods y las matvistas. Una fila por '
      'variante (costo / sin_costo).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS analytics.product_flow_watch`);
};
