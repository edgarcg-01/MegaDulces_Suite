/**
 * [PERF.5a] Índice CUBRIDOR para `kepler_ods.kdpv_prod_util` — los tiers de precio por volumen.
 *
 * ── El síntoma ───────────────────────────────────────────────────────────────────────────────
 * `kdpvSql()` (`services/feeds-ingest/label-compute.js:93`) corre **3,121 veces en 20 h** a 351 ms
 * = 1,047 s. No es la más lenta de la base, pero sí de las más frecuentes.
 *
 * ── La causa, y los dos diagnósticos obvios REFUTADOS con medición ───────────────────────────
 * El único índice de la tabla es la PK `(sucursal, c1, c2, c3)` y el predicado filtra por `c1`,
 * que es la SEGUNDA columna. PG 18.6 lo salva con skip scan (`Index Searches: 10` = las 9
 * sucursales + 1), así que **el acceso al índice no es el problema**. El problema es que `c4` y
 * `c7` NO están en el índice: cada tupla obliga a un viaje al heap. Son **87,934 heap fetches**
 * sobre una tabla cuyo heap entero son **3,528 páginas** — el nodo consume 44,694 buffers para
 * devolver 92,976 filas, o sea **12.7× la tabla completa**.
 *
 * ⛔ «casi seguro hace seq scan» → NO lo hace, y forzarlo es **32× PEOR**: 8,217 ms contra 252 ms
 *   (medido con `enable_indexscan=off`). El seq scan tendría que evaluar `c1 = ANY(<2,142
 *   elementos>)` fila por fila sobre 380,819 = ~430 millones de comparaciones de texto.
 * ⛔ «será una llamada por SKU en un bucle» → es al revés: son **2,142 SKUs POR llamada**, el 22 %
 *   del catálogo (verificado contra `kepler_ods._sync_status.rows_seen` y por aritmética
 *   independiente: 88,463 filas ÷ 39.6 por SKU = 2,234).
 * ⛔ Tampoco es el `btrim` ni los casts: `c4`/`c7` ya son `numeric` y `sucursal` ya es `text`; el
 *   `btrim` sólo aparece en la lista de selección, no en el WHERE, así que no anula nada.
 *
 * ── ⚠️ LA GANANCIA REAL ES 2.5×, NO 76× — y la diferencia NO es el índice ────────────────────
 * Medido en tres estados del mapa de visibilidad, porque publicar sólo el mejor manda a alguien
 * a revertir esto cuando no lo reproduzca:
 *
 *     VM  0.0 %  → Bitmap Heap Scan   3,325 buffers
 *     VM 56.5 %  → Index Only Scan   33,048 buffers  (control sin el índice: 74,417)
 *     VM 99.7 %  → Index Only Scan      550 buffers  ← el "76×", y exige VACUUM previo
 *
 * Prod HOY trae **22,364 heap fetches** sobre el conjunto que toca la consulta, y el
 * `relallvisible` de `pg_class` está congelado desde el 2026-09-22 16:09:50. O sea: sin vacuum,
 * esto rinde ~2.5×. **La otra mitad va en `20260924170100`** (política de autovacuum de la tabla),
 * que es mantenimiento y no índice, por eso va aparte.
 *
 * ⚠️ El índice es sobre `c1` CRUDO porque la consulta filtra `c1` crudo. Si algún día `kdpvSql()`
 * se uniforma a `btrim(c1)` como su hermana `kdiiSql()`, este índice queda INERTE — y un índice
 * inerte se lee igual que uno que sirve, salvo que alguien mire `idx_scan`.
 *
 * ⚠️ NO MEDIDO, declarado: si este índice cambia el plan de los OTROS lectores de la tabla
 * (12,070 seq scans / 3.79 mil millones de tuplas). Los dos de `ods-derived.js:169` y `:329`
 * filtran por `btrim(c1)`, así que un índice sobre `c1` crudo no les aplica — ni les sirve ni los
 * rompe; pero no se corrieron sus planes antes/después.
 *
 * ⛔ LO QUE NO HACE ESTA MIGRACIÓN, y vale MÁS que ella: el despacho de normalizadores
 * (`apply-handlers.js:412`) dispara sobre `rows.length`, NO sobre `changed`. Medido en vivo:
 * `kdpv_prod_util` con `rows_seen=2142, rows_last=0` — el carril embarcó 2,142 filas, cambió
 * CERO, y el normalizador recomputó las 2,142 igual. Son **276 millones de filas leídas en 20 h
 * para producir 2,751 cambios de etiqueta**. Gatearlo en `changed` mataría la mayoría de estas
 * 3,121 llamadas Y de las 1,881 de `normalizeSalePrice`, pero **cambia QUÉ se recomputa, no cuán
 * rápido** — es cambio de alcance, no optimización, y quita un re-disparo periódico que hoy
 * funciona como auto-curación accidental. Va con su propia decisión y su propia medición.
 *
 * @param { import("knex").Knex } knex
 */

