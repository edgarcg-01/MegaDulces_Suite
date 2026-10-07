/**
 * LIMPIEZA de lo que YA NO SIRVE en la base — para dejar el server nuevo limpio (Fase VL/OBS).
 *
 * Todo lo de acá fue VERIFICADO contra prod (2026-09-11): el dato que alimentaban está fresco por
 * otra vía, o el almacén ya está jubilado. No se borra nada vivo.
 *
 * ── A) 3 latidos ZOMBIE en analytics.cron_runs ────────────────────────────────────────────────
 * Procesos retirados cuyo latido nadie apagó → el tablero los mostraba `ok`/crítico eternamente
 * (el modo de falla inverso al incidente que fundó OBS: acá lo retirado sale verde). Verificado:
 *   · kepler_catalog_bulk   (26 d)  RETIRADO — el catálogo lo mantienen los `repoint-catalog-*`
 *                                   del nightly (presence/names/prices/cost, CANON.0.1). catalog.products
 *                                   fresco 0 h. Su sensor daba FALSO crítico (warn 200/crit 400).
 *   · wincaja_replica       (24 d)  SUPERADO por wincaja_replica_inc + _hash (WR.5.1, PM2). Wincaja fresco 3–4 h.
 *   · kepler_prices_bitacora(18 d)  HUÉRFANO — cero referencias en código; corrió 1 vez en dry-run.
 *                                   Precios frescos por feed_prices.
 * (feed_catalog y wincaja_concentrada NO se tocan: son SEMANALES vivos, corrieron el domingo.)
 * El sensor de db-health de kepler_catalog_bulk se retira aparte (db-health.service.ts, mismo commit).
 *
 * ── B) data STALE del almacén MD-32 (Morelia Madero Wincaja), ya soft-deleted ─────────────────
 * MD-32 se jubiló hoy al fusionar Madero en Kepler '07' (su venta/demanda se movió a 07). Quedaron
 * filas fantasma en replenishment_plan/reorder_policy/product_demand, invisibles (filtradas por
 * deleted_at) pero presentes. Se purgan SÓLO si el almacén está soft-deleted (guarda anti-accidente).
 *
 * Idempotente: DELETE WHERE — si ya no están, no hace nada. `down` es no-op (no se restaura basura).
 * @param { import("knex").Knex } knex
 */
const ZOMBIE_LANES = ['kepler_catalog_bulk', 'wincaja_replica', 'kepler_prices_bitacora'];

exports.up = async function (knex) {
  // A) latidos zombie
  const a = await knex('analytics.cron_runs').whereIn('job_key', ZOMBIE_LANES).del();
  console.log(`  A) cron_runs zombie borradas: ${a} (esperado ≤3: ${ZOMBIE_LANES.join(', ')})`);

  // B) purga MD-32 sólo si está soft-deleted (por tenant mega_dulces)
  const wh = (await knex.raw(
    `SELECT w.id, w.tenant_id FROM commercial.warehouses w
      JOIN identity.tenants t ON t.id = w.tenant_id AND t.slug = 'mega_dulces'
     WHERE w.code = 'MD-32' AND w.deleted_at IS NOT NULL`)).rows[0];
  if (!wh) {
    console.log('  B) MD-32 no existe o no está soft-deleted → no se purga (ok).');
    return;
  }
  const p1 = await knex('analytics.replenishment_plan').where({ tenant_id: wh.tenant_id, warehouse_id: wh.id }).del();
  const p2 = await knex('commercial.reorder_policy').where({ tenant_id: wh.tenant_id, warehouse_id: wh.id }).del();
  const p3 = await knex('analytics.product_demand').where({ tenant_id: wh.tenant_id, warehouse_id: wh.id }).del();
  console.log(`  B) MD-32 stale purgada — replenishment_plan:${p1} · reorder_policy:${p2} · product_demand:${p3}`);
};

exports.down = async function () {
  // Limpieza de basura: no se restaura. No-op a propósito.
};
