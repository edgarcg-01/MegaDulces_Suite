/**
 * FE.1 — Emisión de facturas (CFDI 4.0):
 *   - fiscal.issuer_config    → datos fiscales del emisor (RFC, razón social, régimen, CP/lugar exp., serie, PAC).
 *   - fiscal.invoice_sequences → folio atómico por (tenant, serie, year) (patrón commercial.order_sequences).
 *   - fiscal.cfdis.xml / .pdf → guardar el comprobante emitido (las descargadas viven en R2 vía stored_ref).
 *   - permisos FISCAL_FACTURAR_VER / _GESTIONAR (backfill anclado).
 *
 * RLS forzado, tenant-scoped, idempotente. NO borra nada.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  // ── Emisor ────────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('fiscal').hasTable('issuer_config'))) {
    await knex.raw(`
      CREATE TABLE fiscal.issuer_config (
        id             uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        rfc            varchar(13) NOT NULL,
        tax_name       text NOT NULL,               -- razón social EXACTA (CFDI 4.0)
        regimen_fiscal text NOT NULL,               -- clave régimen SAT
        cp             varchar(5) NOT NULL,          -- lugar de expedición
        serie          text,                         -- serie por defecto
        pac_provider   text NOT NULL DEFAULT 'sw',   -- sw|facturama
        is_default     boolean NOT NULL DEFAULT false,
        active         boolean NOT NULL DEFAULT true,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, rfc)
      )`);
    await knex.raw(`ALTER TABLE fiscal.issuer_config ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.issuer_config FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.issuer_config
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.issuer_config TO app_runtime`);
  }

  // ── Folio atómico ───────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('fiscal').hasTable('invoice_sequences'))) {
    await knex.raw(`
      CREATE TABLE fiscal.invoice_sequences (
        tenant_id     uuid NOT NULL,
        serie         text NOT NULL,
        year          int  NOT NULL,
        current_value int  NOT NULL DEFAULT 0,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, serie, year)
      )`);
    await knex.raw(`ALTER TABLE fiscal.invoice_sequences ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.invoice_sequences FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.invoice_sequences
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.invoice_sequences TO app_runtime`);
  }

  // ── Guardar el comprobante emitido en la misma tabla del almacén ─────────────
  if (!(await knex.schema.withSchema('fiscal').hasColumn('cfdis', 'xml'))) {
    await knex.schema.withSchema('fiscal').alterTable('cfdis', (t) => t.text('xml'));
  }
  if (!(await knex.schema.withSchema('fiscal').hasColumn('cfdis', 'pdf'))) {
    await knex.schema.withSchema('fiscal').alterTable('cfdis', (t) => t.text('pdf')); // base64 (FE.4)
  }

  // ── Permisos (backfill anclado; customer_b2b nunca factura) ──────────────────
  const ANCHOR = {
    FISCAL_FACTURAR_VER: 'FISCAL_CFDI_VER',
    FISCAL_FACTURAR_GESTIONAR: 'FISCAL_DESCARGA_GESTIONAR',
  };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_emision] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_FACTURAR_VER' - 'FISCAL_FACTURAR_GESTIONAR'
    WHERE permissions -> 'FISCAL_FACTURAR_VER' IS NOT NULL OR permissions -> 'FISCAL_FACTURAR_GESTIONAR' IS NOT NULL`);
  await knex.schema.withSchema('fiscal').dropTableIfExists('invoice_sequences');
  await knex.schema.withSchema('fiscal').dropTableIfExists('issuer_config');
  // Columnas xml/pdf en cfdis se conservan (no destructivo).
};
