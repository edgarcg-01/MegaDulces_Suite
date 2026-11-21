'use strict';
/**
 * `[PGP.190]` — **Un pago que sale en varias transferencias se parte en varios pagos, y las partes se reconocen.**
 * Francisco, 2026-11-20: «hay pagos que se hacen con varias transferencias». Cada transferencia es un pago del
 * Calendario (su salida del banco, su comprobante y su X-D-26 en Kepler, como lo hace hoy Tesorería a mano); esta
 * columna sólo dice de qué pago salieron, para que el renglón diga «transferencia 1 de 2» y no parezcan dos pagos
 * sueltos al mismo proveedor. Plan: `docs/IMPLEMENTACION/FASES/FASE_PGP_ANEXO_VARIAS_TRANSFERENCIAS.md`.
 *
 *  · `finance.payment_allocations.split_from_id` — el pago original del que salió la parte (opcional). Todas las
 *    partes, la original incluida, llevan el id de la original: reprogramar una parte copia la columna y la parte
 *    movida sigue en su grupo aunque la original se cancele.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ──────────────────────────────────────────
 *  · Desde octubre, 8 de 179 pagos ejecutados del Calendario recibieron dos X-D-26 en Kepler; los 3 más grandes
 *    quedaron sin casar con el banco ni validar (la Suite buscaba UNA salida por el importe completo).
 *  · `finance.payment_allocations` no tiene columna `split_from_id`.
 *
 * Columna nula sin DEFAULT: `ADD COLUMN` es sólo metadatos y ningún camino de inserción cambia (regla 14: no hay NOT
 * NULL). La llave foránea a la misma tabla (ON DELETE SET NULL, como `reprogrammed_from_id`) y un índice parcial sólo
 * de las filas con parte (hoy cero).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const TAG = '[pgp190_pago_partido_en_transferencias]';
const FK = 'payment_allocations_split_from_id_fkey';
const IX = 'ix_payment_allocations_split_from';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasColumn('payment_allocations', 'split_from_id'))) {
    await knex.raw('ALTER TABLE finance.payment_allocations ADD COLUMN split_from_id uuid');
    console.log(`${TAG} + finance.payment_allocations.split_from_id`);
  }
  const { rows: fk } = await knex.raw(`SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'finance.payment_allocations'::regclass`, [FK]);
  if (!fk.length) {
    await knex.raw(`ALTER TABLE finance.payment_allocations ADD CONSTRAINT ${FK}
                      FOREIGN KEY (split_from_id) REFERENCES finance.payment_allocations(id) ON DELETE SET NULL`);
    console.log(`${TAG} + ${FK}`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ${IX} ON finance.payment_allocations (tenant_id, split_from_id) WHERE split_from_id IS NOT NULL`);
  await knex.raw(`COMMENT ON COLUMN finance.payment_allocations.split_from_id IS '[PGP.190] el pago original del que salió esta transferencia (todas las partes, la original incluida); null = pago sin partir'`);
  const { rows: [{ n }] } = await knex.raw('SELECT count(*)::int AS n FROM finance.payment_allocations WHERE split_from_id IS NOT NULL');
  console.log(`${TAG} pagos partidos hoy: ${n}`);
};

/**
 * Quita el índice y la llave y DEJA la columna: qué pago salió de cuál lo escribió una persona al partirlo, y un
 * `down` no lo tira (mismo criterio que G.6, S.13 y S.17). Re-aplicar el `up` la encuentra y vuelve a ponerlos.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP INDEX IF EXISTS finance.${IX}`);
  await knex.raw(`ALTER TABLE finance.payment_allocations DROP CONSTRAINT IF EXISTS ${FK}`);
};
