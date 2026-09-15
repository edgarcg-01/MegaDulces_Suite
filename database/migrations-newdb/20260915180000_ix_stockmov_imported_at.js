/**
 * [DB-MEM.3] — **El monitor de salud escaneaba 1 GB de disco para saber la hora.**
 *
 * `apps/api/src/modules/db-health/db-health.service.ts:926` arma el sensor genérico así:
 *
 *     SELECT max("imported_at") AS last_update, count(*)::bigint AS rows FROM <tabla>
 *
 * Son **37 sensores**, y `analytics.stock_movements` (3.7 M filas / 1,955 MB) **no tenía índice
 * sobre `imported_at`** — sus 5 índices son por `(tenant_id, warehouse…)`, `folio` y `code`.
 * Medido en prod antes de este índice:
 *
 *     Parallel Seq Scan on stock_movements  (actual time=3.932..11597.831 rows=1,233,731 loops=3)
 *     Buffers: shared hit=2950 read=128025          ← 1 GB leído de DISCO, cada 5 minutos
 *
 * `db-health-scanner.service.ts:53` corre `@Cron('0 *\/5 * * * *')` → **288 veces al día**.
 *
 * ── DESPUÉS (medido en prod con el índice ya válido) ─────────────────────────────────────────
 *
 *     Index Only Scan using ix_stockmov_imported_at  (actual time=21.332..21.332 rows=1)
 *     Buffers: shared hit=2086 read=59
 *
 * **11,597 ms → 21 ms (545×)**, y de 128,025 bloques de disco a **59**.
 *
 * ── POR QUÉ `DESC NULLS LAST` ────────────────────────────────────────────────────────────────
 * `max()` entra por el extremo del índice. Con `DESC NULLS LAST` el valor más alto queda al
 * principio y el planner resuelve con un `Index Only Scan` de una fila. Mismo criterio que
 * `ix_sales_daily_updated_at_desc`, que ya existía en esta base para exactamente esto.
 *
 * ── ⚠️ ESTE ÍNDICE YA EXISTE EN PROD ─────────────────────────────────────────────────────────
 * Se creó a mano con `CREATE INDEX CONCURRENTLY` el 2026-09-15 para no bloquear escrituras (la
 * tabla recibe del feed de movimientos). Esta migración lo deja **reproducible**: sin ella, una
 * base recreada desde cero no lo tendría y el sensor volvería al seq scan sin que nadie lo note.
 * Por eso es `IF NOT EXISTS` — en prod es no-op.
 *
 * ⚠️ `CONCURRENTLY` **no puede correr dentro de una transacción**, y knex envuelve cada
 * migración en una. Por eso acá va sin `CONCURRENTLY`: en una base nueva la tabla está vacía o
 * es chica y el lock no molesta; en prod ya está creado y esto no hace nada.
 *
 * ⚠️ Lección aparte, del día que se creó: el `CREATE INDEX CONCURRENTLY` quedó **39 minutos**
 * en `waiting for old snapshots`, bloqueado por un request del API de **71 minutos** sobre
 * `analytics.v_route_sales_lines`. `CONCURRENTLY` no bloquea escrituras, pero **espera a toda
 * transacción abierta anterior**: una consulta larga lo deja colgado indefinidamente.
 */
exports.up = async function up(knex) {
  // ⚠️ Se pregunta ANTES con `to_regclass` en vez de confiar en `IF NOT EXISTS`. Medido el
  // 2026-09-15 contra prod: `CREATE INDEX IF NOT EXISTS` **igual pide un lock sobre la tabla**
  // para resolver el "if", y con el feed de movimientos escribiendo, ese lock no llegó —
  // `canceling statement due to lock timeout`. O sea: el `IF NOT EXISTS` evita el error de
  // "ya existe", NO evita el lock. En una tabla caliente eso basta para tumbar la migración.
  const ya = await knex.raw(`select to_regclass('analytics.ix_stockmov_imported_at') AS x`);
  if (ya.rows[0].x) return;

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_stockmov_imported_at
      ON analytics.stock_movements (imported_at DESC NULLS LAST)`);
  await knex.raw(`COMMENT ON INDEX analytics.ix_stockmov_imported_at IS
    '[DB-MEM.3] Para el max(imported_at) del sensor de db-health (37 sensores, cada 5 min). Sin el: Parallel Seq Scan de 128,025 bloques de disco y 11,597 ms. Con el: Index Only Scan, 59 bloques, 21 ms.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_stockmov_imported_at`);
};
