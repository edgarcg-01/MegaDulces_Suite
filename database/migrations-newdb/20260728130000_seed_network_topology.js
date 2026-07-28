/**
 * RA-PRO.17.2 — Seed de la topología de red (DRP) para Mega Dulces.
 *
 * Derivado de la EVIDENCIA real (analytics.transfers_monthly, kind='salida_cedis'):
 * el almacén '00' (Cedis Oficinas) surte a las 8 sucursales con stock —
 *   Morelia Abastos=MD-30, Canindo=MD-50, Morelia Madero=MD-32,
 *   Padre Hidalgo=01, La Piedad Abastos=02, 8 Esquinas=03, Yurécuaro=04, Zamora=05
 * — más las rutas (que NO tienen stock → no son destino de traspaso).
 *
 * Setea warehouses.source_warehouse_id = <id de '00'> SOLO donde está NULL (no pisa
 * ediciones manuales de la UI /compras/red). Idempotente y defensivo: si el tenant no
 * tiene un almacén '00' (p.ej. dev con otros códigos), no hace nada.
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const BRANCHES = ['01', '02', '03', '04', '05', 'MD-30', 'MD-32', 'MD-50'];

exports.up = async function (knex) {
  const cedis = await knex('commercial.warehouses')
    .where({ tenant_id: MEGA, code: '00' }).whereNull('deleted_at').first('id');
  if (!cedis) return; // sin CEDIS '00' (dev / otro tenant) → no-op

  await knex('commercial.warehouses')
    .where({ tenant_id: MEGA })
    .whereIn('code', BRANCHES)
    .whereNull('source_warehouse_id')
    .whereNull('deleted_at')
    .update({ source_warehouse_id: cedis.id });
};

exports.down = async function (knex) {
  // Revierte solo lo que este seed pudo poner (sucursales → '00'); deja intactas
  // otras topologías. No-op si no hay CEDIS.
  const cedis = await knex('commercial.warehouses')
    .where({ tenant_id: MEGA, code: '00' }).first('id');
  if (!cedis) return;
  await knex('commercial.warehouses')
    .where({ tenant_id: MEGA, source_warehouse_id: cedis.id })
    .whereIn('code', BRANCHES)
    .update({ source_warehouse_id: null });
};
