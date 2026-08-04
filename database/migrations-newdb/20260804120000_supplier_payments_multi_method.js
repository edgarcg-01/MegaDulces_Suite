/**
 * Fase CC (extensión) — Pago a proveedor MULTI-MÉTODO (transferencia + cheque).
 *
 * Corrección de doctype (verificada en vivo con el comprobante BBVA real, 2026-08-04):
 * el pago a proveedor NO es solo `XD2501`. En Kepler `c31` = forma de pago:
 *   · XD2501 → c31='Che' (CHEQUE)          623 docs / $42.5M
 *   · XD2601 → c31='Tra' (TRANSFERENCIA)  16,164 docs / $338M  ← el 96% de los pagos
 * El mismo proveedor se paga por AMBOS (KLASS, SWEETS aparecen en los dos). El espejo
 * original leía solo XD2501 (cheques) y se perdía TODAS las transferencias — justo el
 * caso del comprobante que se digitaliza. Ahora lee ambos y etiqueta `metodo_pago`.
 *
 * OJO PK: el folio `c6` NO es único entre doctypes (623 folios existen en XD2501 Y
 * XD2601). Por eso `doc_prefix` DEBE entrar en la PK del espejo — ver
 * [[reference_kepler_orden_entrada_xa2001]]. La evidencia guarda doc_prefix + metodo
 * como snapshot para ligar sin ambigüedad.
 *
 * Aditiva + idempotente. No borra datos (el importer repuebla con --reset).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // 1) metodo_pago en el espejo (transferencia | cheque)
  if (!(await knex.schema.withSchema('analytics').hasColumn('erp_supplier_payments', 'metodo_pago'))) {
    await knex.raw(`ALTER TABLE analytics.erp_supplier_payments ADD COLUMN metodo_pago text`);
  }

  // 2) doc_prefix dentro de la PK (folio NO es único entre XD2501/XD2601).
  //    Idempotente: solo reescribe la PK si aún no incluye doc_prefix.
  await knex.raw(`
    DO $$
    DECLARE pk_cols text;
    BEGIN
      SELECT string_agg(a.attname, ',' ORDER BY array_position(con.conkey, a.attnum))
        INTO pk_cols
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace ns ON ns.oid = rel.relnamespace
        JOIN pg_attribute a ON a.attrelid = rel.oid AND a.attnum = ANY(con.conkey)
       WHERE con.contype = 'p' AND ns.nspname = 'analytics' AND rel.relname = 'erp_supplier_payments';
      IF pk_cols IS DISTINCT FROM 'tenant_id,sucursal,doc_prefix,folio' THEN
        ALTER TABLE analytics.erp_supplier_payments DROP CONSTRAINT IF EXISTS erp_supplier_payments_pkey;
        ALTER TABLE analytics.erp_supplier_payments
          ADD CONSTRAINT erp_supplier_payments_pkey PRIMARY KEY (tenant_id, sucursal, doc_prefix, folio);
      END IF;
    END $$;
  `);

  // 3) snapshot doc_prefix + metodo_pago en la evidencia (liga sin ambigüedad)
  if (!(await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', 'doc_prefix'))) {
    await knex.raw(`ALTER TABLE finance.supplier_payment_proofs ADD COLUMN doc_prefix text`);
  }
  if (!(await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', 'metodo_pago'))) {
    await knex.raw(`ALTER TABLE finance.supplier_payment_proofs ADD COLUMN metodo_pago text`);
  }
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_spp_pago2 ON finance.supplier_payment_proofs (tenant_id, sucursal, doc_prefix, folio)`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_spp_pago2`);
  if (await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', 'metodo_pago')) {
    await knex.raw(`ALTER TABLE finance.supplier_payment_proofs DROP COLUMN metodo_pago`);
  }
  if (await knex.schema.withSchema('finance').hasColumn('supplier_payment_proofs', 'doc_prefix')) {
    await knex.raw(`ALTER TABLE finance.supplier_payment_proofs DROP COLUMN doc_prefix`);
  }
  // restaura la PK original (tenant, sucursal, folio) — solo si no hay folios duplicados
  await knex.raw(`
    DO $$ BEGIN
      ALTER TABLE analytics.erp_supplier_payments DROP CONSTRAINT IF EXISTS erp_supplier_payments_pkey;
      ALTER TABLE analytics.erp_supplier_payments
        ADD CONSTRAINT erp_supplier_payments_pkey PRIMARY KEY (tenant_id, sucursal, folio);
    EXCEPTION WHEN unique_violation THEN
      -- hay folios repetidos entre doctypes: deja doc_prefix en la PK
      ALTER TABLE analytics.erp_supplier_payments
        ADD CONSTRAINT erp_supplier_payments_pkey PRIMARY KEY (tenant_id, sucursal, doc_prefix, folio);
    END $$;
  `);
  if (await knex.schema.withSchema('analytics').hasColumn('erp_supplier_payments', 'metodo_pago')) {
    await knex.raw(`ALTER TABLE analytics.erp_supplier_payments DROP COLUMN metodo_pago`);
  }
};
