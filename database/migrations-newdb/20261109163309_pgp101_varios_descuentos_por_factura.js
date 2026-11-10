'use strict';
/**
 * `[PGP.101]` — **Varios descuentos al pagar sobre la misma factura.**
 *
 * `[PGP.91]` dejó UN descuento por factura (motivo, pesos, tasa, nota). Hay proveedores que dan dos
 * a la vez —pronto pago 3 % y volumen 2 %— y Tesorería tenía que sumarlos a mano en un solo «Otro»,
 * perdiendo cuál era cuál (pedido de Edgar, 2026-11-09: «que se pueda agregar más de un descuento»).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  `finance.payment_allocation_items` gana `discount_lines jsonb NULL`: la lista de renglones
 *  `[{reason, amount, rate, note}]`, el mayor primero.
 *  ⭐ Las columnas de `[PGP.91]` siguen siendo el AGREGADO y no cambian de significado:
 *  `discount_amount` = la suma de los renglones (lo cubierto, el neto, el tope del día y el cruce con
 *  Kepler siguen leyéndolo igual), `discount_reason` = el motivo del renglón mayor (cumple el CHECK
 *  de siempre), `discount_rate` y `discount_note` sólo cuando hay un renglón.
 *  NULL = descuento capturado antes de esta migración (o ninguno): el servidor lo lee como UN renglón
 *  armado con las columnas de siempre (`lineasDeDescuento`). No se rellena nada.
 *
 * Por qué una columna y no una tabla hija: el renglón no tiene vida propia (nace, cambia y muere con
 * la factura del pago), y así los cinco lectores de lo cubierto no ganan un JOIN. Sin tabla nueva no
 * hay `tenant_id` que agregar: la fila ya lo tiene (regla 18).
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Columna NULLABLE sin default: sólo metadato, ningún camino de inserción tiene que mandarla.
 *  · El CHECK sólo exige que, si viene, sea un arreglo: las filas existentes (NULL) lo cumplen.
 *  · ⛔ Va en prod ANTES del código: la lectura del día la selecciona por nombre.
 *
 * ── Lo medido antes (sólo lectura) ──────────────────────────────────────────────────────────
 *  · 2026-11-09: 164 pagos `pending` en el Calendario, ninguno `executed` (auditoría de la fase).
 *    No se midió cuántos renglones llevan descuento hoy: el `up` lo imprime al aplicarla.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'payment_allocation_items';
const CHECK = 'ck_pai_discount_lines_array';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⚠️ `withSchema(...).hasColumn`: `hasColumn('finance.x', ...)` devuelve false SIEMPRE.
  if (!(await knex.schema.withSchema('finance').hasColumn(TABLA, 'discount_lines'))) {
    await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { t.jsonb('discount_lines').nullable(); });
  }
  await knex.raw(`COMMENT ON COLUMN finance.${TABLA}.discount_lines IS '[PGP.101] Renglones del descuento al pagar [{reason, amount, rate, note}], el mayor primero; suman discount_amount. NULL = capturado antes de PGP.101 (un renglon: las columnas discount_*).'`);
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'finance.payment_allocation_items'::regclass`, [CHECK]);
  if (!rows.length) {
    await knex.raw(`ALTER TABLE finance.${TABLA} ADD CONSTRAINT ${CHECK} CHECK (discount_lines IS NULL OR jsonb_typeof(discount_lines) = 'array')`);
  }
  const { rows: [m] } = await knex.raw(`SELECT count(*)::int AS n, count(*) FILTER (WHERE discount_amount > 0)::int AS con FROM finance.${TABLA}`);
  console.log(`[PGP.101] ${m.n} renglon(es) de pago; ${m.con} con descuento (se leen como un renglon cada uno).`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE finance.${TABLA} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  if (await knex.schema.withSchema('finance').hasColumn(TABLA, 'discount_lines')) {
    await knex.schema.withSchema('finance').alterTable(TABLA, (t) => { t.dropColumn('discount_lines'); });
  }
};
