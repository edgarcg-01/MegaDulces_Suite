/**
 * Fase CC (extensión) — Comprobantes de PAGO A PROVEEDOR y de ORDEN DE ENTRADA.
 *
 * Calca el patrón de Comprobantes de Cobranza (mirror read-only de Kepler +
 * tabla de evidencia con OCR + HITL) para otros dos papeles de la operación:
 *
 *   1) PAGO A PROVEEDOR (transferencia bancaria) — documento Kepler `XD2501`
 *      ("Payment1" / Aplicación de pago, asiento C 201 / A 102 = sale dinero).
 *      Evidencia = comprobante SPEI/transferencia (mismo OCR que la ficha de cobro).
 *        · analytics.erp_supplier_payments   (espejo XD2501)
 *        · finance.supplier_payment_proofs    (adjunto + OCR + validación)
 *
 *   2) ORDEN DE ENTRADA (recepción de mercancía) — documento Kepler `X-A-20`
 *      (`XA2001` "ApEntOr1" / "Aplica Orden Entrada"): el doc que el proveedor firma
 *      y al que se adjunta la remisión (c16 = total con IVA), enriquecido con su vale `X-A-37`
 *      (RFC + razón social + folio de la OC). Evidencia = remisión/factura del
 *      proveedor (OCR propio de remisión).
 *        · analytics.erp_goods_receipts       (espejo X-A-40 ⋈ X-A-37)
 *        · finance.goods_receipt_proofs        (adjunto + OCR + validación)
 *
 * 100% read-only sobre Kepler (los mirrors los pueblan importers). Convención
 * A.0mt: tenant_id + audit; finance.* con RLS forzado + grants app_runtime;
 * analytics.* sin RLS (filtro tenant explícito) + GRANT SELECT.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // ── 1) PAGO A PROVEEDOR ────────────────────────────────────────────────
  // Espejo read-only de los pagos a proveedor de Kepler (XD2501).
  if (!(await knex.schema.withSchema('analytics').hasTable('erp_supplier_payments'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_supplier_payments (
        tenant_id        uuid NOT NULL,
        sucursal         text NOT NULL,            -- kdm1.c1 (00 = CEDIS centraliza pagos)
        folio            text NOT NULL,            -- kdm1.c6 (único en XD2501)
        doc_prefix       text NOT NULL DEFAULT 'XD2501',  -- Payment1 / X-D-25 "Pago a proveedor"
        pago_date        date,                     -- kdm1.c9
        proveedor_code   text,                     -- kdm1.c10 (código del proveedor)
        proveedor_nombre text,                     -- kdm1.c32 (razón social / beneficiario)
        proveedor_rfc    text,                     -- kdm1.c22 (RFC, cuando viene)
        concepto         text,                     -- kdm1.c24
        monto            numeric NOT NULL DEFAULT 0,  -- kdm1.c16 (importe pagado)
        source_branch    text,                     -- md_00
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, folio)
      )`);
    await knex.raw(`CREATE INDEX ix_erpsp_lookup ON analytics.erp_supplier_payments (tenant_id, pago_date DESC)`);
    await knex.raw(`CREATE INDEX ix_erpsp_prov ON analytics.erp_supplier_payments (tenant_id, proveedor_code)`);
    await knex.raw(`GRANT SELECT ON analytics.erp_supplier_payments TO app_runtime`);
  }

  // Nuestro registro de evidencia del pago (comprobante SPEI + OCR + validación).
  if (!(await knex.schema.withSchema('finance').hasTable('supplier_payment_proofs'))) {
    await knex.raw(`
      CREATE TABLE finance.supplier_payment_proofs (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        -- referencia al pago Kepler (snapshot self-contained)
        sucursal         text NOT NULL,
        folio            text NOT NULL,
        proveedor_nombre text,
        proveedor_rfc    text,
        pago_date        date,
        pago_monto       numeric DEFAULT 0,
        -- adjunto(s) en Cloudinary: [{ role, url, public_id, kind, name }]
        files            jsonb NOT NULL DEFAULT '[]',
        -- OCR del comprobante de transferencia (mismo shape que la ficha de depósito)
        ocr_monto        numeric,
        ocr_fecha        date,
        ocr_banco        text,
        ocr_cuenta_dest  text,                     -- últimos 4 / CLABE destino (cuenta del proveedor)
        ocr_referencia   text,                     -- clave de rastreo SPEI / folio operación
        ocr_ordenante    text,                     -- quién ordena (nuestra empresa/cuenta)
        ocr_metodo       text,                     -- transferencia_spei|cheque|efectivo|...
        ocr_raw          jsonb,
        ocr_status       text NOT NULL DEFAULT 'pendiente'
                          CHECK (ocr_status IN ('pendiente','ok','ilegible','sin_key','manual')),
        monto_match      boolean,                  -- |ocr_monto - pago_monto| <= tolerancia
        status           text NOT NULL DEFAULT 'recibido'
                          CHECK (status IN ('recibido','validado','rechazado')),
        comentarios      text,
        validated_by     text,
        validated_at     timestamptz,
        motivo_rechazo   text,
        created_by       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_spp_status ON finance.supplier_payment_proofs (tenant_id, status, created_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_spp_pago ON finance.supplier_payment_proofs (tenant_id, sucursal, folio)`);
    await knex.raw(`ALTER TABLE finance.supplier_payment_proofs ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.supplier_payment_proofs FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='supplier_payment_proofs' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.supplier_payment_proofs
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.supplier_payment_proofs TO app_runtime`);
  }

  // ── 2) ORDEN DE ENTRADA (recepción) ────────────────────────────────────
  // Espejo read-only de las órdenes de entrada de Kepler (XA2001 "Aplica Orden Entrada").
  if (!(await knex.schema.withSchema('analytics').hasTable('erp_goods_receipts'))) {
    await knex.raw(`
      CREATE TABLE analytics.erp_goods_receipts (
        tenant_id        uuid NOT NULL,
        sucursal         text NOT NULL,            -- kdm1.c1 (00 = CEDIS centraliza compras)
        folio            text NOT NULL,            -- kdm1.c6 (único en XA2001; NO entre doctypes)
        doc_prefix       text NOT NULL DEFAULT 'XA2001',  -- ApEntOr1 / X-A-20 "Aplica Orden Entrada"
        receipt_date     date,                     -- kdm1.c9
        proveedor_code   text,                     -- kdm1.c10
        proveedor_nombre text,                     -- vale.c32 (razón social completa) ?? oe.c32
        proveedor_rfc    text,                     -- vale.c22 (RFC del proveedor)
        vale_folio       text,                     -- oe.c39 → folio del vale X-A-37
        oc_folio         text,                     -- vale.c39 → folio de la OC X-A-35
        concepto         text,                     -- kdm1.c24
        monto            numeric NOT NULL DEFAULT 0,  -- kdm1.c16 (valor recibido)
        source_branch    text,                     -- md_00
        computed_at      timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, sucursal, folio)
      )`);
    await knex.raw(`CREATE INDEX ix_erpgr_lookup ON analytics.erp_goods_receipts (tenant_id, receipt_date DESC)`);
    await knex.raw(`CREATE INDEX ix_erpgr_prov ON analytics.erp_goods_receipts (tenant_id, proveedor_code)`);
    await knex.raw(`GRANT SELECT ON analytics.erp_goods_receipts TO app_runtime`);
  }

  // Nuestro registro de evidencia de la entrada (remisión/factura del proveedor + OCR).
  if (!(await knex.schema.withSchema('finance').hasTable('goods_receipt_proofs'))) {
    await knex.raw(`
      CREATE TABLE finance.goods_receipt_proofs (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        -- referencia a la orden de entrada Kepler (snapshot self-contained)
        sucursal         text NOT NULL,
        folio            text NOT NULL,
        proveedor_nombre text,
        proveedor_rfc    text,
        oc_folio         text,
        receipt_date     date,
        receipt_monto    numeric DEFAULT 0,
        -- adjunto(s) en Cloudinary: [{ role, url, public_id, kind, name }]
        files            jsonb NOT NULL DEFAULT '[]',
        -- OCR de la remisión/factura del proveedor
        ocr_folio        text,                     -- folio de la remisión/factura
        ocr_fecha        date,
        ocr_proveedor    text,
        ocr_rfc          text,
        ocr_subtotal     numeric,
        ocr_iva          numeric,
        ocr_monto        numeric,                  -- total de la remisión/factura
        ocr_raw          jsonb,
        ocr_status       text NOT NULL DEFAULT 'pendiente'
                          CHECK (ocr_status IN ('pendiente','ok','ilegible','sin_key','manual')),
        monto_match      boolean,                  -- |ocr_monto - receipt_monto| <= tolerancia
        status           text NOT NULL DEFAULT 'recibido'
                          CHECK (status IN ('recibido','validado','rechazado')),
        comentarios      text,
        validated_by     text,
        validated_at     timestamptz,
        motivo_rechazo   text,
        created_by       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_grp_status ON finance.goods_receipt_proofs (tenant_id, status, created_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_grp_entry ON finance.goods_receipt_proofs (tenant_id, sucursal, folio)`);
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.goods_receipt_proofs FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='goods_receipt_proofs' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.goods_receipt_proofs
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.goods_receipt_proofs TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('goods_receipt_proofs');
  await knex.schema.withSchema('finance').dropTableIfExists('supplier_payment_proofs');
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_goods_receipts');
  await knex.schema.withSchema('analytics').dropTableIfExists('erp_supplier_payments');
};
