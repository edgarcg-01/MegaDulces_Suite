/**
 * RE.10 — Procedencia de la clasificación del ajuste de compra (`c24`).
 *
 * `categoria` la asigna el importer por keyword. El tail (motivos tersos = 'otro',
 * o X-D-55 con motivo en blanco) se enriquece aparte (LLM Haiku / default por doctype).
 * Esta columna marca de dónde salió la clasificación para que el importer NO pise el
 * enriquecimiento al re-importar y para poder auditar/filtrar:
 *   'keyword'         = regla del importer
 *   'llm'             = Haiku clasificó el motivo terso
 *   'doctype_default' = inferido del doctype (X-D-55 en blanco → comercial)
 *   NULL              = sin clasificar aún
 *
 * Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasColumn('erp_purchase_adjustments', 'categoria_source');
  if (!has) {
    await knex.raw(`ALTER TABLE analytics.erp_purchase_adjustments ADD COLUMN categoria_source text`);
    await knex.raw(`COMMENT ON COLUMN analytics.erp_purchase_adjustments.categoria_source IS 'RE.10 — procedencia de categoria: keyword | llm | doctype_default | NULL. El importer preserva llm/doctype_default.'`);
    // backfill: lo ya clasificado con motivo real = keyword (no toca 'otro' ni NULL).
    await knex.raw(`UPDATE analytics.erp_purchase_adjustments SET categoria_source = 'keyword' WHERE categoria IS NOT NULL AND categoria <> 'otro'`);
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.withSchema('analytics').hasColumn('erp_purchase_adjustments', 'categoria_source');
  if (has) await knex.raw(`ALTER TABLE analytics.erp_purchase_adjustments DROP COLUMN categoria_source`);
};
