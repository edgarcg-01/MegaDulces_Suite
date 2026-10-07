'use strict';
/**
 * `[VTK.2]` — `commercial.order_lines.erp_gross_total`: el total del renglón tal como lo cobra
 * Kepler (con impuestos, ANTES del descuento manual), cuando el renglón se tarificó con el motor
 * de precios de cotizaciones.
 *
 * ── Por qué hace falta una columna y no basta `unit_price` ───────────────────────────────────
 * El precio del ERP YA TRAE impuestos y el pedido guarda `unit_price` SIN impuesto, por pieza,
 * con 4 decimales; `recalcOrderTotals` vuelve a calcular cada renglón como
 * `quantity × unit_price × (1 + tax)`. Ese ida-y-vuelta pierde centavos: 1 paquete de 42029 a
 * $131.99 queda en 11.3784/pza × 10 × 1.16 = **$131.98**. En una venta en firme el total tiene que
 * ser el de Kepler al centavo, así que se guarda y `recalcOrderTotals` lo respeta.
 *
 * NULL = el renglón se tarificó con el cálculo anterior (`resolvePriceForQty`) o el motor no pudo:
 * se comporta exactamente como antes.
 *
 * Idempotente. ⚠️ Desplegar ANTES que el código que la escribe.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('commercial').hasColumn('order_lines', 'erp_gross_total'))) {
    await knex.raw(`ALTER TABLE commercial.order_lines ADD COLUMN erp_gross_total numeric(14,2)`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.order_lines.erp_gross_total IS
    'VTK.2 — total del renglón como lo cobra Kepler (con impuestos, antes del descuento manual), del motor de precios de cotizaciones. recalcOrderTotals lo respeta para no perder centavos. NULL = cálculo anterior.'`);
};

exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE commercial.order_lines DROP COLUMN IF EXISTS erp_gross_total`);
};
