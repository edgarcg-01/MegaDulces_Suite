'use strict';
/**
 * `[MCP.3.13]` — El surtido de la ruta, POR SUCURSAL.
 *
 * Con el pedido agrupado, la ruta de un vendedor tiene partes en dos o más sucursales de su zona: el
 * surtidor de La Piedad Abastos y el de Padre Hidalgo surten la MISMA ruta, cada quien lo suyo. Hoy
 * `seller_route_days.pick_*` tiene UN dueño por ruta: si el de LPA empieza, el de PH recibe un 409
 * («ya la está surtiendo…») y no puede surtir su parte. Esta tabla lleva quién empezó y quién terminó
 * POR (ruta, sucursal). Es un dato propio (HITL), no una copia.
 *
 * `seller_route_days.pick_*` se conserva (lo leen rutas ya surtidas antes de este cambio) y el código
 * nuevo deja de escribirlo como dueño único.
 *
 * El código nuevo lee esta tabla: aplicarla ANTES de desplegar. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('seller_route_day_picks'))) {
    await knex.raw(`
      CREATE TABLE commercial.seller_route_day_picks (
        id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
        tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
        route_day_id          uuid        NOT NULL,
        warehouse_id          uuid        NOT NULL,
        pick_started_by       uuid        NOT NULL,
        pick_started_by_name  text        NOT NULL,
        pick_started_at       timestamptz NOT NULL DEFAULT now(),
        pick_finished_by      uuid,
        pick_finished_by_name text,
        pick_finished_at      timestamptz,
        created_at            timestamptz NOT NULL DEFAULT now(),
        created_by            uuid,
        updated_at            timestamptz NOT NULL DEFAULT now(),
        updated_by            uuid,
        CONSTRAINT seller_route_day_picks_pkey PRIMARY KEY (id),
        CONSTRAINT seller_route_day_picks_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
        CONSTRAINT seller_route_day_picks_day_fk
          FOREIGN KEY (route_day_id) REFERENCES commercial.seller_route_days (id) ON DELETE CASCADE,
        CONSTRAINT seller_route_day_picks_wh_fk
          FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id),
        -- El cierre es coherente o no es: quién y cuándo, juntos, y nunca antes de empezar.
        CONSTRAINT seller_route_day_picks_cierre_ck
          CHECK ((pick_finished_at IS NULL AND pick_finished_by IS NULL)
              OR (pick_finished_at IS NOT NULL AND pick_finished_by IS NOT NULL AND pick_finished_at >= pick_started_at))
      )`);
    // Una sucursal surte su parte de la ruta UNA vez.
    await knex.raw(`
      CREATE UNIQUE INDEX ux_seller_route_day_picks_day_wh
        ON commercial.seller_route_day_picks (tenant_id, route_day_id, warehouse_id)`);
  }

  await knex.raw('ALTER TABLE commercial.seller_route_day_picks ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.seller_route_day_picks FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS seller_route_day_picks_tenant ON commercial.seller_route_day_picks');
  await knex.raw(`
    CREATE POLICY seller_route_day_picks_tenant ON commercial.seller_route_day_picks
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON commercial.seller_route_day_picks TO app_runtime');
  await knex.raw(`COMMENT ON TABLE commercial.seller_route_day_picks IS
    'MCP.3.13 — surtido de la ruta de un vendedor POR SUCURSAL: con el pedido agrupado, cada sucursal de la zona surte su parte de la misma ruta. Dato propio.'`);

  // ── COMPUERTA ────────────────────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'seller_route_day_picks'`);
  if (!rows[0]?.on || !rows[0]?.forced) throw new Error('[MCP.3.13] RLS no quedó habilitado+forzado en seller_route_day_picks.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.seller_route_day_picks');
};
