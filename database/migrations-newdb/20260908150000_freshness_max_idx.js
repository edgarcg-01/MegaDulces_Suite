/**
 * [VP.2.2] Índices para que preguntar "¿de cuándo es este dato?" no cueste un seq scan.
 *
 * ── QUÉ PROBLEMA RESUELVE ────────────────────────────────────────────────────────────────
 * `tableAt()` (libs/commercial/.../shared/freshness.ts) mide la edad de un feed con
 * `max(<col de tiempo>)` sobre la tabla que lo guarda. Es la mejor señal disponible para estos
 * reportes: **mide ENTREGA** (el dato se movió), no latido (el proceso corrió) — y se verificó que
 * los tres importers que llenan estas tablas (`import-sales-boxes-monthly`,
 * `import-transfers-monthly`, `import-route-push-monthly`) **no llaman a `cron-heartbeat`**, así
 * que no hay carril en `analytics.cron_runs` que leer. VP.3.4 sigue abierto.
 *
 * El problema es el costo. Sin índice, `max()` es un **Seq Scan completo**. Medido contra PROD el
 * 2026-09-08 con `EXPLAIN (ANALYZE)` — tiempo de EJECUCIÓN, ya sin la latencia de red:
 *
 *   analytics.sales_boxes_monthly     (683 MB)   max(updated_at)   →  6,625 ms   ← índice
 *   wincaja.maestro_mov_almacen       (449 MB)   max(imported_at)  →  5,899 ms   ← índice
 *   analytics.sales_daily                        max(updated_at)   →  2,554 ms   ← índice
 *   analytics.route_push_lines                   max(imported_at)  →  1,829 ms   ← índice
 *   analytics.store_live_tickets      (224 MB)   max(created_at)   →     59 ms
 *   analytics.transfers_monthly       (792 filas) max(updated_at)  →      2.9 ms
 *   analytics.sales_by_route_monthly  (297 filas) max(updated_at)  →      1.8 ms
 *
 * ⚠️ **La primera medición de esta lista estuvo mal, y por poco se va así.** Se había medido con
 * reloj de pared desde una conexión remota, donde todo daba 250–1,400 ms y era fácil atribuirlo a
 * la red; con eso sólo entraban las dos tablas grandes. `EXPLAIN ANALYZE` separa las dos cosas y
 * deja ver que `sales_daily` ejecuta **2,554 ms** — o sea que **excede el tope de 2 s** que
 * `tableAt()` se pone para no colgar el reporte, y `salidasReport` en modo RANGO habría declarado
 * "no medido" **para siempre**, sin que nada fallara. Un cronómetro que incluye la red no puede
 * decidir un índice: hay que medir la ejecución.
 *
 * `store_live_tickets` (224 MB) sí es Seq Scan y NO lleva índice: 59 ms. `transfers_monthly` y
 * `sales_by_route_monthly` son de cientos de filas. Un índice que no se justifica con una medición
 * es peso muerto que hay que mantener.
 *
 * Con un btree DESC, Postgres resuelve `max()` leyendo **una sola entrada** del extremo del índice
 * (index-only scan, ~1 ms).
 *
 * ── POR QUÉ `DESC NULLS LAST` ────────────────────────────────────────────────────────────
 * `max()` quiere el extremo mayor. Con `DESC NULLS LAST` los NULL quedan al final y el valor más
 * reciente es la PRIMERA entrada del índice, que es exactamente lo que el planner sale a buscar.
 *
 * ── POR QUÉ CONCURRENTLY (y por qué esta migración no corre en transacción) ──────────────
 * Un `CREATE INDEX` normal toma **ACCESS EXCLUSIVE**: sobre 683 MB son varios segundos con la
 * tabla bloqueada, y estas dos las escribe un feed (Wincaja replica cada 2 min; el mensual, de
 * noche). Es la lección de LC.15 en `CLAUDE.md`: no sostener locks exclusivos mientras el feed
 * escribe. `CONCURRENTLY` no bloquea escrituras, pero **no puede correr dentro de una
 * transacción** ⇒ `exports.config = { transaction: false }`, mismo patrón que
 * `20260805240000_wincaja_maestro_fecha_date_idx.js`.
 *
 * ⚠️ Con `transaction: false` un fallo a mitad NO se revierte: un `CREATE INDEX CONCURRENTLY`
 * interrumpido deja un índice **INVALID** que Postgres no usa y que hay que dropear a mano. Por eso
 * cada uno va con `IF NOT EXISTS` y su propio guard de tabla: re-correr la migración es seguro.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

/** [tabla, columna de tiempo, nombre del índice] — sólo las que una medición de EJECUCIÓN justifica. */
const IDX = [
  ['analytics.sales_boxes_monthly', 'updated_at', 'ix_sales_boxes_monthly_updated_at_desc'],
  ['wincaja.maestro_mov_almacen', 'imported_at', 'ix_wcj_maestro_imported_at_desc'],
  // Estas dos entraron en la segunda medición: 2,554 ms y 1,829 ms de ejecución. La primera
  // **excede el tope de 2 s** de `tableAt()`, así que sin este índice el reporte de salidas por
  // rango nunca podría declarar su frescura.
  ['analytics.sales_daily', 'updated_at', 'ix_sales_daily_updated_at_desc'],
  ['analytics.route_push_lines', 'imported_at', 'ix_route_push_lines_imported_at_desc'],
];

exports.up = async function (knex) {
  for (const [tabla, col, nombre] of IDX) {
    const { rows } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS ok`, [tabla]);
    if (!rows[0].ok) {
      // eslint-disable-next-line no-console
      console.log(`  [VP.2.2] ${tabla} no existe en este destino — se omite su índice.`);
      continue;
    }
    // Que la columna exista se verifica también: si el feed la renombró, un índice sobre un nombre
    // viejo falla a mitad de una migración sin transacción, que es el peor momento para enterarse.
    const { rows: c } = await knex.raw(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = split_part(?, '.', 1) AND table_name = split_part(?, '.', 2)
          AND column_name = ?`, [tabla, tabla, col],
    );
    if (!c.length) throw new Error(`[VP.2.2] ${tabla} no tiene la columna ${col}`);

    // eslint-disable-next-line no-console
    console.log(`  [VP.2.2] índice ${nombre} sobre ${tabla} (${col} DESC)…`);
    await knex.raw(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${nombre} ON ${tabla} (${col} DESC NULLS LAST)`);
  }
};

exports.down = async function (knex) {
  for (const [tabla, , nombre] of IDX) {
    // El índice vive en el schema de SU tabla — uno es `analytics`, el otro `wincaja`. Calificar los
    // dos igual dejaría el segundo sin dropear y el `down` mentiría diciendo que revirtió.
    const schema = tabla.split('.')[0];
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${schema}.${nombre}`).catch(() => undefined);
  }
  // Los índices son aditivos y sólo aceleran una lectura: dropearlos no recupera nada y vuelve el
  // reporte a pagar 9 s. El `down` existe para poder revertir, no porque convenga.
};
