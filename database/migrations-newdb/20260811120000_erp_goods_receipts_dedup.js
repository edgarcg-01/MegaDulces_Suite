/**
 * RE.12 — Dedup de órdenes de entrada duplicadas (sucursal ↔ CEDIS 9.95 / '00').
 *
 * Una recepción en sucursal genera su "Aplica Orden Entrada" (CON las líneas/productos)
 * y CEDIS ('00', md_00) crea un ESPEJO del mismo documento → dos filas, dos pólizas. Para
 * no pedir evidencia dos veces, se marca la fila CEDIS como DUPLICADA de la CANÓNICA
 * (siempre la de sucursal, que contiene los productos solicitados): `dup_of_sucursal` /
 * `dup_of_folio` apuntan a la canónica. NULL = canónica / independiente.
 *
 * Lo puebla `database/importers/kepler/detect-goods-receipt-duplicates.js` por
 * (proveedor_rfc + receipt_date + monto). Las listas ocultan las duplicadas (evidencia
 * una sola vez) y la vista de la canónica muestra su espejo CEDIS.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (c) => knex.schema.withSchema('analytics').hasColumn('erp_goods_receipts', c);
  if (!(await has('dup_of_sucursal'))) {
    await knex.raw(`ALTER TABLE analytics.erp_goods_receipts ADD COLUMN dup_of_sucursal text`);
  }
  if (!(await has('dup_of_folio'))) {
    await knex.raw(`ALTER TABLE analytics.erp_goods_receipts ADD COLUMN dup_of_folio text`);
  }
  // Índice parcial: localizar los espejos que apuntan a una canónica (dup_of_* NOT NULL).
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS ix_erpgr_dup ON analytics.erp_goods_receipts
       (tenant_id, dup_of_sucursal, dup_of_folio) WHERE dup_of_folio IS NOT NULL`,
  );
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_erpgr_dup`);
  await knex.raw(`ALTER TABLE analytics.erp_goods_receipts DROP COLUMN IF EXISTS dup_of_folio`);
  await knex.raw(`ALTER TABLE analytics.erp_goods_receipts DROP COLUMN IF EXISTS dup_of_sucursal`);
};
