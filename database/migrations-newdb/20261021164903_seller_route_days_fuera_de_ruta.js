'use strict';
/**
 * `[MCP.3.6]` Lo que el vendedor levanta DESPUÉS de cerrar su ruta también le llega al surtidor
 * como UN pedido global, rotulado «Fuera de la ruta» (decisión de David, 2026-10-21: «quedamos que
 * sólo sea un pedido, globalizado»). Antes caía suelto, pedido por pedido.
 *
 * Una tanda «fuera de la ruta» es otra fila de `commercial.seller_route_days` con
 * `kind = 'fuera_de_ruta'`: misma ventana (`started_at` → `finished_at`) y mismo surtido. Se abre
 * sola al finalizar la ruta y se CIERRA cuando el surtidor empieza a recolectarla, abriendo la
 * siguiente; así nunca se mezcla un pedido nuevo con lo que ya se está surtiendo.
 *
 * Por eso el índice único deja de ser (vendedor, día) para todas las filas: sigue siendo UNA ruta
 * por vendedor y día, pero puede haber varias tandas fuera de la ruta.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · La tabla nació hoy (20261021114018) y sólo existe en la base local de desarrollo.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tiene = await knex.schema.withSchema('commercial').hasColumn('seller_route_days', 'kind');
  if (!tiene) {
    await knex.raw(`
      ALTER TABLE commercial.seller_route_days
        ADD COLUMN kind text NOT NULL DEFAULT 'ruta',
        ADD CONSTRAINT seller_route_days_kind_chk CHECK (kind IN ('ruta', 'fuera_de_ruta'))`);
  }
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_seller_route_days_user_day`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_seller_route_days_user_day
      ON commercial.seller_route_days (tenant_id, user_id, work_date)
      WHERE deleted_at IS NULL AND kind = 'ruta'`);
  // A lo más UNA tanda fuera de la ruta ABIERTA por vendedor y día.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_seller_route_days_fuera_abierta
      ON commercial.seller_route_days (tenant_id, user_id, work_date)
      WHERE deleted_at IS NULL AND kind = 'fuera_de_ruta' AND finished_at IS NULL`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_seller_route_days_fuera_abierta`);
  await knex.raw(`DELETE FROM commercial.seller_route_days WHERE kind = 'fuera_de_ruta'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_seller_route_days_user_day`);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_seller_route_days_user_day
      ON commercial.seller_route_days (tenant_id, user_id, work_date)
      WHERE deleted_at IS NULL`);
  await knex.raw(`ALTER TABLE commercial.seller_route_days DROP CONSTRAINT IF EXISTS seller_route_days_kind_chk`);
  await knex.raw(`ALTER TABLE commercial.seller_route_days DROP COLUMN IF EXISTS kind`);
};
