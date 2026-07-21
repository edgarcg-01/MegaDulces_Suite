/**
 * GX.7 — Solicitud de autorización de gastos (reembolso corporativo).
 *
 * Digitaliza el Google Form del dominio: el empleado captura la solicitud de
 * reembolso de un gasto, ligándola por folio a la solicitud de Kepler (XA1501),
 * y adjunta múltiples comprobantes (comprobante físico h1/h2, la solicitud
 * Kepler, y hasta 3 evidencias fotográficas). Vive en NUESTRA tabla
 * `finance.expense_proofs`; NO escribe a Kepler (se concilia por folio). Flujo
 * `recibida → validada | rechazada` (el contador revisa/autoriza).
 *
 * Archivos = `files jsonb` array de { role, url, public_id, kind, name }, con
 * roles fijos: comprobante_1 (req), comprobante_2, solicitud_kepler (req),
 * evidencia_1, evidencia_2, evidencia_3.
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime + audit fields.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('expense_proofs'))) {
    await knex.raw(`
      CREATE TABLE finance.expense_proofs (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        solicitante         text NOT NULL,          -- quién solicita (auto=usuario, editable)
        departamento        text NOT NULL,          -- nombre canónico (dimensión dpto ERP)
        departamento_code   text,                   -- código dpto Kepler (ej. 1-09-07)
        sucursal            text,                   -- plaza derivada del depto (o "Oficinas / Corporativo")
        fecha_gasto         date,                   -- "Fecha del Gasto"
        folio_solicitud     text NOT NULL,          -- últimos 4 díg. de la solicitud Kepler (XA1501)
        proveedor           text NOT NULL,
        importe             numeric DEFAULT 0,
        files               jsonb NOT NULL DEFAULT '[]',  -- [{role,url,public_id,kind,name}] en Cloudinary
        comentarios         text,
        status              text NOT NULL DEFAULT 'recibida'
                              CHECK (status IN ('recibida','validada','rechazada')),
        validated_by        text,
        validated_at        timestamptz,
        motivo_rechazo      text,
        created_by          text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_fin_ep_status ON finance.expense_proofs (tenant_id, status, created_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_ep_folio ON finance.expense_proofs (tenant_id, folio_solicitud)`);
    await knex.raw(`ALTER TABLE finance.expense_proofs ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.expense_proofs FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='expense_proofs' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.expense_proofs
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expense_proofs TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('expense_proofs');
};
