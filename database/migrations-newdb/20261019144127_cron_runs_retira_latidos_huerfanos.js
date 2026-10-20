'use strict';
/**
 * `[OPS.LIMPIEZA.1]` — Retira 3 latidos HUÉRFANOS de `analytics.cron_runs`: su proceso ya no
 * existe, nadie los vuelve a escribir, y el tablero los pintaba en rojo para siempre. Es el mismo
 * modo de falla que `20260911120000_cleanup_retired_lanes_md32` (A): lo retirado sigue latiendo
 * en el tablero y entrena a la gente a ignorar el rojo.
 *
 * ── Lo verificado antes (código + prod en sólo lectura, 2026-10-19) ─────────────────────────
 *  · `rd_commission_runner` — el cron se RETIRÓ el 2026-10-07 (`commercial-commissions.module.ts`,
 *    `[RD.22]`): la quincena se recalcula a demanda. Cero emisores en el repo.
 *  · `fact_replenishment_plan` (SIN sufijo) — la llave vieja. `run-prod-feeds.js` invoca el
 *    importer SÓLO con `--hb=stock` y `--hb=nightly`, que son las llaves vivas (corrieron hoy y
 *    ayer). Sin `--hb` ni `RPLAN_HB_SUFIJO` nadie la emite.
 *  · `prueba_no_usar` — prueba manual. Cero emisores en el repo.
 *
 * ⛔ `feed_route_stock` NO se toca acá, a propósito: su script (`import-route-stock.js`) sigue en
 *    el repo y `scripts/check-importer-sin-agenda.js` lo registra como DEUDA a agendar, con la
 *    decisión en Edgar. Borrarle el latido antes de esa decisión escondería la deuda.
 *
 * ⚠️ Sólo DELETE, sin objeto de esquema: la compuerta del despliegue la clasifica NO_MEDIDO y
 *    frena a todo el equipo hasta que se aplique. Aplicarla con `apply-one-migration-prod.js`
 *    INMEDIATAMENTE después del push que la lleve.
 *
 * Idempotente: DELETE WHERE — si ya no están, borra 0.
 *
 * @param { import("knex").Knex } knex
 */
const HUERFANOS = ['rd_commission_runner', 'fact_replenishment_plan', 'prueba_no_usar'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const n = await knex('analytics.cron_runs').whereIn('job_key', HUERFANOS).del();
  console.log(`  cron_runs huérfanos borrados: ${n} (esperado ≤ ${HUERFANOS.length} por tenant: ${HUERFANOS.join(', ')})`);
};

/**
 * No-op a propósito: las filas eran latidos de procesos que ya no existen. Restaurarlas sería
 * volver a pintar en rojo algo que no corre; no hay estado de negocio que recuperar.
 */
exports.down = async function down(knex) {
  void knex;
};
