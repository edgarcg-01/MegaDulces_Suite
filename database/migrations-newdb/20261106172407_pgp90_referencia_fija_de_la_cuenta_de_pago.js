'use strict';
/**
 * `[PGP.90]` — **La referencia de pago FIJA de una cuenta de proveedor.**
 *
 * Hay proveedores que exigen, en CADA transferencia, la misma referencia (un convenio o una
 * referencia numérica que ellos asignan a Mega Dulces). Sin ella el proveedor no identifica el
 * depósito y el pago queda sin aplicar del lado de él. Hoy no hay dónde guardarla: la cuenta
 * tiene banco/cuenta/CLABE/alias y nada más, así que la referencia viaja en la cabeza de quien
 * paga o en un papel (lo pidió Francisco el 2026-11-03 sobre «Cuentas de pago»).
 *
 * Es un dato de la CUENTA, no del pago: si la referencia cambia en cada pago (p. ej. el número
 * de factura), se deja vacía aquí — esta columna sólo guarda la que no cambia.
 *
 * Historia: nació como `[PGP.43]`/`[PGP.50]` en el PR #482, que se cerró sin fusionar el
 * 2026-11-06 cuando Edgar rehízo la pantalla de Pagos. Esa migración nunca entró a `main` ni
 * se aplicó desde él; ésta la reemplaza con número y marca de tiempo nuevos.
 *
 * ── Lo medido antes (sólo lectura del código, 2026-11-06) ───────────────────────────────────
 *  · Ninguna columna `payment_reference` existe en `main` (`git grep`, 0 resultados).
 *  · Caminos que escriben en las dos tablas (regla 14): `libs/finance/.../supplier-payment-accounts
 *    .service.ts` (alta/cambio/aprobación y «registrar desde el pago») — el único montado. El
 *    gemelo de `libs/commercial` no lo registra ningún módulo de la API.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  · `commercial.supplier_payment_accounts.payment_reference` — la vigente.
 *  · `commercial.supplier_payment_account_change_requests.proposed_payment_reference` — la que
 *    se propone. Pasa por la MISMA autorización que la CLABE (ADR-064): una referencia mal puesta
 *    es dinero que el proveedor no reconoce, igual de sensible que la cuenta.
 *  Ambas NULLABLE, sin default: tablas existentes, sin reescritura, y ningún camino de inserción
 *  existente se rompe (regla 14).
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const COLS = [
  ['supplier_payment_accounts', 'payment_reference',
    '[PGP.90] Referencia que el proveedor exige en CADA transferencia a esta cuenta (convenio o referencia numerica). Vacia si cambia en cada pago.'],
  ['supplier_payment_account_change_requests', 'proposed_payment_reference',
    '[PGP.90] Referencia fija propuesta para la cuenta. Se aplica solo al aprobar, como la CLABE.'],
];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const [tabla, col, comentario] of COLS) {
    // ⚠️ `withSchema(...).hasColumn`: `hasColumn('commercial.x', ...)` devuelve false SIEMPRE.
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
