/**
 * CB.5 — Afinar el catálogo de conciliación bancaria: 3 categorías nuevas para los
 * patrones que caían en `sin_clasificar` (analizado sobre enero 2026):
 *   - compra_tarjeta  = "COMPRA - DISPOSICION POR POS" (compras con tarjeta/TPV) — el bucket grande.
 *   - servicios       = DOMICILIACION / CFE / luz / agua / teléfono.
 *   - impuestos       = pagos SAT / ISR / IVA por pagar.
 * Idempotente (ON CONFLICT DO NOTHING). Seed vía SET LOCAL app.tenant_id.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

const NEW_CATS = [
  // code, name, flow, kepler_account, group_key, note, sort_order
  ['compra_tarjeta', 'Compra con tarjeta / TPV', 'out', '608', 'gasto', 'Disposición por POS con tarjeta de la empresa (naturaleza fina desconocida)', 125],
  ['servicios',      'Servicios (luz/agua/tel)', 'out', '603', 'gasto', 'CFE, agua, teléfono, domiciliaciones de servicio', 105],
  ['impuestos',      'Impuestos / SAT',          'out', '761', 'gasto', 'Pagos al SAT: ISR, IVA por pagar, derechos', 165],
];

exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('finance').hasTable('movement_categories'))) return;
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
  for (const [code, name, flow, kepler, group, note, sort] of NEW_CATS) {
    await knex.raw(
      `INSERT INTO finance.movement_categories (tenant_id, code, name, flow, kepler_account, group_key, kepler_note, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [MEGA, code, name, flow, kepler, group, note, sort],
    );
  }
};

exports.down = async function (knex) {
  await knex.raw(`DELETE FROM finance.movement_categories WHERE code IN ('compra_tarjeta','servicios','impuestos')`);
};
