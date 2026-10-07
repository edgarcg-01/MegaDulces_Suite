/**
 * CB.13 (Fase 1) — Catálogo REAL de cuentas contables de Kepler como referencia.
 *
 * Espejo del catálogo `md.kdco` (clave + descripción), canónico desde almacén 00 (CEDIS,
 * donde vive el 96% de la contabilidad). Reemplaza el ADIVINAR a qué mayor va cada cosa:
 * todo mapeo/búsqueda de cuenta se hace contra esta tabla (réplica del "Búsqueda de cuentas"
 * de Kepler). Se puebla con `import-kepler-accounts.js` desde analytics.ledger_monthly.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  if (!(await knex.schema.withSchema('finance').hasTable('kepler_accounts'))) {
    await knex.raw(`
      CREATE TABLE finance.kepler_accounts (
        tenant_id           uuid NOT NULL,
        cuenta              text NOT NULL,            -- clave, ej '611-003' o '511'
        cuenta_nombre       text,                     -- descripción
        cuenta_mayor        text NOT NULL,            -- ej '611'
        cuenta_mayor_nombre text,
        es_mayor            boolean NOT NULL DEFAULT false,
        sucursal_ref        text NOT NULL DEFAULT '00',
        computed_at         timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, cuenta)
      )`);
    await knex.raw(`CREATE INDEX ix_kepler_acc_mayor ON finance.kepler_accounts (tenant_id, cuenta_mayor)`);
    await knex.raw(`CREATE INDEX ix_kepler_acc_nombre ON finance.kepler_accounts USING gin (to_tsvector('spanish', COALESCE(cuenta_nombre,'')))`);
    await knex.raw(`ALTER TABLE finance.kepler_accounts ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.kepler_accounts FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='kepler_accounts' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.kepler_accounts
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.kepler_accounts TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('kepler_accounts');
};
