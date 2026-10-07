/**
 * RE.10 — Descuento capturado en el PAGO a proveedor (kdm1.c84) → espejo.
 *
 * `analytics.erp_supplier_payments` ya refleja XD25/26/60 (monto = c16). Falta el
 * SEGUNDO canal de descuento: el pronto pago / comercial que se materializa AL PAGAR,
 * en el campo `c84` del pago (verificado 2026: 43.4% de los pagos de compra lo capturan,
 * Σ ≈ $12.6M; 69.8% de ellos exactamente 7.41% del monto pagado). Se suma al canal de
 * las notas de crédito (X-D-55) para ver el descuento TOTAL por proveedor.
 *
 * Aditiva + idempotente. analytics.* sin RLS (filtro tenant explícito) — solo columna.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasColumn('erp_supplier_payments', 'descuento');
  if (!has) {
    await knex.raw(`ALTER TABLE analytics.erp_supplier_payments ADD COLUMN descuento numeric NOT NULL DEFAULT 0`);
    await knex.raw(`COMMENT ON COLUMN analytics.erp_supplier_payments.descuento IS 'kdm1.c84 — descuento capturado al pagar (pronto pago/comercial), sobre el monto pagado. 2º canal de descuento junto a las notas X-D-55.'`);
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasColumn('erp_supplier_payments', 'descuento');
  if (has) await knex.raw(`ALTER TABLE analytics.erp_supplier_payments DROP COLUMN descuento`);
};
