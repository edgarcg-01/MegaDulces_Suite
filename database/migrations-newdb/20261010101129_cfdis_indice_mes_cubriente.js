'use strict';
/**
 * `[CPA.0]` — **El índice cubriente que le faltaba al testigo fiscal.**
 *
 * ── El problema, medido contra prod (2026-10-10) ────────────────────────────────────────────
 * `analytics.v_contpaqi_cierre_mensual` necesita, por mes, el total de CFDI recibidos y emitidos.
 * Eso son dos sumas sobre `fiscal.cfdis`, y hoy cuestan un recorrido completo de la tabla:
 *
 *     HashAggregate (actual time=455.562..456.224 rows=22)
 *       ->  Seq Scan on cfdis  (rows=103,209, descartadas 325,417)
 *           Buffers: shared hit=58900
 *     Execution Time: 461 ms
 *
 * ⭐ El costo **no es la cantidad de filas, es el ancho**: `fiscal.cfdis` pesa **579 MB (460 MB de
 * heap)** porque carga `xml`, `pdf` y `raw` en la misma tabla. Cualquier recorrido completo
 * arrastra esos megabytes aunque la consulta sólo quiera `fecha`, `rol` y `total`.
 *
 * ⚠️ `ix_fiscal_cfdis_fecha (tenant_id, fecha)` **ya existe y el planificador NO lo elige**, con
 * razón: tendría que ir al heap 103,209 veces a buscar `rol` y `total`. Forzándolo
 * (`enable_seqscan = off`) baja a 276–347 ms, que es mejor pero sigue pagando el heap.
 *
 * ── La forma correcta: `INCLUDE`, y parcial ─────────────────────────────────────────────────
 * Con `rol` y `total` **dentro del índice**, el recorrido es *index-only*: no toca el heap.
 * Y `WHERE fecha >= '2025-01-01'` lo deja en ~103 k entradas en vez de 428 k — la vista no mira
 * más atrás, así que indexar 2018–2024 sería pagar por lo que nadie consulta.
 *
 * ⛔ **No se promete un número.** Medido hoy: la vista completa tarda **938 ms**, de los cuales
 * ~450 son este recorrido. Lo que este índice tiene que lograr es que la vista baje del gate de
 * **500 ms**, y eso **se vuelve a medir después de aplicarlo** — el candado
 * `test-newdb-contpaqi-cierre.js` imprime el tiempo real en cada corrida.
 *
 * ── ⚠️⚠️ CUÁNDO APLICARLA ───────────────────────────────────────────────────────────────────
 * **Fuera de horario hábil.** Construir un índice sobre 460 MB es una escritura pesada, y la
 * regla del proyecto no distingue entre un `UPDATE` y un `CREATE INDEX`: lo que importa es el
 * trabajo que le mete a la base mientras la gente opera.
 *
 * ⚠️ `CONCURRENTLY`, y por eso `transaction: false`: sin eso el `CREATE INDEX` toma un
 * `SHARE LOCK` que **bloquea las escrituras** de `fiscal.cfdis`, y esa tabla la escriben los
 * carriles `contpaqi_add_cfdis` (@5 min) y `contpaqi_add_cfdis_full` (nocturno).
 *
 * ⚠️ `IF NOT EXISTS` no alcanza como red: un `CONCURRENTLY` interrumpido deja el índice en estado
 * **INVALID**, y un `IF NOT EXISTS` posterior lo da por bueno. Si esta migración se corta a la
 * mitad, hay que comprobar `pg_index.indisvalid` y, si está en `false`, borrarlo y repetir.
 *
 * @param { import("knex").Knex } knex
 */

exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_fiscal_cfdis_mes_rol
        ON fiscal.cfdis (tenant_id, fecha)
     INCLUDE (rol, total)
         WHERE fecha >= DATE '2025-01-01'`);

  const { rows } = await knex.raw(`
    SELECT i.indisvalid AS valido, pg_size_pretty(pg_relation_size(i.indexrelid)) AS tamano
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'ix_fiscal_cfdis_mes_rol'`);
  if (!rows.length) {
    console.log('  [CPA.0] ⛔ el indice no existe despues del CREATE — revisar');
  } else if (!rows[0].valido) {
    console.log('  [CPA.0] ⛔ el indice quedo INVALID (CONCURRENTLY interrumpido): DROP y repetir');
  } else {
    console.log(`  [CPA.0] ix_fiscal_cfdis_mes_rol valido · ${rows[0].tamano}`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS fiscal.ix_fiscal_cfdis_mes_rol');
};
