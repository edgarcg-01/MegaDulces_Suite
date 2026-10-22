'use strict';
/**
 * `[MCP.3.6]` — La ruta del día del vendedor: cuándo la inició, cuándo la finalizó y quién la
 * surtió como UN pedido global.
 *
 * ── Por qué una tabla propia ────────────────────────────────────────────────────────────────
 * Hoy cada pedido de preventa le llega suelto al surtidor (`commercial.presale_picks`, uno por
 * pedido). Para surtir la ruta de una vez hace falta saber qué pedidos son de la ruta: los que la
 * persona confirmó ENTRE que inició y finalizó. Esa ventana no existe en ningún lado (ni en el ODS
 * ni en `vendor_route_day_picks`, que es la ruta que escoge el supervisor, no el horario): es un
 * dato propio (HITL), no una copia. Los pedidos NO se copian aquí: se derivan por la ventana.
 *
 * ── Reglas ──────────────────────────────────────────────────────────────────────────────────
 *  · Una ruta VIVA por persona por día (índice único parcial: el soft-delete permite rehacerla).
 *  · `finished_how`: `vendedor` (tocó «Finalizar ruta») o `automatico` (la cerró el sistema).
 *  · `pick_started_*` / `pick_finished_*`: el surtido del pedido global, con el nombre congelado.
 *
 * ⚠️ El código nuevo lee esta tabla (incluida la bandeja de siempre, por su NOT EXISTS):
 *    aplicarla ANTES de desplegar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasTable('seller_route_days')) return;

  await knex.raw(`
    CREATE TABLE commercial.seller_route_days (
      id                    uuid        NOT NULL DEFAULT gen_random_uuid(),
      tenant_id             uuid        NOT NULL DEFAULT public.current_tenant_id(),
      user_id               uuid        NOT NULL,
      -- Día de trabajo en TZ America/Mexico_City.
      work_date             date        NOT NULL,
      started_at            timestamptz NOT NULL DEFAULT now(),
      finished_at           timestamptz,
      finished_how          text,
      -- El surtido del pedido global. El nombre se congela: si mañana cambia la ficha, la ruta
      -- sigue diciendo quién la surtió ese día.
      pick_started_by       uuid,
      pick_started_by_name  text,
      pick_started_at       timestamptz,
      pick_finished_by      uuid,
      pick_finished_by_name text,
      pick_finished_at      timestamptz,
      created_at            timestamptz NOT NULL DEFAULT now(),
      created_by            uuid,
      updated_at            timestamptz NOT NULL DEFAULT now(),
      updated_by            uuid,
      deleted_at            timestamptz,
      deleted_by            uuid,
      CONSTRAINT seller_route_days_pkey PRIMARY KEY (id),
      CONSTRAINT seller_route_days_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT seller_route_days_user_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT seller_route_days_finished_how_ck
        CHECK (finished_how IS NULL OR finished_how IN ('vendedor', 'automatico')),
      CONSTRAINT seller_route_days_finished_ck
        CHECK (finished_at IS NULL OR finished_at >= started_at),
      -- El surtido no termina sin haber empezado.
      CONSTRAINT seller_route_days_pick_ck
        CHECK (pick_finished_at IS NULL OR (pick_started_at IS NOT NULL AND pick_finished_at >= pick_started_at))
    )`);

  // Una ruta VIVA por persona por día.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_seller_route_days_user_day
      ON commercial.seller_route_days (tenant_id, user_id, work_date)
      WHERE deleted_at IS NULL`);
  // La bandeja del surtidor lee por día.
  await knex.raw(`
    CREATE INDEX idx_seller_route_days_day
      ON commercial.seller_route_days (tenant_id, work_date)
      WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE commercial.seller_route_days ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.seller_route_days FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.seller_route_days`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.seller_route_days
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.seller_route_days TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE commercial.seller_route_days IS
    'MCP.3.6 — ruta del día del vendedor (inicio/fin) y su surtido como un pedido global. Los pedidos de la ruta se derivan por la ventana started_at..finished_at; no se copian.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.seller_route_days`);
};
