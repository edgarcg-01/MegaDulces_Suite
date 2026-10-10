/**
 * `[CG.76]` **El índice que le faltaba a la fecha de CAPTURA de `kdm1`.**
 *
 * ── Qué problema resuelve, medido contra prod (2026-10-09) ──────────────────────────────────
 *
 * La bandeja de `/finanzas/caja-general` lee `analytics.kepler_bank_movements`, y esa vista
 * **escanea `kepler_ods.kdm1` ENTERA —678,918 filas— para devolver 75**:
 *
 *   Parallel Seq Scan on kdm1 d  (rows=226,306 × 3 workers)  → 503 ms dentro del CTE
 *   total de la consulta ........................................ 1,021 ms
 *
 * Son dos defectos encadenados y éste arregla el segundo:
 *   1. el filtro de fecha queda FUERA del CTE, así que nunca llega al escaneo (se arregla en la
 *      migración de la vista, aparte);
 *   2. y aunque llegara, **no hay por dónde**: `kdm1` tiene diez índices y **ninguno sobre `c68`**
 *      (la fecha de captura). Medido: el escaneo ya filtrado cuesta **235 ms**.
 *
 * Selectividad medida: **9,952 de 678,918 filas** en la ventana de 2 días = **1.5 %**. Un índice
 * acá convierte un seq scan de 235 ms en una lectura de índice de milisegundos.
 *
 * ⚠️ La expresión es `(c68::date)` y no `c68` a secas, porque así lo escribe la vista
 * (`d.c68::date AS fcap`). Un índice sobre la columna cruda **no se usaría**: el cast la vuelve
 * una expresión y el planificador necesita que el índice tenga la MISMA forma. Es el mismo criterio
 * de `ix_kdm1_venta_fecha` y `ix_kdm1_compra_fecha`, que ya indexan `((c9)::date)`.
 *
 * ⛔ Y NO lleva `WHERE` parcial, a diferencia de sus dos hermanos. Ellos acotan por tipo de
 * documento (`c2='U' AND c3='D'`, `c2='X' AND c3='A'`) porque sirven a una pantalla de ventas y a
 * una de compras. La bandeja de caja mezcla **seis** tipos (`U-A-5`, `U-A-25`, `X-A-45`, `X-D-26`…)
 * y el conjunto cambia cuando se agrega uno: un índice parcial se quedaría viejo **en silencio**
 * —dejaría de usarse y la consulta volvería al seq scan sin que nada se rompa—, que es la peor
 * forma de envejecer.
 *
 * ⚠️ `CONCURRENTLY`, y por eso `transaction: false`: `kdm1` es la tabla más escrita del ODS (el
 * carril la reescribe cada 2 s) y un `CREATE INDEX` normal toma `SHARE` sobre ella, bloqueando al
 * shipper mientras construye. Con `CONCURRENTLY` el carril sigue entregando.
 *
 * ⚠️ `IF NOT EXISTS` no alcanza como red: un `CONCURRENTLY` interrumpido deja el índice **INVALID**
 * y ese índice existe pero no se usa. Si esta migración falla a mitad, hay que mirar
 * `pg_index.indisvalid` y recrearlo — no basta con volver a correrla.
 */
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm1_captura
      ON kepler_ods.kdm1 (((c68)::date))
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm1_captura');
};
