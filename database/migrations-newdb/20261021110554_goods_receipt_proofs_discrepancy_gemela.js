'use strict';
/**
 * `[RE.45]` — El CHECK de `discrepancy_kind` no admitía `'gemela'`, y `attach` lo escribe.
 *
 * `[RE.14.3]` clasifica como `gemela` el descuadre de una factura que cuadra con la captura de
 * OFICINAS y no con la de la sucursal (`goods-receipt-proofs.service.ts`, `attach`). Pero el CHECK
 * `chk_grp_discrepancy_kind` (migración `20260805160000`, RE.2) nació antes con una lista cerrada que
 * no lo incluye: ese INSERT viola la restricción y el capturista recibe un **500** — justo en el
 * caso que RE.14.3 existe para resolver.
 *
 * ── Lo medido antes (sólo lectura, prod, 2026-10-21) ────────────────────────────────────────
 *  · `pg_get_constraintdef`: la lista es cuadra/iva/typo/faltante/devolucion/descuento/duplicada/
 *    explicado/otro — sin `gemela`.
 *  · Filas con `discrepancy_kind = 'gemela'`: **0** (no puede haber: la restricción las rechaza).
 *  · Pares vigentes (`auto`) con montos distintos entre sucursal y oficinas: **9**, y **0**
 *    evidencias subidas en esas entradas. O sea: falla latente, todavía sin víctima registrada en
 *    los logs de la API que quedan (0 menciones de la restricción).
 *
 * Sólo AMPLÍA la lista: ninguna fila existente cambia ni puede dejar de cumplir. Idempotente: si la
 * restricción ya admite `gemela`, no toca nada.
 *
 * ⚠️ Si sólo hace GRANT/UPDATE/INSERT y no crea ningún objeto de esquema, la compuerta del
 *    despliegue la clasifica NO_MEDIDO y FRENA a todo el equipo hasta que alguien la aplique a
 *    mano. Aplicala ANTES de mergear.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'finance.goods_receipt_proofs';
const NOMBRE = 'chk_grp_discrepancy_kind';
const ANTES = ['cuadra', 'iva', 'typo', 'faltante', 'devolucion', 'descuento', 'duplicada', 'explicado', 'otro'];
const DESPUES = [...ANTES, 'gemela'];

const lista = (xs) => xs.map((x) => `'${x}'`).join(',');

async function definicion(knex) {
  const r = await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ?::regclass AND conname = ?`, [TABLA, NOMBRE]);
  return r.rows?.[0]?.def ?? null;
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const def = await definicion(knex);
  if (def && def.includes(`'gemela'`)) return; // ya aplicada
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${NOMBRE}`);
  await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT ${NOMBRE}
    CHECK (discrepancy_kind IS NULL OR discrepancy_kind IN (${lista(DESPUES)}))`);
  await knex.raw(`COMMENT ON COLUMN ${TABLA}.discrepancy_kind IS
    'RE.2 — clasificación del descuadre factura-vs-recepción: ${DESPUES.join('/')} (NULL = sin clasificar). gemela = RE.14.3, cuadra con la captura de oficinas (RE.45).'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const n = await knex.raw(`SELECT count(*)::int AS n FROM ${TABLA} WHERE discrepancy_kind = 'gemela'`);
  if (n.rows[0].n > 0) {
    // Volver a la lista vieja dejaría filas que no la cumplen. No se borran datos para bajar.
    throw new Error(`[RE.45] down: hay ${n.rows[0].n} evidencia(s) con discrepancy_kind='gemela'; no se puede volver a la lista anterior sin perderlas.`);
  }
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${NOMBRE}`);
  await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT ${NOMBRE}
    CHECK (discrepancy_kind IS NULL OR discrepancy_kind IN (${lista(ANTES)}))`);
};
