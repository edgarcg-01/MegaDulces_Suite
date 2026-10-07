/**
 * RA.15.1 — Auto-received: origen de la Orden de Entrada (OE) + idempotencia.
 *
 * Distingue la recepción MANUAL (capturada en la plataforma → mueve stock, overlay
 * optimista) de la AUTO reconciliada desde Kepler (`import-auto-received.js` detecta la
 * orden de entrada X-A-40 → cierra nuestra OC SIN mover stock, porque esa existencia YA
 * está en el snapshot nocturno de Kepler → evita doble-conteo).
 *
 *   goods_receipts.source            = 'manual' (default) | 'kepler'
 *   goods_receipts.source_kepler_folio = folio del X-A-40 matcheado (traza + dedup)
 *   índice único parcial (tenant, purchase_order_id, source_kepler_folio) → idempotente:
 *     una entrada de Kepler se concilia una sola vez contra la misma OC.
 *
 * Idempotente (hasColumn). @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (t, c) => knex.schema.withSchema('commercial').hasColumn(t, c);
  if (!(await has('goods_receipts', 'source'))) {
    await knex.raw(`ALTER TABLE commercial.goods_receipts ADD COLUMN source varchar(8) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','kepler'))`);
    await knex.raw(`COMMENT ON COLUMN commercial.goods_receipts.source IS 'RA.15.1 — manual (capturada, mueve stock) | kepler (auto-conciliada del X-A-40, stock_applied=false porque el snapshot ya la trae).'`);
  }
  if (!(await has('goods_receipts', 'source_kepler_folio'))) {
    await knex.raw(`ALTER TABLE commercial.goods_receipts ADD COLUMN source_kepler_folio text`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_gr_kepler_folio
    ON commercial.goods_receipts (tenant_id, purchase_order_id, source_kepler_folio)
    WHERE source_kepler_folio IS NOT NULL`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_gr_kepler_folio`);
  for (const c of ['source_kepler_folio', 'source']) {
    if (await knex.schema.withSchema('commercial').hasColumn('goods_receipts', c)) {
      await knex.raw(`ALTER TABLE commercial.goods_receipts DROP COLUMN ${c}`);
    }
  }
};
