/**
 * Fase PP.0 — Programa de Pagos / Tesorería.
 *
 * Digitaliza el Excel manual "PROGRAMA PAGOS 2026" (Tesorería): 1 fila por PAGO ejecutado
 * (fecha, proveedor, folios de factura, monto, banco, método, sucursal, tipo, flag KEPLER,
 * fecha de cobro). Es el LIBRO DE EJECUCIÓN de Cuentas por Pagar — cierra el triángulo
 * Deuda (201/2120) → Programa (este) → Banco (CB). Read-first: el importer lo carga idempotente
 * por client_uuid (hash de fila); NO es asiento contable, es espejo operativo (ADR-016/028).
 *
 * También extiende catalog.suppliers con los TÉRMINOS de la hoja PROVEEDORES: días de crédito,
 * descuento pronto pago, tipo de comprobante (fiscal/remisión) → alimenta timing de pago y Compras/RA.
 *
 * finance.* con RLS FORZADO + tenant_id + audit (patrón A.0mt). Grants a app_runtime.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  // 1) El programa de pagos: 1 fila por pago ejecutado (espejo del Excel de Tesorería).
  if (!(await knex.schema.withSchema('finance').hasTable('payment_program'))) {
    await knex.raw(`
      CREATE TABLE finance.payment_program (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        source_month      text NOT NULL,                 -- '2026-08' (hoja del Excel)
        client_uuid       text NOT NULL,                 -- idempotencia: hash estable de la fila
        pay_date          date,                          -- FECHA (registro del pago)
        clearing_date     date,                          -- FECHA COBRO/PAGO (cuando libera el banco)
        supplier_id       uuid,                          -- resuelto (nullable; sin FK dura: texto libre)
        supplier_text     text,                          -- PROVEEDOR/CONCEPTO crudo del Excel
        sucursal_code     text,                          -- ALMC (0/10/12/29/30/50…)
        tipo              text,                          -- compra | gasto | otro (de TIPO C/G)
        method            text,                          -- transfer | cheque | factoraje | anticipo | auto | otro
        method_ref        text,                          -- CH-5237 / 5019 / 16991 (folio del instrumento)
        bank_account_id   uuid REFERENCES finance.bank_accounts(id) ON DELETE SET NULL,
        bank_text         text,                          -- BBVA/BAJIO/BANORTE/SANTDR/FACTORAJE crudo
        amount            numeric NOT NULL DEFAULT 0,
        invoice_folios    text,                          -- "f-852-853-854" crudo (F. FACTURA)
        kepler_flag       boolean,                        -- columna KEPLER true/false (jul/ago); NULL antes
        concepto          text,
        recibio           text,
        -- conciliación (PP.4, diferida): liga al movimiento bancario real (CB) y a la póliza Kepler.
        bank_movement_id  uuid REFERENCES finance.bank_movements(id) ON DELETE SET NULL,
        kepler_matched    boolean,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, client_uuid)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_pp_month ON finance.payment_program (tenant_id, source_month)`);
    await knex.raw(`CREATE INDEX ix_fin_pp_supplier ON finance.payment_program (tenant_id, supplier_id)`);
    await knex.raw(`CREATE INDEX ix_fin_pp_bank ON finance.payment_program (tenant_id, bank_account_id)`);
    await knex.raw(`CREATE INDEX ix_fin_pp_paydate ON finance.payment_program (tenant_id, pay_date)`);
    await knex.raw(`ALTER TABLE finance.payment_program ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.payment_program FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='payment_program' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.payment_program
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.payment_program TO app_runtime`);
  }

  // 2) Términos de pago por proveedor (hoja PROVEEDORES) → catalog.suppliers (idempotente).
  const addCol = async (col, ddl) => {
    if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', col))) {
      await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN ${ddl}`);
    }
  };
  await addCol('credit_days', 'credit_days int');                 // DÍAS DE CRÉDITO (net terms)
  await addCol('invoice_type', "invoice_type text");             // 'fiscal' | 'remision'
  // NOTA: el DESCUENTO PRONTO PAGO NO se guarda aquí — vive en commercial.supplier_discount_policy
  // (expected_discount_rate/discount_days/discount_type). Evita duplicar la política de descuento.
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('payment_program');
  // columnas de suppliers: no se dropean en down (aditivas, seguras).
};