// ⛔ CONCURRENTLY exige estar fuera de transacción.
exports.config = { transaction: false };

const NOMBRE = 'ix_kdpv_prod_util_c1_cov';
const TABLA = 'kepler_ods.kdpv_prod_util';

exports.up = async function up(knex) {
  // ⛔ Un `CREATE INDEX CONCURRENTLY` que falla a mitad deja un índice con ESE MISMO NOMBRE y
  // `indisvalid = false`. Un `CREATE ... IF NOT EXISTS` lo saltea y la migración sale EN VERDE,
  // dejando un índice que nadie usa y que se mantiene en cada escritura. Se limpia primero.
  // (El DROP no puede ir dentro de un bloque DO: `CONCURRENTLY` no corre en transacción.)
  const { rows: previo } = await knex.raw(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('kepler_ods.${NOMBRE}')`);
  if (previo.length && previo[0].indisvalid === false) {
    console.log(`  ⚠ ${NOMBRE} existía INVÁLIDO (un CONCURRENTLY anterior falló) — se descarta.`);
    await knex.raw(`DROP INDEX CONCURRENTLY kepler_ods.${NOMBRE}`);
  }

  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${NOMBRE}
                    ON ${TABLA} (c1) INCLUDE (sucursal, c2, c4, c7)`);

  // La prueba negativa del propio paso: que reviente acá y no en la pantalla.
  const { rows } = await knex.raw(
    `SELECT indisvalid, indisready FROM pg_index WHERE indexrelid = to_regclass('kepler_ods.${NOMBRE}')`);
  if (!rows.length || rows[0].indisvalid !== true || rows[0].indisready !== true) {
    throw new Error(`${NOMBRE} quedó INVÁLIDO: el planificador no lo va a usar y aun así se `
      + 'mantiene en cada escritura de la tabla. Hacerle DROP y volver a correr esta migración.');
  }

  await knex.raw(`COMMENT ON INDEX kepler_ods.${NOMBRE} IS `
    + `'[PERF.5a] Sirve a kdpvSql() en services/feeds-ingest/label-compute.js:93. Convierte un `
    + `Index Scan con 87,934 heap fetches en un Index Only Scan. ⚠️ La ganancia DEPENDE del mapa `
    + `de visibilidad: 550 buffers con el VM al 99.7 por ciento, 33,048 con el VM real de hoy `
    + `(control sin indice: 74,417). La otra mitad es la politica de autovacuum de la tabla, en `
    + `20260924170100. ⚠️ Es sobre c1 CRUDO: si kdpvSql se uniforma a btrim(c1) como kdiiSql, `
    + `este indice queda INERTE.'`);

  console.log(`  ✓ ${NOMBRE} válido. Verificar que sirva: idx_scan de pg_stat_user_indexes tiene `
    + 'que crecer en minutos — un índice que nadie usa se ve igual que uno que funciona.');
};

exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.${NOMBRE}`);
};
