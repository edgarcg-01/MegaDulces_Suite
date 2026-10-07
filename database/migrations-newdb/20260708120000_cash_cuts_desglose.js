/**
 * SM.7 — Desglose completo del corte de caja (Supervisor de Movimientos).
 *
 * Enriquece analytics.cash_cuts con la composición que descifré en vivo contra
 * md.kdpv_folio_caja (686 cortes reales, md_03, 2026-07-08):
 *   - tarjeta_diff / transfer_diff (c36/c37): descuadres NO-efectivo, hoy invisibles.
 *   - arqueo_billetes/monedas/otros (c43/c44/c45): desglose físico del conteo.
 *   - efectivo_retirado (c48): efectivo entregado/retirado a bóveda (≈ contado).
 *   - venta_total: venta REAL del turno = c15+c16+c17 (efectivo+tarjeta+transf esperados).
 *     Reemplaza el uso de `total_venta` (=c49≈c15, solo efectivo → subestimaba la venta).
 *
 * Aditiva + idempotente (hasColumn). analytics.* sin RLS.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (!(await knex.schema.withSchema('analytics').hasTable('cash_cuts'))) return;
  const add = async (col, type) => {
    if (!(await knex.schema.withSchema('analytics').hasColumn('cash_cuts', col))) {
      await knex.raw(`ALTER TABLE analytics.cash_cuts ADD COLUMN ${col} ${type}`);
    }
  };
  await add('tarjeta_diff', 'numeric NOT NULL DEFAULT 0');      // c36
  await add('transfer_diff', 'numeric NOT NULL DEFAULT 0');     // c37
  await add('arqueo_billetes', 'numeric NOT NULL DEFAULT 0');   // c43
  await add('arqueo_monedas', 'numeric NOT NULL DEFAULT 0');    // c44
  await add('arqueo_otros', 'numeric NOT NULL DEFAULT 0');      // c45 (vales/otros)
  await add('efectivo_retirado', 'numeric NOT NULL DEFAULT 0'); // c48
  await add('venta_total', 'numeric NOT NULL DEFAULT 0');       // c15+c16+c17 (venta real del turno)
  // Backfill venta_total desde lo ya cargado (esperados de las 3 formas).
  await knex.raw(`UPDATE analytics.cash_cuts
                    SET venta_total = COALESCE(efectivo_esperado,0)+COALESCE(tarjeta_esperado,0)+COALESCE(transfer_esperado,0)
                  WHERE venta_total = 0`);
};

exports.down = async function () { /* aditiva; no drop */ };
