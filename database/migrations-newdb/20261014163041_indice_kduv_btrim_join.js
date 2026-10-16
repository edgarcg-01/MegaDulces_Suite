'use strict';
/**
 * `[VEC.13]` — **El índice que `kduv` ya tenía, pero sobre las expresiones que las vistas usan.**
 *
 * `kepler_ods.kduv` (el catálogo de rutas/vendedores, **400 filas**) tiene `kduv_pkey` sobre
 * `(sucursal, c2)`. Pero **las 13 vistas que lo leen unen por `btrim(sucursal)` y `btrim(c2)`** —
 * porque el ODS trae los códigos con relleno— y una expresión no puede servirse de un índice sobre
 * la columna cruda. El planner no tiene otra: **Seq Scan de las 400 filas, una vez por documento**.
 *
 * ── Lo medido antes, contra prod (sólo lectura, 2026-10-14) ─────────────────────────────────
 *
 * `analytics.v_kepler_vecinal_monthly`, 61 filas de salida:
 *
 *     sólo las cabeceras (kdm1) ...................     37 /   42 ms
 *     cabeceras + LATERAL sobre kdm2 .............     142 /  329 ms
 *     cabeceras + kduv (como está hoy) ...........   1,076 / 1,243 ms   <- todo el costo
 *
 * En el plan: `Nested Loop Left Join`, `loops=9016`, **`Rows Removed by Join Filter: 3,597,384`**.
 * O sea 3.6 millones de comparaciones para resolver 400 filas de catálogo.
 *
 * ⭐ **La prueba, sin crear nada**: con `SET enable_nestloop = off` —que obliga al planner a
 * hashear el catálogo una sola vez, que es justo lo que el índice le va a permitir hacer barato—
 * la misma vista pasa de **1,029–1,133 ms a 42–44 ms**. **25×.**
 *
 * ── Por qué importa más allá de la vecinal ──────────────────────────────────────────────────
 *
 * Son **13 objetos** los que leen `kduv`, y entre ellos está `analytics.mv_kepler_sales_daily`
 * (**430 MB**, el sell-out) con exactamente el mismo `LEFT JOIN ... ON btrim(v.sucursal) = ...`.
 * Esta migración no arregla una pantalla: destraba el patrón en todas.
 *
 * ── Lo que esto desbloquea ──────────────────────────────────────────────────────────────────
 *
 * `analytics.mv_kepler_vecinal_monthly` es una **copia** (matvista de 88 kB, refresco cada 30 min)
 * que existe *sólo* porque la vista viva no bajaba del gate de 1,000 ms. Con la vista viva en
 * ~44 ms deja de tener razón de ser, y `/comercial/ventas-por-ruta` puede volver a leer el dato
 * **en vivo** — que es la regla de la casa (derive-no-copy, ADR-059). Ese retiro va en su propio
 * commit, después de medirlo con el índice ya puesto: *primero el índice, después la decisión*.
 *
 * ── Elecciones, y por qué ───────────────────────────────────────────────────────────────────
 *
 * ⛔ **No se quita el `btrim` de las vistas.** Sería "arreglarlo" cambiando lo que comparan: si
 * algún código viene con relleno, el join dejaría de encontrarlo y la venta de esa ruta
 * desaparecería **sin error**. El índice no cambia ni un resultado.
 *
 * ⚠️ **`CREATE INDEX` a secas, no `CONCURRENTLY`.** Sobre 400 filas la construcción es de
 * milisegundos, y `CONCURRENTLY` no puede correr dentro de la transacción de la migración. El
 * riesgo real no es construirlo: es esperar el `ACCESS EXCLUSIVE` detrás de una consulta larga —
 * y de eso se encarga el `lock_timeout`, que prefiere fallar a encolar al resto.
 *
 * ⚠️ `IF NOT EXISTS` + `DROP INDEX IF EXISTS`: idempotente en los dos sentidos.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_kduv_btrim_suc_code
        ON kepler_ods.kduv (btrim(sucursal), btrim(c2))`);
  // El planner necesita estadísticas de la expresión para elegirlo; sin esto puede seguir
  // prefiriendo el Seq Scan que ya conoce.
  await knex.raw(`ANALYZE kepler_ods.kduv`);
  await knex.raw(`
    COMMENT ON INDEX kepler_ods.ix_kduv_btrim_suc_code IS
      '[VEC.13] Las 13 vistas que leen kduv unen por btrim(); kduv_pkey es sobre la columna cruda y no les sirve. Medido 2026-10-14: v_kepler_vecinal_monthly 1,077 -> 42 ms.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS kepler_ods.ix_kduv_btrim_suc_code`);
};
