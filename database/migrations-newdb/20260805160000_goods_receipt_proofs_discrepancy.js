/**
 * RE.2 — Persistir el descuadre calculado de la recepción en la evidencia.
 *
 * `finance.goods_receipt_proofs` guarda la remisión/factura del proveedor + su OCR.
 * El auto-explain (endpoint `/for-entrada`) hoy resuelve el porqué del descuadre EN
 * VIVO pero no lo guarda. Estas dos columnas persisten el veredicto para que la
 * evidencia quede autocontenida y se pueda filtrar/reportar:
 *   - `discrepancy_kind`   = clasificación del descuadre factura-vs-recepción
 *   - `discrepancy_amount` = |total factura/remisión − valor de la entrada| ($)
 *
 * Ambas nullable (una evidencia sin clasificar aún = NULL). Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = (col) => knex.schema.withSchema('finance').hasColumn('goods_receipt_proofs', col);

  if (!(await has('discrepancy_kind'))) {
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs ADD COLUMN discrepancy_kind text`);
    await knex.raw(`
      ALTER TABLE finance.goods_receipt_proofs
        ADD CONSTRAINT chk_grp_discrepancy_kind
        CHECK (discrepancy_kind IS NULL OR discrepancy_kind IN
          ('cuadra','iva','typo','faltante','devolucion','descuento','duplicada','explicado','otro'))`);
    await knex.raw(`COMMENT ON COLUMN finance.goods_receipt_proofs.discrepancy_kind IS 'RE.2 — clasificación del descuadre factura-vs-recepción: cuadra/iva/typo/faltante/devolucion/descuento/duplicada/explicado/otro (NULL = sin clasificar).'`);
  }

  if (!(await has('discrepancy_amount'))) {
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs ADD COLUMN discrepancy_amount numeric`);
    await knex.raw(`COMMENT ON COLUMN finance.goods_receipt_proofs.discrepancy_amount IS 'RE.2 — |total factura/remisión − valor de la entrada| en $ (NULL = no calculado).'`);
  }
};

exports.down = async function (knex) {
  const has = (col) => knex.schema.withSchema('finance').hasColumn('goods_receipt_proofs', col);
  if (await has('discrepancy_kind')) {
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs DROP CONSTRAINT IF EXISTS chk_grp_discrepancy_kind`);
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs DROP COLUMN discrepancy_kind`);
  }
  if (await has('discrepancy_amount')) {
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs DROP COLUMN discrepancy_amount`);
  }
};
