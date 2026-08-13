/**
 * Fase CG.7 — Crosswalk cuenta de Caja → cuenta de banco (account_label CB/Kepler).
 *
 * La conciliación de Caja hoy alinea por NOMBRE de banco (fuzzy). Para cuadrar a
 * nivel CUENTA hace falta mapear cada cuenta interna de Caja (`banco_cuenta`, un
 * código de Base Movimientos) al `account_label` real (número de cuenta, la llave
 * que comparten CB y Kepler tesorería). El mapeo se DERIVA vía Kepler (match de
 * depósitos por monto+fecha) pero es disperso → confirmación humana (patrón RA-PRO.3).
 *
 * Vive en finance.* (NO en analytics.caja_bancos_catalog, que el importer re-escribe
 * con NULL en cada corrida). RLS forzado + grants app_runtime.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  if (!(await knex.schema.withSchema('finance').hasTable('caja_bank_crosswalk'))) {
    await knex.raw(`
      CREATE TABLE finance.caja_bank_crosswalk (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       uuid NOT NULL,
        source_instance text NOT NULL DEFAULT 'SI',
        banco_code      text NOT NULL,            -- caja Base Movimientos banco_cuenta (código de cuenta)
        banco_name      text,                     -- nombre en Caja (snapshot)
        account_label   text,                     -- destino: cuenta CB/Kepler (2169, 4166, CG…); NULL = sin enlazar
        match_count     integer DEFAULT 0,        -- soporte del match vía Kepler al confirmar
        source          text NOT NULL DEFAULT 'manual'  -- manual | kepler_auto
                          CHECK (source IN ('manual','kepler_auto')),
        confirmed_by    text,
        confirmed_at    timestamptz,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, source_instance, banco_code)
      )`);
    await knex.raw(`ALTER TABLE finance.caja_bank_crosswalk ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.caja_bank_crosswalk FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='caja_bank_crosswalk' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.caja_bank_crosswalk
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.caja_bank_crosswalk TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('caja_bank_crosswalk');
};
