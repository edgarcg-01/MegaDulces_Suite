/**
 * FISCAL.5.1 — Complementos de pago (REP) y saldo insoluto PUE/PPD.
 *
 * Un CFDI tipo 'P' (Pago/REP) referencia, en su Complemento/Pagos, uno o más
 * DoctoRelacionado (las facturas PPD que liquida). Esta tabla materializa esos
 * vínculos para calcular el saldo insoluto por factura y detectar PPD sin REP.
 *
 * RLS forzado, tenant-scoped. Idempotente (UNIQUE tenant+rep+docto+parcialidad).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS fiscal`);

  if (!(await knex.schema.withSchema('fiscal').hasTable('cfdi_payment_links'))) {
    await knex.raw(`
      CREATE TABLE fiscal.cfdi_payment_links (
        id                 uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        rep_uuid           varchar(36) NOT NULL,   -- UUID del CFDI tipo P (REP)
        docto_uuid         varchar(36) NOT NULL,   -- UUID de la factura pagada (IdDocumento)
        fecha_pago         timestamptz,
        forma_pago         text,
        moneda             text,
        num_parcialidad    int,
        imp_saldo_ant      numeric(18,6),
        imp_pagado         numeric(18,6),
        imp_saldo_insoluto numeric(18,6),
        created_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, id),
        UNIQUE (tenant_id, rep_uuid, docto_uuid, num_parcialidad)
      )`);
    await knex.raw(`CREATE INDEX ix_fiscal_paylinks_docto ON fiscal.cfdi_payment_links (tenant_id, docto_uuid)`);
    await knex.raw(`CREATE INDEX ix_fiscal_paylinks_rep ON fiscal.cfdi_payment_links (tenant_id, rep_uuid)`);
    await knex.raw(`ALTER TABLE fiscal.cfdi_payment_links ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE fiscal.cfdi_payment_links FORCE ROW LEVEL SECURITY`);
    await knex.raw(`CREATE POLICY tenant_isolation ON fiscal.cfdi_payment_links
      USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON fiscal.cfdi_payment_links TO app_runtime`);
  }

  // Permiso de lectura de conciliación (anclado al de gastos existente).
  const ANCHOR = { FISCAL_CONCILIACION_VER: 'FINANCE_EXPENSES_VER' };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[fiscal_cfdi_payments] up ${key}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FISCAL_CONCILIACION_VER' WHERE permissions -> 'FISCAL_CONCILIACION_VER' IS NOT NULL`);
  await knex.schema.withSchema('fiscal').dropTableIfExists('cfdi_payment_links');
};
