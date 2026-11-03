'use strict';
/**
 * `[LE.2.9]` — **Una orden de pago se asienta como el gasto de su documento**, no como cajón.
 *
 * `20261102134515` (LE.1.14) dejó la clasificación de una orden en cajón, custodia o banco. Un pago
 * con código no es ninguna de las tres: el dinero sale de la bóveda directo al egreso del X-D-26
 * (`movimientoCaos` con `{ tipo: 'pago', concepto, documento }`, reglas.ts). Sin esto, una orden de
 * pago metía los billetes al cajón y el gasto quedaba por registrar aparte: pagar NO era registrar (V3).
 *
 *  · La clasificación acepta `pago`, y una de pago trae su `concepto` y su `documento`.
 *  · Una orden `kind = 'pago'` lleva clasificación `pago`, y su documento es el mismo `source_ref`.
 *
 * Sólo cambia reglas de una tabla nueva y vacía en prod (la migración anterior todavía no se aplica):
 * la API desplegada no la usa (expand/contract).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [h] } = await knex.raw(`SELECT to_regclass('cashbook.withdrawal_orders') IS NOT NULL AS hay`);
  if (!h.hay) throw new Error('[LE.2.9] falta la tabla de órdenes (20261102134515): se aplica después.');

  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  // El CHECK en línea de LE.1.14 se llama como lo nombra Postgres; se busca por su definición, no por adivinanza.
  const { rows: viejos } = await knex.raw(`
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'cashbook.withdrawal_orders'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%classification%' AND conname <> 'cashbook_orden_pago_clasificada'`);
  for (const r of viejos) await knex.raw('ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT ??', [r.conname]);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_clasificacion`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_clasificacion CHECK (
    classification->>'tipo' IN ('cajon','custodia','banco','pago')
    AND (classification->>'tipo' <> 'pago'
         OR (length(trim(coalesce(classification->>'concepto', ''))) > 0 AND length(trim(coalesce(classification->>'documento', ''))) > 0)))`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_pago_clasificada`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT cashbook_orden_pago_clasificada CHECK (
    (kind = 'pago') = (classification->>'tipo' = 'pago')
    AND (kind <> 'pago' OR classification->>'documento' = source_ref))`);
  await knex.raw(`RESET ROLE`);
};

/** Regresa a la regla de LE.1.14. Sólo si ninguna orden quedó clasificada como pago. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const { rows: [c] } = await knex.raw(`SELECT count(*)::int AS n FROM cashbook.withdrawal_orders WHERE classification->>'tipo' = 'pago'`);
  if (c.n > 0) throw new Error(`[LE.2.9] hay ${c.n} órdenes de pago: no se deshace.`);
  await knex.raw(`SET LOCAL ROLE cashbook_owner`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_pago_clasificada`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders DROP CONSTRAINT IF EXISTS cashbook_orden_clasificacion`);
  await knex.raw(`ALTER TABLE cashbook.withdrawal_orders ADD CONSTRAINT withdrawal_orders_classification_check
    CHECK (classification->>'tipo' IN ('cajon','custodia','banco'))`);
  await knex.raw(`RESET ROLE`);
};
