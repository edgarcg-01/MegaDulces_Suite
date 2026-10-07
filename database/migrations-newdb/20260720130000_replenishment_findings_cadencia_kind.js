/**
 * RA-PRO.8.4 — Detector de "surtido lento": suma el tipo de hallazgo `cadencia_lenta`
 * (SKU que rota pero cuyo proveedor se pide con cadencia > umbral → riesgo estructural
 * de quiebre) al CHECK de commercial.replenishment_findings.kind. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.replenishment_findings DROP CONSTRAINT IF EXISTS replenishment_findings_kind_check`);
  await knex.raw(`ALTER TABLE commercial.replenishment_findings ADD CONSTRAINT replenishment_findings_kind_check CHECK (kind IN ('agotado_abc','bajo_reorden','cadencia_lenta'))`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.replenishment_findings DROP CONSTRAINT IF EXISTS replenishment_findings_kind_check`);
  await knex.raw(`ALTER TABLE commercial.replenishment_findings ADD CONSTRAINT replenishment_findings_kind_check CHECK (kind IN ('agotado_abc','bajo_reorden'))`);
};
