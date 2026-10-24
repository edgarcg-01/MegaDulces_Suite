'use strict';
/**
 * `[AB.36]` — La escalera de unidades de Kepler, materializada por COSTO.
 *
 * La mesa de Autoabasto y «Mi pedido» (y `/compras/pedido` cuando lea lo que ya pidió la sucursal,
 * AB.34) redondean cada renglón con la escalera de unidades (`analytics.v_product_unit_ladder`: un
 * `mode()` por SKU sobre `kepler_ods.kdii`). Leída por SKU, la vista viva cuesta lo que cuesta
 * agregar `kdii` para esos SKU, y va DESPUÉS del motor, en la ruta crítica de la pantalla.
 *
 * ── Lo medido antes (sólo lectura, prod `7688376744939610156`, 2026-10-24) ────────────────────
 *  · Padre Hidalgo, 1,377 SKU de la mesa: 185–340 ms la escalera viva (3 corridas).
 *  · Toda la red (`leerYaPedidoRed`, 3,205 SKU): 267 ms.
 *  · La vista ENTERA: 9,697 filas, 9,697 SKU distintos, 0 SKU nulos → `sku` es llave única.
 *  · Sin columnas de reloj (sku, unit_base, unit_base_raw, u2_label, u3_label, f2, f3, f2_raw,
 *    f3_raw, p1, p2, p3, is_weight): `REFRESH ... CONCURRENTLY` no reescribe filas que no cambiaron.
 *
 * ── Mismo criterio que `20260924220000_mv_factor_y_costo` ─────────────────────────────────────
 *  · El cuerpo es `SELECT * FROM` la vista: no puede divergir de su definición (GOTCHAS §19).
 *  · La VISTA NO se toca: tiene dependientes (`product_units`, `v_erp_sales_line_units`,
 *    `v_unit_rung_audit`, `v_unit_truth`); cambiarle el cuerpo les movería la frescura en silencio.
 *  · La refresca `AnalyticsRefreshService` cada 15 min (grupo `analytics_refresh`, con latido en
 *    `analytics.cron_runs`). La escalera es configuración de producto en Kepler: cambia rara vez.
 *  · Quien la lee pregunta si EXISTE (`to_regclass`) y si no, lee la vista viva.
 *
 * ⚠️ ORDEN: aplicarla ANTES de desplegar el código de AB.36. El refresco de 15 min la nombra, y si
 *    no existe la cuenta como falla (latido `analytics_refresh` en error) hasta que se aplique.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const MV = 'analytics.mv_product_unit_ladder';
const VISTA = 'analytics.v_product_unit_ladder';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const vista = await knex.raw(`SELECT to_regclass(?) AS t`, [VISTA]);
  if (!vista.rows[0] || !vista.rows[0].t) return; // entorno sin la vista: nada que derivar
  const ya = await knex.raw(`SELECT to_regclass(?) AS t`, [MV]);
  if (!ya.rows[0] || !ya.rows[0].t) {
    await knex.raw(`CREATE MATERIALIZED VIEW ${MV} AS SELECT * FROM ${VISTA}`);
  }
  // Sin el UNIQUE no se permite `REFRESH ... CONCURRENTLY`, y sin CONCURRENTLY el refresco toma un
  // lock exclusivo que deja en espera a la mesa mientras corre.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_product_unit_ladder ON ${MV} (sku)`);
  await knex.raw(`GRANT SELECT ON ${MV} TO app_runtime`);

  // Candado: que no nazca corta sin que nadie se entere. Una escalera faltante no da error: da un
  // renglón que se redondea sin escalera («sin unidad»).
  const chk = await knex.raw(`SELECT (SELECT count(*) FROM ${MV}) AS m, (SELECT count(*) FROM ${VISTA}) AS v`);
  const { m, v } = chk.rows[0];
  if (Number(v) > 0 && Number(m) !== Number(v)) {
    throw new Error(`${MV} quedó con ${m} filas y ${VISTA} tiene ${v}. No se materializa a medias.`);
  }

  await knex.raw(`COMMENT ON MATERIALIZED VIEW ${MV} IS
    'AB.36 - copia materializada de analytics.v_product_unit_ladder, POR COSTO (GOTCHAS 19). '
    'Medido 2026-10-24: leida por SKU, la vista viva costaba 185-340 ms en la mesa de Autoabasto '
    '(1,377 SKU) y 267 ms para toda la red. La vista NO se toca (tiene 4 dependientes). '
    'La refresca AnalyticsRefreshService cada 15 min (latido analytics_refresh). Sin columnas de reloj.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. El lector vuelve a la vista viva: más lento, igual de correcto. */
exports.down = async function down(knex) {
  await knex.raw(`DROP MATERIALIZED VIEW IF EXISTS ${MV}`);
};
