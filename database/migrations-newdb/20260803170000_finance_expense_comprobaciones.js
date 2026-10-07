/**
 * GX.8 — Comprobación de Gastos (2ª etapa del ciclo de gasto).
 *
 * Digitaliza el 2º Google Form ("Comprobación de Gastos"): DESPUÉS de que un gasto
 * se autoriza/ejerce, Tesorería sube la COMPROBACIÓN referenciando el **Folio del
 * Gasto (Kepler XA1001)**. Complementa GX.7 (`finance.expense_proofs` = la Solicitud
 * de Autorización, ligada a XA1501). Cierra el ciclo:
 *   Solicitud (XA1501, expense_proofs) → Gasto (XA1001) → Comprobación (esta tabla).
 *
 * Vive en NUESTRA tabla; NO escribe a Kepler (se concilia por folio). Guarda el
 * `folio_gasto` (XA1001, obligatorio) y el `folio_solicitud` (XA1501, resuelto del
 * gasto vía analytics.expense_documents.solicitud_folio) para el SEGUIMIENTO cruzado
 * con /finanzas/solicitudes. Flujo `recibida → validada | rechazada`.
 *
 * Convención A.0mt: tenant_id + RLS forzado + grants app_runtime + audit fields.
 * Sin permisos nuevos: reusa FINANCE_EXPENSES_VER (captura) + FINANCE_FINDINGS_GESTIONAR (validar).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  if (!(await knex.schema.withSchema('finance').hasTable('expense_comprobaciones'))) {
    await knex.raw(`
      CREATE TABLE finance.expense_comprobaciones (
        id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        solicitante         text NOT NULL,          -- quién comprueba (auto=usuario, editable)
        departamento        text NOT NULL,          -- nombre canónico (dimensión dpto ERP)
        departamento_code   text,                   -- código dpto Kepler (ej. 1-09-07)
        sucursal            text,                   -- plaza derivada del depto
        folio_gasto         text NOT NULL,          -- "Folio del Gasto" (Kepler XA1001)
        folio_solicitud     text,                   -- solicitud ligada (XA1501), resuelta del gasto
        fecha_comprobacion  date,                   -- "Fecha de la Comprobación"
        folio_comprobacion  text,                   -- "Folio de la Comprobación" (últimos 4 díg.)
        proveedor           text NOT NULL,
        importe             numeric DEFAULT 0,      -- del gasto (referencia)
        files               jsonb NOT NULL DEFAULT '[]',  -- [{role,url,public_id,kind,name}] Cloudinary
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
    await knex.raw(`CREATE INDEX ix_fin_ec_status ON finance.expense_comprobaciones (tenant_id, status, created_at DESC)`);
    await knex.raw(`CREATE INDEX ix_fin_ec_gasto ON finance.expense_comprobaciones (tenant_id, folio_gasto)`);
    await knex.raw(`CREATE INDEX ix_fin_ec_solicitud ON finance.expense_comprobaciones (tenant_id, folio_solicitud)`);
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.expense_comprobaciones FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='expense_comprobaciones' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.expense_comprobaciones
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.expense_comprobaciones TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('expense_comprobaciones');
};
