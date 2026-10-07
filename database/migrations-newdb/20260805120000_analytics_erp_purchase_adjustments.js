/**
 * Fase RE — Espejo de AJUSTES DE COMPRA de Kepler (X-D-40 + X-D-55).
 *
 * El descuadre "Factura vs Compra" y los descuentos de proveedor NO se adivinan:
 * Kepler los registra en dos doctypes, ambos con el MOTIVO en texto libre (`c24`),
 * ligados a la recepción (por factura `c11` / proveedor). Verificado con 3 PDFs +
 * ~12 sondeos (2026-08-05):
 *   - `X-D-40` "Devolución compra"  (132/2026, $563k)  = OPERACIONAL: faltante /
 *     no-solicitado / mal-estado / llegó-cambiada. Sin IVA.
 *   - `X-D-55` "Nota crédito"       (1,154/2026, $20.3M) = mayormente COMERCIAL:
 *     descuento / pronto pago / apoyo de marca / plan. Con IVA (`c82`).
 * ⚠️ El doctype NO es el clasificador — hay X-D-55 operacionales ("bolsa mal estado").
 *    La causa se lee del `c24` (importer clasifica por keyword; Haiku para los tersos).
 *
 * analytics.* = sin RLS, filtro tenant explícito + GRANT SELECT (patrón de
 * `erp_goods_receipts`). Lo puebla `import-purchase-adjustments.js`. Read-only sobre
 * Kepler. PK incluye `doctype` porque el folio NO es único entre doctypes.
 * Alimenta RE.2 (auto-explicación del descuadre) y RE.10 (descuentos/apoyos).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('erp_purchase_adjustments'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_purchase_adjustments (
        tenant_id        uuid NOT NULL,
        doctype          text NOT NULL,               -- 'XD40' (Devolución compra) | 'XD55' (Nota crédito)
        sucursal         text NOT NULL,               -- kdm1.c1 (00 = CEDIS)
        folio            text NOT NULL,               -- kdm1.c6 (único por doctype+sucursal)
        adjustment_date  date,                        -- kdm1.c9
        proveedor_code   text,                        -- kdm1.c10
        proveedor_nombre text,                        -- kdm1.c32
        proveedor_rfc    text,                         -- kdm1.c22
        factura_ref      text,                        -- kdm1.c11 (ref factura proveedor; liga heurística a la entrada)
        entrada_folio    text,                        -- kdm1.c39 cuando existe (~12/132); si no null → liga por factura/proveedor
        monto            numeric NOT NULL DEFAULT 0,  -- kdm1.c16 (total; con IVA en XD55)
        iva              numeric NOT NULL DEFAULT 0,  -- kdm1.c82 (XD55) / 0 (XD40)
        motivo           text,                        -- kdm1.c24 (texto libre del capturista)
        categoria        text,                        -- clasificación por keyword sobre motivo (faltante/no_solicitado/mal_estado/cambiada/pronto_pago/apoyo_marca/descuento_comercial/devolucion_otra/otro)
        source_branch    text,                        -- md_00..05 de origen
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, doctype, sucursal, folio)
      )`);
    await knex.raw(`CREATE INDEX ix_erppa_prov ON analytics.erp_purchase_adjustments (tenant_id, proveedor_code)`);
    await knex.raw(`CREATE INDEX ix_erppa_cat ON analytics.erp_purchase_adjustments (tenant_id, categoria)`);
    await knex.raw(`CREATE INDEX ix_erppa_factura ON analytics.erp_purchase_adjustments (tenant_id, factura_ref)`);
    await knex.raw(`CREATE INDEX ix_erppa_fecha ON analytics.erp_purchase_adjustments (tenant_id, adjustment_date)`);
    await knex.raw(`GRANT SELECT ON analytics.erp_purchase_adjustments TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_purchase_adjustments');
};
