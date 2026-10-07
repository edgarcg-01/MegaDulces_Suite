'use strict';
/**
 * `[RD.15]` — **Sacar del camino caliente el único cálculo que no cambia nunca.**
 *
 * ── El defecto, medido ──────────────────────────────────────────────────────────────────────
 * Normalizar la identidad (mig `20261003130000`) hizo lo que tenía que hacer —las 11 rutas ya
 * salen de `commercial.warehouses` por PK y de `analytics.transfer_dest_map` por FK, cero
 * `VALUES`— pero **empeoró el tiempo de la pantalla**, no lo mejoró:
 *
 *     antes (identidad en VALUES, ledger en vista) ....... 1,775 ms
 *     después (identidad normalizada, ledger en matvista) . 2,988 / 2,844 / 3,006 / 4,960 ms
 *
 * La causa no es el JOIN: es el `CROSS JOIN LATERAL` que la vista usa para derivar
 * `carga_desde` (la primera carga documentada de cada ruta). Es un `min(c9)` sobre
 * `kepler_ods.kdm1` **por ruta, y se re-evalúa en cada lectura de la pantalla**. Materializar el
 * ledger no lo tocó, porque el LATERAL vive del otro lado del JOIN.
 *
 * ⭐ Y es el cálculo más fácil de sacar de ahí: `carga_desde` es **la fecha del primer embarque
 * de la historia**. No cambia hoy, ni mañana, ni cuando entre venta nueva. Pagarlo en cada carga
 * de pantalla es pagar por una respuesta que ya se sabía.
 *
 * ── Por qué una matvista de ONCE filas y no una columna ─────────────────────────────────────
 * Se consideró guardar `carga_desde` en `commercial.warehouses`. Se descartó: es un **dato
 * derivado**, y una columna derivada guardada a mano es una que se queda vieja en silencio el
 * día que llegue un embarque anterior (un backfill del ODS, por ejemplo). La matvista se
 * recalcula sola en el mismo ciclo que el ledger y conserva la derivación.
 *
 * ⛔ **La vista NO se retira**: sigue siendo la definición (la matvista es `SELECT *` sobre
 * ella, para que no pueda divergir) y el árbitro de paridad del candado.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_rd_route_identity';

exports.up = async function up(knex) {
  const existe = await knex.raw(`SELECT to_regclass(?) t`, [MV]);
  if (existe.rows[0] && existe.rows[0].t) return;

  await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS
    SELECT * FROM analytics.v_rd_route_identity`);
  // UNIQUE = requisito de REFRESH CONCURRENTLY, y aserción de que una ruta no puede salir dos
  // veces (pasaría si un almacén quedara mapeado a dos `dest_code`).
  await knex.raw(`CREATE UNIQUE INDEX ux_mv_rd_route_identity
    ON ${MV} (tenant_id, route_no)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);
  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    'RD.15 - copia POR COSTO de analytics.v_rd_route_identity (11 filas). Lo que se materializa es carga_desde: un min(kdm1.c9) por ruta que la vista re-evaluaba en CADA carga de pantalla y que no cambia nunca. Medido: la consulta del servicio pasaba de 1,775 a 2,988-4,960 ms por ese LATERAL.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
