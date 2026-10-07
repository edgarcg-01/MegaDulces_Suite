/**
 * CC ext (auditoría) — Detalle por LÍNEA de las órdenes de entrada (X-A-40).
 *
 * El espejo `analytics.erp_goods_receipts` es por documento (encabezado). Para
 * auditar la recepción renglón por renglón (¿qué SKU, cuánta cantidad, a qué costo
 * unitario entró?) se agregan las líneas del documento desde `md.kdm2` de Kepler:
 *   c7=nº de línea, c8=SKU, c10=nombre, c9=cantidad, c11=unidad, c12=costo unitario,
 *   c13=importe de línea. Enlaza al encabezado por (c1,c2,c3,c4,c6).
 *
 * analytics.* (sin RLS, filtro tenant explícito) + GRANT SELECT. Lo puebla el mismo
 * importer que el encabezado (import-goods-receipts.js). Read-only sobre Kepler.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('erp_goods_receipt_lines'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_goods_receipt_lines (
        tenant_id       uuid NOT NULL,
        sucursal        text NOT NULL,            -- kdm1.c1 (00 = CEDIS)
        folio           text NOT NULL,            -- orden de entrada kdm1.c6 (X-A-40)
        linea           text NOT NULL,            -- kdm2.c7 (nº de línea)
        sku             text,                     -- kdm2.c8 (código interno Kepler)
        nombre          text,                     -- kdm2.c10 (descripción del producto)
        cantidad        numeric NOT NULL DEFAULT 0,  -- kdm2.c9
        unidad          text,                     -- kdm2.c11 (PZA/PAQ/CJA/SER…)
        costo_unitario  numeric NOT NULL DEFAULT 0,  -- kdm2.c12
        importe         numeric NOT NULL DEFAULT 0,  -- kdm2.c13 (cantidad × costo)
        computed_at     timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, folio, linea)
      )`);
    await knex.raw(`CREATE INDEX ix_erpgrl_entrada ON analytics.erp_goods_receipt_lines (tenant_id, sucursal, folio)`);
    await knex.raw(`CREATE INDEX ix_erpgrl_sku ON analytics.erp_goods_receipt_lines (tenant_id, sku)`);
    await knex.raw(`GRANT SELECT ON analytics.erp_goods_receipt_lines TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_goods_receipt_lines');
};
