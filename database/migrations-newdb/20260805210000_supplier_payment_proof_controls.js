/**
 * SP.1 — Campos y controles para el comprobante de pago a proveedor.
 *
 * El OCR dedicado (`extractSupplierPayment`) lee datos que el de depósito no captura:
 *   - `ocr_concepto`       = "Concepto de pago" (folio(s) de factura: "F 451",
 *                            "F 906 907 908") → llave para casar contra el pago Kepler.
 *   - `ocr_cuenta_origen`  = cuenta de RETIRO (la nuestra, de donde SALE el dinero) →
 *                            base del three-way contra el cargo (amount_out) del banco.
 *   - `cuenta_propia`      = ¿la cuenta de origen es una cuenta de banco de la empresa?
 *                            (control anti-error: un pago debe salir de cuenta propia).
 *   - `ref_norm`           = clave de rastreo NORMALIZada (GENERATED de `ocr_referencia`)
 *                            → dedup determinista (misma transferencia usada dos veces).
 *
 * `ocr_referencia` ya existe y guarda la clave de rastreo. Idempotente (hasColumn).
 * Backfill de `cuenta_propia` bajo `SET LOCAL app.tenant_id` (finance.* con RLS forzado).
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const T = 'finance.supplier_payment_proofs';

exports.up = async function (knex) {
  const add = async (col, ddl) => {
    if (!(await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', col))) {
      await knex.raw(`ALTER TABLE ${T} ADD COLUMN ${ddl}`);
    }
  };
  await add('ocr_concepto', 'ocr_concepto text');
  await add('ocr_cuenta_origen', 'ocr_cuenta_origen text');
  await add('cuenta_propia', 'cuenta_propia boolean');

  if (!(await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', 'ref_norm'))) {
    await knex.raw(`
      ALTER TABLE ${T}
        ADD COLUMN ref_norm text
        GENERATED ALWAYS AS (
          NULLIF(regexp_replace(coalesce(ocr_referencia, ''), '[^0-9A-Za-z]', '', 'g'), '')
        ) STORED`);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS ix_fin_spp_refnorm
        ON ${T} (tenant_id, ref_norm)
        WHERE ref_norm IS NOT NULL AND status <> 'rechazado'`);
  }

  // Backfill cuenta_propia para evidencia ya cargada (mega_dulces).
  await knex.transaction(async (trx) => {
    await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
    await trx.raw(`
      UPDATE ${T} p
         SET cuenta_propia = EXISTS (
               SELECT 1 FROM finance.bank_accounts ba
                WHERE ba.tenant_id = p.tenant_id
                  AND ba.kind = 'bank' AND ba.active
                  AND ba.account_label ~ '^[0-9]{3,}$'
                  AND regexp_replace(coalesce(p.ocr_cuenta_origen, ''), '[^0-9]', '', 'g')
                        ~ (ba.account_label || '$')
             )
       WHERE p.ocr_cuenta_origen IS NOT NULL AND p.cuenta_propia IS NULL`);
  });
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_spp_refnorm`);
  for (const col of ['ref_norm', 'cuenta_propia', 'ocr_cuenta_origen', 'ocr_concepto']) {
    if (await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', col)) {
      await knex.raw(`ALTER TABLE ${T} DROP COLUMN ${col}`);
    }
  }
};
