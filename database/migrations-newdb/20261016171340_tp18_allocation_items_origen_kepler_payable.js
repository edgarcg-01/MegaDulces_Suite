'use strict';
/**
 * `[TP.18]` — **El CHECK de `obligation_source` admite el cuarto origen: `kepler_payable`** (ADR-094).
 *
 * El Calendario pasa a poder programar la deuda viva de Kepler que NO pasó por Entregas de
 * Compras (servicios, fletes, toda factura que nadie capturó). Ese origen **no tiene tabla propia**
 * —se deriva de `analytics.v_supplier_payables`— pero su renglón sí se guarda en
 * `finance.payment_allocation_items`, y el CHECK de esa tabla sólo listaba los tres de 2026-09.
 *
 * ── Lo medido antes (sólo lectura, 2026-10-16) ──────────────────────────────────────────────
 *  · Deuda de proveedor en Kepler: **2,960 docs · $136,322,731 · 377 proveedores**.
 *  · Lo que el Calendario podía programar: **37 obligaciones · $2,738,088** → **cobertura 2.0 %**.
 *  · El cuarto origen aporta **2,892 documentos · $133,209,074** (sin internos `TI*` y sin los 37
 *    que ya entraron por Entregas, que se deduplican por las cuatro llaves `kepler_*`).
 *
 * ⭐ **Lo encontró una prueba, no una revisión.** El `it.spec` de integración, corriendo el código
 * real contra un Postgres de verdad, falló con
 * `violates check constraint "payment_allocation_items_obligation_source_check"`. Sin esa prueba,
 * el origen nuevo habría llegado a producción listando facturas que **no se podían programar**:
 * el botón devolvería 500 y la pantalla se vería igual de sana. Es el mismo defecto que dejó el
 * arqueo de caja sin poder cerrarse 8 días (columna `NOT NULL` + un camino que nadie recorrió).
 *
 * ⚠️ **Sólo toca el CHECK**: ninguna fila existente cambia, y las 37 obligaciones capturadas
 * siguen entrando por `supplier_payable` exactamente igual.
 *
 * Idempotente: recrea la restricción sólo si no admite ya el valor nuevo.
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'finance.payment_allocation_items';
const NOMBRE = 'payment_allocation_items_obligation_source_check';
const ORIGENES_NUEVOS = ['budget_expense', 'financial_commitment', 'supplier_payable', 'kepler_payable'];
const ORIGENES_VIEJOS = ['budget_expense', 'financial_commitment', 'supplier_payable'];

const lista = (xs) => xs.map((x) => `'${x}'::text`).join(', ');

async function recrear(knex, origenes) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE ${TABLA} DROP CONSTRAINT IF EXISTS ${NOMBRE}`);
  await knex.raw(`ALTER TABLE ${TABLA} ADD CONSTRAINT ${NOMBRE}
    CHECK (obligation_source = ANY (ARRAY[${lista(origenes)}]))`);
}

exports.up = async function up(knex) {
  const [{ def }] = (await knex.raw(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = ?::regclass AND conname = ?`, [TABLA, NOMBRE],
  )).rows;
  if (def && def.includes('kepler_payable')) return;   // ya aplicada
  await recrear(knex, ORIGENES_NUEVOS);
};

/**
 * Deshace EXACTAMENTE lo que hizo el `up`: vuelve a los tres orígenes.
 * ⛔ Se niega si ya hay renglones del cuarto origen — bajar el CHECK con filas que lo violan
 * dejaría la tabla en un estado que ninguna inserción futura puede reparar.
 */
exports.down = async function down(knex) {
  const [{ n }] = (await knex.raw(
    `SELECT count(*)::int AS n FROM ${TABLA} WHERE obligation_source = 'kepler_payable'`,
  )).rows;
  if (n > 0) throw new Error(`[TP.18] No se puede revertir: hay ${n} renglón(es) con obligation_source='kepler_payable'. Reasignalos o cancelá esos pagos primero.`);
  await recrear(knex, ORIGENES_VIEJOS);
};
