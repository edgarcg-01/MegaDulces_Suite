'use strict';
/**
 * `[PGP.51]` — **El descuento que el proveedor da AL PAGAR, dicho en el pago.**
 *
 * Hay proveedores que, al momento de pagarles, conceden un descuento (3 % de pronto pago, o uno
 * por volumen). Kepler lo formaliza DESPUÉS, con una nota de crédito (`X-D-55/56`) o una
 * bonificación (`45`). Hoy Tesorería calcula el neto a mano —factura menos descuento— y lo
 * captura como importe del pago: el descuento no queda en ningún lado y el sobrante de la factura
 * **se vuelve a ofrecer** en el Calendario mientras la nota de crédito no llega (lo pidió
 * Francisco, 2026-11-03).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `finance.payment_allocation_items` gana cuatro columnas:
 *  · `discount_amount` numeric(14,2) NOT NULL DEFAULT 0 — pesos de descuento sobre esa factura.
 *  · `discount_reason` text — `pronto_pago | volumen | otro` (lista cerrada).
 *  · `discount_rate`   numeric(9,6) — la fracción, SÓLO si se capturó en %; NULL si en pesos.
 *  · `discount_note`   text — el detalle libre (la API lo exige cuando el motivo es `otro`).
 *  Y un CHECK de consistencia: hay motivo **si y sólo si** hay descuento.
 *
 * ⭐ La invariante que gobierna todo lo demás:
 *    `applied_amount` sigue siendo el **NETO que sale del banco** (no cambia de significado:
 *    `amount_assigned`, el tope del día, los PDF y el cruce con el `X-D-26` de Kepler por monto
 *    siguen leyéndolo igual). Lo que la factura queda **cubierta** es `applied_amount +
 *    discount_amount`, y eso es lo que se resta del disponible.
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · `discount_amount` es NOT NULL con DEFAULT constante: en PG ≥ 11 es sólo metadato (sin
 *    reescribir la tabla) y TODO camino de inserción que no lo mande queda en 0 — los tres del
 *    servicio (`createAllocation`, `addItem`, `reprogram`), el seed demo y las pruebas.
 *  · Las otras tres son NULLABLE, sin default.
 *  · Los CHECK validan las filas existentes al crearse: todas quedan en `0 / NULL`, que cumple.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · `finance.payment_allocation_items` tiene **360 filas** en prod (medido en sólo lectura el
 *    2026-11-03): validar los 4 CHECK con el candado ACCESS EXCLUSIVE recorre 360 filas, nada. El
 *    `lock_timeout` de 5 s acota la espera del candado; `ADD COLUMN … DEFAULT 0` sólo toca metadatos.
 *
 * Aditiva e idempotente: cada columna y cada restricción se crea sólo si falta.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'payment_allocation_items';

const COLS = [
  ['discount_amount', (t) => t.decimal('discount_amount', 14, 2).notNullable().defaultTo(0),
    '[PGP.51] Descuento que el proveedor concede AL PAGAR esta factura, en pesos. applied_amount es el NETO que sale del banco; lo cubierto de la factura es applied_amount + discount_amount. Kepler lo formaliza despues con una nota de credito.'],
  ['discount_reason', (t) => t.text('discount_reason').nullable(),
    '[PGP.51] Motivo del descuento al pagar: pronto_pago | volumen | otro. NULL si no hay descuento.'],
  ['discount_rate', (t) => t.decimal('discount_rate', 9, 6).nullable(),
    '[PGP.51] Tasa del descuento como fraccion (0.03 = 3 %), solo si se capturo en porcentaje sobre la factura con IVA. NULL si se capturo en pesos.'],
  ['discount_note', (t) => t.text('discount_note').nullable(),
    '[PGP.51] Detalle libre del descuento. La API lo exige cuando el motivo es otro.'],
];

const CHECKS = [
  ['ck_pai_discount_amount_nonneg', 'discount_amount >= 0'],
  ['ck_pai_discount_reason', `discount_reason IN ('pronto_pago','volumen','otro')`],
  ['ck_pai_discount_rate', 'discount_rate > 0 AND discount_rate < 1'],
  ['ck_pai_discount_consistency', '(discount_amount = 0) = (discount_reason IS NULL)'],
];

async function existeCheck(knex, nombre) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint
      WHERE conname = ? AND conrelid = 'finance.payment_allocation_items'::regclass`, [nombre]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [col, def, comentario] of COLS) {
    // ⚠️ `withSchema(...).hasColumn`: `hasColumn('finance.x', ...)` devuelve false SIEMPRE.
    if (!(await knex.schema.withSchema('finance').hasColumn(TABLA, col))) {
      await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { def(t); });
    }
    await knex.raw(`COMMENT ON COLUMN finance.${TABLA}.${col} IS '${comentario}'`);
  }
  for (const [nombre, expr] of CHECKS) {
    if (!(await existeCheck(knex, nombre))) {
      await knex.raw(`ALTER TABLE finance.${TABLA} ADD CONSTRAINT ${nombre} CHECK (${expr})`);
    }
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const [nombre] of CHECKS) {
    await knex.raw(`ALTER TABLE finance.${TABLA} DROP CONSTRAINT IF EXISTS ${nombre}`);
  }
  for (const [col] of COLS.slice().reverse()) {
    if (await knex.schema.withSchema('finance').hasColumn(TABLA, col)) {
      await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { t.dropColumn(col); });
    }
  }
};
