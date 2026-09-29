'use strict';
/**
 * `[VR.SUP.1]` — Ruta del día escogida por el supervisor de ventas en la app de vendedor.
 *
 * ── Por qué una tabla propia y no `daily_assignments` ────────────────────────────────────────
 * La ruta del vendedor sale de `public.daily_assignments`, que es una agenda SEMANAL
 * (`day_of_week` 1..7, sin fecha). Si el supervisor escogiera "hoy RUTA 23" escribiendo ahí,
 * la elección se repetiría todos los lunes y pisaría su agenda fija. Lo que el supervisor
 * decide es para UNA FECHA, así que se guarda por `work_date`. Es dato propio (HITL), no una
 * copia de otra tabla.
 *
 * ── Reglas ───────────────────────────────────────────────────────────────────────────────────
 *  · Una elección por usuario por día (UNIQUE). Cambiar de ruta = UPDATE de la misma fila.
 *  · Si hay elección para hoy, MANDA sobre `daily_assignments` de hoy (ver
 *    `libs/commercial/src/lib/shared/vendor-cartera.sql.ts`). Sin elección, todo sigue igual.
 *  · NO le quita la ruta al vendedor dueño: ambos la ven (decisión de negocio 2026-09-28).
 *  · Volver a "mi agenda normal" = soft-delete de la fila de hoy.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  if (await knex.schema.withSchema('commercial').hasTable('vendor_route_day_picks')) return;

  await knex.raw(`
    CREATE TABLE commercial.vendor_route_day_picks (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id   uuid        NOT NULL,
      user_id     uuid        NOT NULL,
      -- trade.catalogs (catalog_id = 'rutas'). Que sea del equipo del supervisor lo valida el servicio.
      route_id    uuid        NOT NULL,
      -- Día de trabajo en TZ America/Mexico_City.
      work_date   date        NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  uuid,
      deleted_at  timestamptz,
      deleted_by  uuid,
      CONSTRAINT vendor_route_day_picks_pkey PRIMARY KEY (id),
      CONSTRAINT vendor_route_day_picks_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT vendor_route_day_picks_user_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE CASCADE,
      CONSTRAINT vendor_route_day_picks_route_fk
        FOREIGN KEY (tenant_id, route_id) REFERENCES trade.catalogs (tenant_id, id) ON DELETE RESTRICT
    )`);

  // Una elección VIVA por usuario por día. Parcial para que el soft-delete permita volver a escoger.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_vendor_route_day_picks_user_day
      ON commercial.vendor_route_day_picks (tenant_id, user_id, work_date)
      WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE commercial.vendor_route_day_picks ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.vendor_route_day_picks FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.vendor_route_day_picks`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.vendor_route_day_picks
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.vendor_route_day_picks TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE commercial.vendor_route_day_picks IS
    'VR.SUP.1 — ruta que el supervisor de ventas escoge trabajar en una fecha. Manda sobre daily_assignments de ese día; no le quita la ruta al vendedor dueño.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.vendor_route_day_picks`);
};
