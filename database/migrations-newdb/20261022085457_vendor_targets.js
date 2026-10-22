'use strict';
/**
 * `[MCP.3.9]` — `commercial.vendor_targets`: la META de la catorcena de cada vendedor, en pesos.
 *
 * ── Por qué una tabla propia ────────────────────────────────────────────────────────────────
 * La meta la CAPTURA el supervisor de ventas en el tablero («Cartera de ventas»): es dato propio
 * (HITL), no existe en el ODS ni en Kepler ni en ninguna otra tabla de la suite. La venta contra
 * la que se mide NO se copia aquí: se deriva al consultar del ODS (`v_kepler_vecinal_sales_docs`).
 *
 * ── Reglas ──────────────────────────────────────────────────────────────────────────────────
 *  · Una meta VIVA por vendedor por catorcena (índice único parcial: borrar = soft-delete, y se
 *    puede volver a capturar).
 *  · `period_start` es el SÁBADO que abre la catorcena (dos semanas de nómina sáb→vie). El CHECK
 *    sólo garantiza el sábado; que sea el sábado ALINEADO al ancla (`CATORCENA_ANCLA`, código) lo
 *    valida el servicio — el ancla no vive en la base para no tener dos lugares que la declaren.
 *  · `amount >= 0`. «Sin meta» no es 0: es que no haya fila (o esté borrada).
 *
 * ⚠️ El código nuevo lee esta tabla (`GET …/supervisor/board`): aplicarla ANTES de desplegar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasTable('vendor_targets')) return;

  await knex.raw(`
    CREATE TABLE commercial.vendor_targets (
      id            uuid          NOT NULL DEFAULT gen_random_uuid(),
      tenant_id     uuid          NOT NULL DEFAULT public.current_tenant_id(),
      user_id       uuid          NOT NULL,
      -- Sábado de inicio de la catorcena (hora de México; es una fecha, no un instante).
      period_start  date          NOT NULL,
      -- Pesos, con impuestos (la misma unidad que la venta cobrada en Kepler contra la que se mide).
      amount        numeric(14,2) NOT NULL,
      created_at    timestamptz   NOT NULL DEFAULT now(),
      created_by    uuid,
      updated_at    timestamptz   NOT NULL DEFAULT now(),
      updated_by    uuid,
      deleted_at    timestamptz,
      deleted_by    uuid,
      CONSTRAINT vendor_targets_pkey PRIMARY KEY (id),
      CONSTRAINT vendor_targets_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT vendor_targets_user_fk
        FOREIGN KEY (tenant_id, user_id) REFERENCES identity.users (tenant_id, id) ON DELETE RESTRICT,
      CONSTRAINT vendor_targets_period_saturday_ck
        CHECK (extract(isodow FROM period_start) = 6),
      CONSTRAINT vendor_targets_amount_ck
        CHECK (amount >= 0)
    )`);

  // Una meta VIVA por vendedor por catorcena.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_vendor_targets_user_period
      ON commercial.vendor_targets (tenant_id, user_id, period_start)
      WHERE deleted_at IS NULL`);

  await knex.raw(`ALTER TABLE commercial.vendor_targets ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.vendor_targets FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.vendor_targets`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.vendor_targets
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.vendor_targets TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE commercial.vendor_targets IS
    'MCP.3.9 — meta de la catorcena (sab->vie, dos semanas) por vendedor, en pesos con impuestos, capturada por el supervisor. Dato propio (HITL). La venta se deriva del ODS al consultar; no se copia.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.vendor_targets`);
};
