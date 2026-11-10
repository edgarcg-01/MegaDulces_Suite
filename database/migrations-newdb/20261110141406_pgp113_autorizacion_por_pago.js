'use strict';
/**
 * `[PGP.113]` — **Se autoriza el PAGO, no el día.**
 *
 * Edgar (2026-11-10): «haremos una a una, así que necesito se rediseñe el módulo» — confirmado:
 * cada pago se prepara, se autoriza, se paga, se valida y va a Kepler por su cuenta. Hasta hoy la
 * firma de Dirección era del DÍA (`payment_calendar_lots.released_by/at`) y exigía TODOS sus pagos
 * preparados y ordenados: uno sin preparar frenaba a los demás. Medido en prod el 2026-11-10:
 * 37 días armados, los 37 en borrador; **ningún día se autorizó nunca**.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `finance.payment_allocations` gana dos columnas NULLABLE, que llena `authorize()`:
 *  · `authorized_by` text        — quién autorizó ESTE pago.
 *  · `authorized_at` timestamptz — cuándo. NULL = sin autorizar (o se le quitó la autorización).
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Dos columnas NULLABLE sin default: ningún camino de inserción cambia (`createAllocation`,
 *    `reprogram` —el pago nuevo nace sin autorizar, a propósito—, el seed y las pruebas).
 *  · El código desplegado no las lee: sigue autorizando por día. Puede ir antes que el código.
 *  · ⛔ Pero el código de PGP.113 SÍ las lee y escribe: va en prod ANTES del código.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'payment_allocations';
const COLS = [
  ['authorized_by', (t) => t.text('authorized_by').nullable(),
    '[PGP.113] Quien autorizo ESTE pago (se autoriza el pago, no el dia). NULL = sin autorizar.'],
  ['authorized_at', (t) => t.timestamp('authorized_at', { useTz: true }).nullable(),
    '[PGP.113] Cuando se autorizo este pago. NULL = sin autorizar o se le quito la autorizacion.'],
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
  const { rows: [m] } = await knex.raw(`SELECT count(*) FILTER (WHERE status = 'pending')::int AS pendientes FROM finance.${TABLA}`);
  console.log(`[PGP.113] ${m.pendientes} pago(s) pendientes quedan sin autorizar (NULL): se autorizan uno a uno.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const [col] of COLS.slice().reverse()) {
    if (await knex.schema.withSchema('finance').hasColumn(TABLA, col)) {
      await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { t.dropColumn(col); });
    }
  }
};
