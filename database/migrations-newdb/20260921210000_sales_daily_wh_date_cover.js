'use strict';
/**
 * `[CDRP.4-perf]` — **Índice CUBRIENTE para el agregado de venta por almacén.**
 *
 * ── El problema, medido contra prod ─────────────────────────────────────────────────────────
 * El bloque de zonas de «Mi trabajo» agrega venta por almacén sobre `analytics.sales_daily`
 * (3.0M filas · heap 1,507 MB). Para el caso de **Dirección** —6 zonas, 9 almacenes, ventana de
 * ~2 meses— esa sola consulta tardaba **~9.7 s de los 16 s** que cuesta la pantalla entera.
 *
 * ⛔ Y NO es el plan: `EXPLAIN (ANALYZE, BUFFERS)` lo muestra sano —`Finalize GroupAggregate` con
 * 2 workers paralelos sobre `ix_sales_daily_wh_date`—. El costo es **ir al heap**:
 *
 *     filas del tramo:  249,389
 *     buffers:          hit=43,330  **read=35,571**
 *
 * 35 mil páginas leídas de disco, salteadas sobre 1.5 GB. `ix_sales_daily_wh_date` tiene las tres
 * columnas del filtro `(tenant_id, warehouse_id, sale_date)` pero **ninguna de las que se suman**,
 * así que por cada una de las 249 mil filas hay que ir a buscar la fila completa.
 *
 * ── Por qué no alcanzaba el índice cubriente que YA existe ──────────────────────────────────
 * `ix_sales_daily_cover` **pesa 1,222 MB** y es
 * `(tenant_id, sale_date) INCLUDE (warehouse_id, product_id, revenue, margin, units)`. No sirve
 * acá por dos razones: lidera por `sale_date` y no por `warehouse_id` (el filtro de esta consulta
 * es un `IN` de almacenes), y **no incluye `cost` ni `tickets`**, que son justo las dos columnas
 * que `[CDRP.1]` agregó al bloque para poder publicar margen y ticket promedio. Un índice de 1.2 GB
 * que no cubre lo que se pide es peso sin beneficio: tiene **5,362 scans** contra los **173,396**
 * de `ix_sales_daily_wh_date`.
 *
 * ── Lo que hace éste ────────────────────────────────────────────────────────────────────────
 * Mismas tres columnas de clave que el índice que el planificador ya elige, más las cuatro que se
 * suman como payload. Con eso el agregado pasa a ser **index-only scan**: las 249 mil filas viven
 * en unas pocas miles de páginas contiguas del índice en vez de 35 mil páginas salteadas del heap.
 *
 * ⚠️ `CONCURRENTLY` y `transaction: false` (obligatorio: Postgres no permite `CONCURRENTLY` dentro
 * de una transacción, y knex envuelve las migraciones por default). No bloquea lecturas ni
 * escrituras; a cambio hace dos pasadas y puede quedar `INVALID` si falla — por eso el `up`
 * verifica `indisvalid` al terminar en vez de asumir que salió bien.
 *
 * ⛔ **NO se borra `ix_sales_daily_wh_date` en esta migración.** Es redundante en teoría (mismas
 * columnas de clave, en el mismo orden), pero lo usan 173 mil scans y borrarlo a ciegas el mismo
 * día que nace su reemplazo es cambiar dos cosas a la vez. Se declara como candidato y se retira
 * cuando se vea el tráfico mudado en `pg_stat_user_indexes`.
 *
 * ⛔ Se aplica FUERA de horario hábil (construido el 2026-09-21, 19:05 MX): es I/O sostenida sobre
 * una tabla de 1.5 GB que el feed escribe cada minuto.
 *
 * @param { import("knex").Knex } knex
 */

const IDX = 'ix_sales_daily_wh_date_cover';
const TABLA = 'analytics.sales_daily';

exports.config = { transaction: false };

exports.up = async function up(knex) {
  const ya = await knex.raw(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(?)`,
    [`analytics.${IDX}`],
  );
  if (ya.rows.length && ya.rows[0].indisvalid) {
    console.log(`  [CDRP.4-perf] ${IDX} ya existe y es válido`);
    return;
  }
  if (ya.rows.length) {
    // Un intento anterior que falló deja el índice INVÁLIDO y sin usar: no se acumula basura.
    console.log(`  [CDRP.4-perf] ${IDX} existía INVÁLIDO (intento previo fallido) — se retira`);
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${IDX}`);
  }

  console.log(`  [CDRP.4-perf] construyendo ${IDX} CONCURRENTLY sobre ${TABLA} (3.0M filas)…`);
  const t0 = Date.now();
  await knex.raw(
    `CREATE INDEX CONCURRENTLY ${IDX} ON ${TABLA}
       USING btree (tenant_id, warehouse_id, sale_date)
       INCLUDE (revenue, cost, tickets, units)`,
  );

  /*
   * ⛔ Prueba de que quedó utilizable, no de que el comando volvió. `CREATE INDEX CONCURRENTLY`
   * puede terminar dejando el índice `indisvalid = false`: existe, ocupa lugar y el planificador
   * NO lo usa. Un índice inválido es exactamente el «verde falso» de esta familia de bugs.
   */
  const ok = await knex.raw(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass(?)`,
    [`analytics.${IDX}`],
  );
  if (!ok.rows.length || !ok.rows[0].indisvalid) {
    throw new Error(
      `[CDRP.4-perf] ${IDX} quedó INVÁLIDO: existe pero el planificador no lo va a usar. ` +
        'Retirarlo y reintentar fuera de horario.',
    );
  }

  const sz = await knex.raw(
    `SELECT pg_size_pretty(pg_relation_size(to_regclass(?))) s`,
    [`analytics.${IDX}`],
  );
  console.log(
    `  [CDRP.4-perf] ${IDX} listo y válido — ${sz.rows[0].s} en ${Math.round((Date.now() - t0) / 1000)} s`,
  );
  console.log(
    '  [CDRP.4-perf] ⚠️ `ix_sales_daily_wh_date` (118 MB) queda como candidato a retiro: mismas ' +
      'columnas de clave. NO se borra acá — primero hay que ver el tráfico mudarse en pg_stat_user_indexes.',
  );
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${IDX}`);
};
