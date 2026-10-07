/**
 * CS.3.13 — `finance.cash_ledger.venta_credito`: la parte del movimiento que quedó A CRÉDITO.
 *
 * Cuando la ruta entrega su efectivo a Caja General, la venta a un cliente de crédito NO llegó en
 * efectivo — quedó como saldo del cliente. Ese monto se DESCUENTA del efectivo esperado:
 *   efectivo esperado = documento − venta_credito.
 * El `monto` del movimiento sigue siendo el EFECTIVO (el arqueo); `venta_credito` es la parte a
 * crédito, registrada aparte para que quede el rastro (y para no contarla como efectivo que no entró).
 *
 * Se auto-rellena cuando el cliente del cobro es de crédito (`kepler_ods.kdud`: días `c16` o límite
 * `c15` > 0), pero SIEMPRE queda editable (decisión del usuario 2026-09-28).
 *
 * Aditiva e idempotente. `>= 0` por CHECK: un crédito negativo no existe.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hay = await knex.schema.withSchema('finance').hasColumn('cash_ledger', 'venta_credito');
  if (!hay) {
    await knex.raw(`ALTER TABLE finance.cash_ledger ADD COLUMN venta_credito numeric(18,2) NOT NULL DEFAULT 0`);
    await knex.raw(`ALTER TABLE finance.cash_ledger ADD CONSTRAINT cash_ledger_venta_credito_chk CHECK (venta_credito >= 0)`);
    await knex.raw(`COMMENT ON COLUMN finance.cash_ledger.venta_credito IS
      'CS.3.13 — parte del movimiento que quedo a credito (no llego en efectivo). efectivo esperado = documento - venta_credito. El monto sigue siendo el efectivo (arqueo).'`);
  }

  // CS.3.13 — La condición de crédito del cliente, DERIVADA del ODS (no copia): un cliente es de
  // crédito si tiene días (`kdud.c16`) o límite (`kdud.c15`) > 0. La bandeja la usa para auto-rellenar
  // «venta a crédito». Guard: en entornos sin el ODS (dev), no se crea y el servicio degrada.
  const kdud = await knex.raw(`SELECT to_regclass('kepler_ods.kdud') AS t`);
  if (kdud.rows?.[0]?.t) {
    await knex.raw(`
      CREATE OR REPLACE VIEW analytics.v_cliente_credito AS
      SELECT sucursal,
             c2 AS cliente_code,
             COALESCE(NULLIF(c15::text, '')::numeric, 0) AS limite,
             COALESCE(NULLIF(c16::text, '')::numeric, 0) AS dias,
             (COALESCE(NULLIF(c15::text, '')::numeric, 0) > 0
              OR COALESCE(NULLIF(c16::text, '')::numeric, 0) > 0) AS es_credito
        FROM kepler_ods.kdud`);
    await knex.raw(`GRANT SELECT ON analytics.v_cliente_credito TO app_runtime`);
    await knex.raw(`COMMENT ON VIEW analytics.v_cliente_credito IS
      'CS.3.13 — condicion de credito del cliente (kdud.c15 limite / c16 dias > 0), derivada del ODS. La bandeja de caja la usa para auto-rellenar venta a credito.'`);
  }
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_cliente_credito`);
  await knex.raw(`ALTER TABLE finance.cash_ledger DROP CONSTRAINT IF EXISTS cash_ledger_venta_credito_chk`);
  const hay = await knex.schema.withSchema('finance').hasColumn('cash_ledger', 'venta_credito');
  if (hay) await knex.raw(`ALTER TABLE finance.cash_ledger DROP COLUMN venta_credito`);
};
