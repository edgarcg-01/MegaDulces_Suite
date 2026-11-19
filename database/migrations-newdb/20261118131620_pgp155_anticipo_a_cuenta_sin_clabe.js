'use strict';
/**
 * `[PGP.155]` — **El anticipo se puede pagar a una cuenta del mismo banco, sin CLABE.**
 *
 * Francisco (2026-11-18): VUMERSOFT cobra por transferencia entre cuentas del mismo banco (BBVA), con el
 * número de cuenta, no con una CLABE. El anticipo sólo guardaba `payee_clabe` (`[PGP.127]`): con una
 * cuenta sin CLABE quedaba en NULL, y NULL en esa columna significa «se paga en efectivo». La Suite lo
 * habría dicho en efectivo, y al preparar el pago no habría podido comprobar que sale a ESA cuenta.
 *
 * ── Qué agrega (sólo una columna NULA en `commercial.supplier_payment_obligations`) ────────────
 *  · `payee_account_number` — el número de cuenta (sólo dígitos) al que se paga el anticipo cuando la
 *    cuenta no tiene CLABE. Igual que `payee_clabe`, su estado (aprobada / espera aprobación) se DERIVA
 *    al leer del catálogo de cuentas y sus solicitudes: no se guarda aquí.
 *  · Un CHECK de FORMA: de 7 a 14 dígitos (la CLABE, 18, va en `payee_clabe`), y nunca las dos a la vez:
 *    un anticipo se paga a UNA cuenta.
 *
 * ── Por qué no rompe nada (regla 14) ────────────────────────────────────────────────────────
 *  · Los caminos que insertan aquí (entrega aceptada `[TP.15]` y su backfill, alta manual, «programar
 *    documento de Kepler», pedir anticipo) siguen funcionando: la columna es nula. Sólo `crearAnticipo`
 *    la escribe.
 *  · Compatible con la API desplegada: no la lee ni la escribe. La API nueva la lee con
 *    `to_jsonb(o) ->> 'payee_account_number'`, así que tampoco truena si llega antes que esta migración.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-11-18) ────────────────────────────────────────
 *  · 1 cuenta activa en el catálogo de cuentas de proveedor: VUMERSOFT (`CD004`), BBVA, número de cuenta
 *    de 10 dígitos, SIN CLABE. 0 con CLABE.
 *  · 0 anticipos pedidos en la Suite.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'supplier_payment_obligations';
const COL = 'payee_account_number';
const CK = 'ck_spo_payee_account_number';

async function existe(knex, nombre) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = 'commercial.supplier_payment_obligations'::regclass`, [nombre]);
  return rows.length > 0;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⚠️ `withSchema(...).hasColumn`: `hasColumn('commercial.x', ...)` devuelve false SIEMPRE.
  if (!(await knex.schema.withSchema('commercial').hasColumn(TABLA, COL))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD COLUMN ${COL} text`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.${TABLA}.${COL} IS '[PGP.155] El numero de cuenta (solo digitos, mismo banco) al que se paga el anticipo cuando la cuenta no tiene CLABE. NULL con payee_clabe NULL = efectivo.'`);
  if (!(await existe(knex, CK))) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} ADD CONSTRAINT ${CK} CHECK (
      ${COL} IS NULL OR (${COL} ~ '^[0-9]{7,14}$' AND payee_clabe IS NULL))`);
  }
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. ⛔ Si ya hay anticipos con número de cuenta,
 * se niega: quitar la columna los dejaría «en efectivo».
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (await knex.schema.withSchema('commercial').hasColumn(TABLA, COL)) {
    const { rows: [m] } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.${TABLA} WHERE ${COL} IS NOT NULL`);
    if (m.n > 0) throw new Error(`[PGP.155] ${m.n} anticipo(s) a una cuenta sin CLABE: no se deshace sin dejarlos «en efectivo».`);
  }
  await knex.raw(`ALTER TABLE commercial.${TABLA} DROP CONSTRAINT IF EXISTS ${CK}`);
  if (await knex.schema.withSchema('commercial').hasColumn(TABLA, COL)) {
    await knex.raw(`ALTER TABLE commercial.${TABLA} DROP COLUMN ${COL}`);
  }
};
