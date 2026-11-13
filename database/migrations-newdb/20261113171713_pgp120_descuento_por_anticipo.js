'use strict';
/**
 * `[PGP.120]` — **El anticipo se aplica desde la programación de pagos.**
 *
 * Pedido de Edgar (2026-11-13): *«estos que se puedan aplicar directamente en la programación de
 * pagos»* — los anticipos a proveedor (`X-D-60`) que el submódulo de Anticipos marca «aplicable hoy».
 * El anticipo entra como un RENGLÓN MÁS del descuento de la factura (`[PGP.101]`, `discount_lines`),
 * con motivo `anticipo` y su documento (`{sucursal, folio}`): baja lo que sale del banco y la factura
 * queda cubierta igual que con cualquier descuento, sin tocar el tope del día ni el cruce con Kepler.
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────
 *  Amplía el CHECK `ck_pai_discount_reason` de `finance.payment_allocation_items` con `anticipo`.
 *  La columna agregada `discount_reason` guarda el motivo del renglón MAYOR (`[PGP.101]`): si el
 *  anticipo es el mayor, el CHECK de siempre lo rechazaría con un 500.
 *  Nada más: el documento del anticipo viaja dentro del renglón (`discount_lines`, jsonb ya existente).
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Sólo AMPLÍA lo permitido: la API desplegada nunca manda `anticipo`, y lo que ya está guardado
 *    cumple el CHECK nuevo (es un superconjunto del viejo).
 *  · ⛔ Va en prod ANTES del código: el código nuevo puede guardar `anticipo` y sin esta migración
 *    el CHECK viejo lo rechaza.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-13) ────────────────────────────────────────
 *  · CHECK vigente: `discount_reason = ANY (ARRAY['pronto_pago','volumen','otro'])`.
 *  · 690 renglones de pago (664 de Kepler), 4 con descuento: el CHECK nuevo se valida al instante.
 *  · 64 anticipos sin aplicar, ~$7.03 M; ~$2.02 M aplicables hoy contra facturas abiertas de su
 *    misma sucursal.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CHECK = 'ck_pai_discount_reason';
const NUEVO = `discount_reason IN ('pronto_pago','volumen','otro','anticipo')`;
const VIEJO = `discount_reason IN ('pronto_pago','volumen','otro')`;

async function definicion(knex) {
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = ? AND conrelid = 'finance.payment_allocation_items'::regclass`, [CHECK]);
  return rows[0]?.def ?? null;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const def = await definicion(knex);
  if (def && def.includes(`'anticipo'`)) return; // ya está
  await knex.raw(`ALTER TABLE finance.payment_allocation_items DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE finance.payment_allocation_items ADD CONSTRAINT ${CHECK} CHECK (${NUEVO})`);
  await knex.raw(`COMMENT ON CONSTRAINT ${CHECK} ON finance.payment_allocation_items IS '[PGP.120] Motivos del descuento al pagar; anticipo = un X-D-60 de Kepler aplicado contra la factura (su documento va en discount_lines).'`);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. ⛔ Si ya hay renglones con `anticipo`, se
 * niega: volver al CHECK viejo los dejaría inválidos y borrarlos sería borrar dinero programado.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [m] } = await knex.raw(
    `SELECT count(*)::int AS n FROM finance.payment_allocation_items WHERE discount_reason = 'anticipo'`);
  if (m.n > 0) throw new Error(`[PGP.120] ${m.n} renglón(es) con motivo anticipo: quítalos en el Calendario antes de deshacer.`);
  await knex.raw(`ALTER TABLE finance.payment_allocation_items DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE finance.payment_allocation_items ADD CONSTRAINT ${CHECK} CHECK (${VIEJO})`);
};
