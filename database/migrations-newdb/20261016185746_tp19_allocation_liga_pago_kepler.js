'use strict';
/**
 * `[TP.19.3]` — **El pago ejecutado dice CUÁL es en Kepler** (objetivo O3 del plan de unificación).
 *
 * Hasta hoy, al marcar un pago como ejecutado el Calendario cerraba su parte y el rastro se
 * cortaba ahí: el pago reaparecía en el ERP —y en la pantalla «Pagos a proveedor»— como un evento
 * **sin origen**. Nadie podía contestar, sin reconstruirlo a mano, *«¿de qué día del calendario
 * salió esta transferencia?»* ni *«¿este pago que autorizó Gerencia, ya se asentó?»*.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-16) ────────────────────────────────────────
 *  · `finance.payment_allocations`: **0** pagos con referencia al documento de Kepler — la
 *    columna no existía.
 *  · `analytics.erp_supplier_payments`: **4,787** pagos del ERP, cada uno identificado por
 *    `(sucursal, doc_prefix, folio)` — la misma terna con que «Pagos a proveedor» cuelga su
 *    comprobante.
 *
 * ⭐ **Cierra tres deudas que `[TP.15]` dejó declaradas**, y las tres son la misma falta de liga:
 * el tope de saldo no sabía qué pagos del Calendario ya había registrado Kepler; «sin saldo»
 * mezclaba *pagada* con *no casó*; y un pago ejecutado no se podía reencontrar.
 *
 * ⚠️ **Nullable a propósito, y no es pereza.** Un pago se ejecuta cuando el dinero sale; su
 * documento en el ERP puede capturarse minutos u horas después. Exigir la terna al ejecutar
 * obligaría a mentir —inventar un folio— para poder cerrar el pago. Lo que falta se **declara**
 * con NULL (ADR-056), y se liga después.
 *
 * ⛔ **Sin FK a `analytics.erp_supplier_payments`**: es un espejo del ERP que se repuebla, y una
 * FK contra él haría que repoblar el espejo pudiera fallar por filas nuestras. La integridad la
 * da el cruce, no el constraint.
 *
 * Idempotente (`hasColumn`).
 *
 * @param { import("knex").Knex } knex
 */

const ESQUEMA = 'finance';
const TABLA_SOLA = 'payment_allocations';
const TABLA = `${ESQUEMA}.${TABLA_SOLA}`;
const COLS = [
  ['kepler_payment_sucursal', 'text'],
  ['kepler_payment_doc_prefix', 'text'],
  ['kepler_payment_folio', 'text'],
  // Quién y cuándo la ligó: sin esto no se puede distinguir una liga hecha por una persona de una
  // que propuso el sistema, que es justo lo que permite medir si el cruce automático acierta.
  ['kepler_payment_linked_at', 'timestamptz'],
  ['kepler_payment_linked_by', 'text'],
];

/**
 * ⛔⛔ **`hasColumn('finance.payment_allocations', …)` MIENTE: devuelve `false` aunque la columna
 * exista.** Knex trata el argumento como el nombre de la tabla, no como `esquema.tabla`, así que
 * busca una tabla llamada literalmente «finance.payment_allocations» en el `search_path`.
 *
 * Medido el 2026-10-16: con la columna ya creada, `hasColumn('finance.payment_allocations', 'x')`
 * → **false**, y `withSchema('finance').hasColumn('payment_allocations', 'x')` → **true**. Escrito
 * de la primera forma, esta migración **no era idempotente**: a la segunda corrida moría con
 * `column … already exists`. Lo cazó el spec de integración al reaplicarla.
 */
const tieneColumna = (knex, col) => knex.schema.withSchema(ESQUEMA).hasColumn(TABLA_SOLA, col);

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [col, tipo] of COLS) {
    if (!(await tieneColumna(knex, col))) {
      await knex.raw(`ALTER TABLE ${TABLA} ADD COLUMN ${col} ${tipo}`);
    }
  }
  // Un mismo documento de Kepler no puede estar ligado a dos pagos del calendario: sería contar
  // dos veces la misma salida de dinero. Parcial, porque lo NO ligado (NULL) es lo normal.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS payment_allocations_kepler_doc_uniq
        ON ${TABLA} (tenant_id, kepler_payment_sucursal, kepler_payment_doc_prefix, kepler_payment_folio)
     WHERE kepler_payment_folio IS NOT NULL`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw(`DROP INDEX IF EXISTS finance.payment_allocations_kepler_doc_uniq`);
  for (const [col] of COLS) {
    if (await tieneColumna(knex, col)) await knex.raw(`ALTER TABLE ${TABLA} DROP COLUMN ${col}`);
  }
};
