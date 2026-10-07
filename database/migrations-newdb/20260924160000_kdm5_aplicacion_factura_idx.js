/**
 * [PERF.4a] El índice que le falta a `kepler_ods.kdm5` para resolver la cartera POR DOCUMENTO.
 *
 * ── Por qué existe esta migración separada ───────────────────────────────────────────────
 * Va SOLA y va PRIMERO. La migración hermana (`20260924160100`) reescribe
 * `analytics.erp_sales_invoices` para que resuelva la cartera con un LATERAL por clave en vez
 * de construir la pirámide entera. Ese cambio **depende** de este índice, y no de forma
 * gradual: medido en prod, el LATERAL sin el índice cuesta **1,820,114 páginas** contra las
 * **14,682** de la vista actual — 124× PEOR. Con el índice son 15,254 y 82 ms.
 *
 * O sea que el orden no es una preferencia de estilo: si la vista entra antes que el índice,
 * la ventana entre las dos migraciones es un incidente. Por eso la hermana **verifica que este
 * índice exista y aborta si no**, en vez de confiar en que las migraciones corran en orden.
 *
 * ⛔ `CREATE INDEX CONCURRENTLY` no puede correr dentro de una transacción, y knex las envuelve
 * por defecto. De ahí el `exports.config`. El repo ya tiene este patrón en `20260805240000` y
 * `20260905150000`.
 *
 * ── Qué cubre, y por qué esas columnas en ese orden ──────────────────────────────────────
 * Es el prefijo EXACTO de los predicados que la función `analytics.erp_receivable_doc` aplica
 * sobre `kdm5`: sucursal, tipo de documento cargo, y la llave (c9, c10, c11) del documento al
 * que se aplica el abono. El `WHERE c2 = 'U'` lo hace parcial y barato.
 *
 * Tamaño medido: **592 kB** sobre las 58,668 filas de `kdm5`. No es un índice caro.
 *
 * @param { import("knex").Knex } knex
 */

// ⛔ CONCURRENTLY exige estar fuera de transacción.
exports.config = { transaction: false };

exports.up = async function up(knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_kdm5_aplicacion_factura
      ON kepler_ods.kdm5 (btrim(c1), btrim(c8), btrim((c9)::text), btrim((c10)::text), btrim(c11))
      WHERE c2 = 'U'`);

  // `CONCURRENTLY` puede dejar el índice INVÁLIDO si falla a mitad, y en ese estado el
  // planificador NO lo usa — o sea que la hermana entraría creyendo que está cubierta.
  // Se comprueba, no se supone.
  const { rows: [i] } = await knex.raw(`
    SELECT c.relname, i.indisvalid, i.indisready,
           pg_size_pretty(pg_relation_size(c.oid)) AS tam
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'ix_kdm5_aplicacion_factura'`);
  if (!i) throw new Error('ix_kdm5_aplicacion_factura no quedo creado.');
  if (!i.indisvalid || !i.indisready) {
    throw new Error(
      'ix_kdm5_aplicacion_factura quedo INVALIDO (CONCURRENTLY fallo a mitad). El planificador ' +
      'no lo va a usar. Hay que hacerle DROP y volver a correr esta migracion ANTES de aplicar ' +
      '20260924160100, o la vista queda 124x mas lenta que hoy.');
  }
  console.log(`  ✓ ix_kdm5_aplicacion_factura valido · ${i.tam}`);
};

/** Reversible y barato: el índice es aditivo, no cambia ningún resultado. */
exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS kepler_ods.ix_kdm5_aplicacion_factura');
};
