'use strict';
/**
 * `[PGP.107]` — **El pago guarda la evidencia que lo probó.**
 *
 * Flujo nuevo de Pagos (Edgar, 2026-11-09, F2): «Pagado» lo pone la evidencia — la salida del estado
 * de cuenta + su comprobante (`[PGP.103]`/`[PGP.104]`) — y de ahí salen el `X-D-26` de Kepler y la
 * póliza de egreso de ContPAQi. Hasta hoy la validación se calculaba al leer y no dejaba rastro:
 * ni Kepler ni ContPAQi sabrían la fecha, la cuenta y el importe REALES del pago.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `finance.payment_allocations` gana cinco columnas, todas NULLABLE, que llena `execute()` al
 *  marcar Pagado:
 *  · `paid_bank_movement_id` uuid — la salida de `finance.bank_movements` que lo probó.
 *  · `paid_proof_id`         uuid — el comprobante de `finance.supplier_payment_proofs`.
 *  · `paid_bank_date`        date — la fecha de esa salida (la fecha REAL del pago).
 *  · `paid_bank_amount`      numeric(14,2) — su importe.
 *  · `paid_validated_at`     timestamptz — cuándo se validó.
 *  ⛔ **Sin llave foránea, a propósito:** Tesorería vuelve a subir el estado de cuenta del mes y la
 *  carga REEMPLAZA sus movimientos (así se perdió noviembre el 5-nov, `[PGP.97.1]`). Una FK haría
 *  fallar esa carga o borraría la evidencia en cascada. Por eso la fecha y el importe se guardan
 *  aparte: la prueba sobrevive aunque el id del movimiento cambie.
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Cinco columnas NULLABLE sin default: sólo metadato; ningún camino de inserción cambia
 *    (`createAllocation`, `reprogram`, el seed y las pruebas no las mandan y quedan en NULL).
 *  · Los pagos ya `executed` (0 en prod, medido 2026-11-09) quedarían en NULL: «pagado sin
 *    evidencia guardada», que es la verdad.
 *  · ⛔ Va en prod ANTES del código: `execute()` las escribe.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'payment_allocations';
const COLS = [
  ['paid_bank_movement_id', (t) => t.uuid('paid_bank_movement_id').nullable(),
    '[PGP.107] Salida del estado de cuenta (finance.bank_movements.id) que probo el pago. Sin FK: la recarga del estado de cuenta reemplaza movimientos.'],
  ['paid_proof_id', (t) => t.uuid('paid_proof_id').nullable(),
    '[PGP.107] Comprobante (finance.supplier_payment_proofs.id) que probo el pago, ligado por la cuenta de origen del OCR, importe y fecha.'],
  ['paid_bank_date', (t) => t.date('paid_bank_date').nullable(),
    '[PGP.107] Fecha REAL de la salida del banco. Se guarda aparte: sobrevive a la recarga del estado de cuenta.'],
  ['paid_bank_amount', (t) => t.decimal('paid_bank_amount', 14, 2).nullable(),
    '[PGP.107] Importe de la salida del banco que probo el pago.'],
  ['paid_validated_at', (t) => t.timestamp('paid_validated_at', { useTz: true }).nullable(),
    '[PGP.107] Cuando se valido el pago contra el banco y su comprobante (al marcarlo Pagado). NULL = pagado sin evidencia guardada (efectivo, o anterior a PGP.107).'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [col, def, comentario] of COLS) {
    // ⚠️ `withSchema(...).hasColumn`: `hasColumn('finance.x', ...)` devuelve false SIEMPRE.
    if (!(await knex.schema.withSchema('finance').hasColumn(TABLA, col))) {
      await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { def(t); });
    }
    await knex.raw(`COMMENT ON COLUMN finance.${TABLA}.${col} IS '${comentario}'`);
  }
  const { rows: [m] } = await knex.raw(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'executed')::int AS pagados FROM finance.${TABLA}`);
  console.log(`[PGP.107] ${m.n} pago(s); ${m.pagados} ya marcados pagados quedan sin evidencia guardada (NULL).`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const [col] of COLS.slice().reverse()) {
    if (await knex.schema.withSchema('finance').hasColumn(TABLA, col)) {
      await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { t.dropColumn(col); });
    }
  }
};
