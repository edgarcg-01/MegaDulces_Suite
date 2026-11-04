'use strict';
/**
 * `[PGP.50]` — **La referencia de pago FIJA de una cuenta de proveedor.**
 *
 * Hay proveedores que exigen, en CADA transferencia, la misma referencia (un convenio o una
 * referencia numérica que ellos asignan a Mega Dulces). Sin ella el proveedor no identifica el
 * depósito y el pago queda sin aplicar del lado de él. Hoy no hay dónde guardarla: la cuenta
 * tiene banco/cuenta/CLABE/alias y nada más, así que la referencia viaja en la cabeza de quien
 * paga o en un papel (lo pidió Francisco, 2026-11-03, sobre la pantalla «Cuentas de pago»).
 *
 * Es un dato de la CUENTA, no del pago: si la referencia cambia en cada pago (p. ej. el número
 * de factura), se deja vacía aquí — esta columna sólo guarda la que no cambia.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · `commercial.supplier_payment_accounts.payment_reference` — la vigente.
 *  · `commercial.supplier_payment_account_change_requests.proposed_payment_reference` — la que
 *    se propone. Pasa por la MISMA autorización que la CLABE (ADR-064): una referencia mal puesta
 *    es dinero que el proveedor no reconoce, igual de sensible que la cuenta.
 *  Ambas NULLABLE, sin default: tablas existentes, sin reescritura y ningún camino de inserción
 *  existente se rompe (regla 14).
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const COLS = [
  ['supplier_payment_accounts', 'payment_reference',
    '[PGP.50] Referencia que el proveedor exige en CADA transferencia a esta cuenta (convenio o referencia numerica). Vacia si cambia en cada pago.'],
  ['supplier_payment_account_change_requests', 'proposed_payment_reference',
    '[PGP.50] Referencia fija propuesta para la cuenta. Se aplica solo al aprobar, como la CLABE.'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [tabla, col, comentario] of COLS) {
    if (!(await knex.schema.withSchema('commercial').hasColumn(tabla, col))) {
      await knex.schema.withSchema('commercial').alterTable(tabla, (t) => { t.text(col).nullable(); });
    }
    await knex.raw(`COMMENT ON COLUMN commercial.${tabla}.${col} IS '${comentario}'`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const [tabla, col] of COLS) {
    if (await knex.schema.withSchema('commercial').hasColumn(tabla, col)) {
      await knex.schema.withSchema('commercial').alterTable(tabla, (t) => { t.dropColumn(col); });
    }
  }
};
