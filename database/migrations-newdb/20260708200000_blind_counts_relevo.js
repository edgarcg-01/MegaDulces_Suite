/**
 * SM.8 / P2 — Arqueo de relevo en cambio de turno.
 *
 * El 82% de los cortes cambian de manos (abre≠cierra) y concentran $320k del
 * faltante: la responsabilidad se diluye. El relevo = un arqueo ciego en el
 * momento del handoff que fija cuánto entregó el cajero SALIENTE al ENTRANTE.
 *
 * Extiende reconciliation.blind_counts con:
 *   - tipo: 'cierre' (default, corte del día) | 'relevo' (cambio de turno).
 *   - cajero_entrante: quién recibe la caja (el saliente = cajero_code).
 * Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('reconciliation').hasTable('blind_counts'))) return;
  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'tipo'))) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts ADD COLUMN tipo text NOT NULL DEFAULT 'cierre' CHECK (tipo IN ('cierre','relevo'))`);
  }
  if (!(await knex.schema.withSchema('reconciliation').hasColumn('blind_counts', 'cajero_entrante'))) {
    await knex.raw(`ALTER TABLE reconciliation.blind_counts ADD COLUMN cajero_entrante text`);
  }
  // Un arqueo por caja/día/cajero/TIPO (cierre y relevo pueden coexistir).
  await knex.raw(`DROP INDEX IF EXISTS reconciliation.uq_blind_count`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_blind_count ON reconciliation.blind_counts (tenant_id, warehouse_code, caja, business_date, COALESCE(cajero_code,''), tipo)`);
};

exports.down = async function () { /* aditiva; no drop */ };
