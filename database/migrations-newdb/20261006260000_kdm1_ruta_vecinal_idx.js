'use strict';
/**
 * `[VEC.5]` — **Índice parcial para que la venta vecinal no se busque recorriendo toda la venta.**
 *
 * Medido en prod antes de escribir esto, con la vista ya en su sitio:
 *
 *     v_kepler_vecinal_sales_docs   (sólo kdm1)   1,506 ms
 *     v_kepler_vecinal_sales_lines  (kdm1⋈kdm2)   5,436 ms
 *     la matriz anual de la pantalla               5,668 ms      ⛔ gate: 1,000 ms
 *
 * El plan explica por qué: el acceso entra por `ix_kdm1_venta_doc`, cuyo `Index Cond` es
 * `(c4)::integer = 10`, y después **descarta 519,225 filas por filtro** para quedarse con las
 * ~8,200 vecinales. O sea que para sumar siete rutas se recorre la venta entera de la empresa.
 *
 * El filtro que de verdad discrimina es `c12` (1 de cada 64 documentos), y ningún índice lo
 * cubría. Éste sí, y además lleva la fecha como segunda columna, que es por donde la pantalla
 * acota siempre.
 *
 * ⚠️ **Va `CONCURRENTLY` y fuera de transacción.** `kdm1` son 555 MB y la alimenta el CDC cada
 * minuto: un `CREATE INDEX` normal tomaría un lock que bloquea esas escrituras. `CONCURRENTLY`
 * toma `SHARE UPDATE EXCLUSIVE`, que no las bloquea — a cambio de dos pasadas sobre la tabla.
 *
 * ⚠️ **Un índice no se agrega a ojo, y hoy mismo hay un precedente**: `20261006170000` creó uno
 * sobre esta misma tabla y `20261006210000` lo revirtió horas después, medido como peor. Si la
 * medición de abajo no se sostiene, este índice se borra igual — el candado
 * `test-newdb-vecinal-truth.js` vigila el tiempo de la matriz y lo dirá.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false }; // CREATE INDEX CONCURRENTLY no corre en transacción

const IDX = 'ix_kdm1_ruta_vecinal';

exports.up = async function up(knex) {
  // ⛔ **`IF NOT EXISTS` miente después de un `CONCURRENTLY` fallido, y la migración dice OK.**
  // Vivido en esta misma migración: el primer intento caducó por `lock_timeout` y dejó el índice
  // en `indisvalid = false` — existe, ocupa espacio, y **el planner no lo usa**. El reintento lo
  // encontró "existente", saltó la construcción y terminó en 0.1 s sobre una tabla de 555 MB.
  // Un índice inválido no se arregla reintentando: hay que tirarlo primero.
  const roto = (await knex.raw(
    `SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ? AND i.indisvalid = false`, [IDX])).rows.length > 0;
  if (roto) await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IDX}`);

  // ⚠️ `CONCURRENTLY` arranca esperando a que terminen las transacciones abiertas sobre `kdm1`, y
  // el CDC le escribe cada minuto: con el `lock_timeout` corto del aplicador (pensado para DDL que
  // SÍ bloquea) la espera caduca antes de empezar. Acá esperar es justamente lo correcto — no se
  // está bloqueando a nadie, se está haciendo cola.
  await knex.raw(`SET lock_timeout = '90s'`);
  await knex.raw(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${IDX}
         ON kepler_ods.kdm1 (btrim(COALESCE(c12, '')), ((c9)::date))
      WHERE c2 = 'U' AND c3 = 'D' AND btrim(COALESCE(c12, '')) ~ '^[0-9]V[0-9]'`);
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${IDX}`);
};
