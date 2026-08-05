/**
 * RE.10 — Política de descuento por proveedor (pronto pago / comercial).
 *
 * Base del detector "descuento NO capturado": guarda la tasa esperada de descuento
 * por proveedor + sus términos, para poder comparar contra lo REALMENTE capturado
 * (`erp_supplier_payments.descuento` c84 + notas X-D-55) y detectar pronto pago
 * dejado en la mesa (verificado: ~57% de los pagos de compra no capturan el 7.41%).
 *
 * Se llavea por `proveedor_code` (código Kepler, natural key) porque eso es lo que
 * cargan los espejos `analytics.erp_*` — NO por UUID (no hay FK a los espejos, igual
 * que ellos). RLS forzado + grants app_runtime (patrón commercial.*). tenant_id +
 * audit completos. Aditiva + idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('supplier_discount_policy')) return;

  await knex.raw(`
    CREATE TABLE commercial.supplier_discount_policy (
      tenant_id             uuid NOT NULL,
      proveedor_code        text NOT NULL,
      proveedor_nombre      text,
      expected_discount_rate numeric(6,4) NOT NULL DEFAULT 0,   -- 0.0741 = 7.41% sobre monto pagado
      discount_days         integer,                            -- paga en <= N días para capturar (término c18)
      discount_type         text NOT NULL DEFAULT 'pronto_pago'
                             CHECK (discount_type IN ('pronto_pago','comercial','apoyo','mixto')),
      source                text NOT NULL DEFAULT 'manual'
                             CHECK (source IN ('kepler','observed','manual')),  -- de dónde salió la tasa
      notes                 text,
      active                boolean NOT NULL DEFAULT true,
      created_by            text,
      updated_by            text,
      created_at            timestamptz NOT NULL DEFAULT now(),
      updated_at            timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, proveedor_code)
    )`);
  await knex.raw(`CREATE INDEX ix_sup_disc_pol_active ON commercial.supplier_discount_policy (tenant_id, active, expected_discount_rate DESC)`);
  await knex.raw(`COMMENT ON TABLE commercial.supplier_discount_policy IS 'RE.10 — tasa de descuento esperada por proveedor (pronto pago/comercial). Base del detector de descuento no capturado. Llave = código Kepler.'`);

  await knex.raw(`ALTER TABLE commercial.supplier_discount_policy ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.supplier_discount_policy FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='commercial' AND tablename='supplier_discount_policy' AND policyname='tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON commercial.supplier_discount_policy
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.supplier_discount_policy TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('supplier_discount_policy');
};
