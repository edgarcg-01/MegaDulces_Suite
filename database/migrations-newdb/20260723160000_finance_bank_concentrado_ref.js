/**
 * CB.11 — Tabla de referencia = la hoja CONCENTRADO del workbook (la verdad ya
 * reconciliada a mano por contabilidad). Guarda, por cuenta × tipo de movimiento,
 * el monto que el Excel declara. Sirve para VALIDAR automáticamente el parseo:
 * en cada import se compara bank_movements (agregado por cuenta×tipo) contra esta
 * referencia; cualquier Δ≠0 = error de captura/parse NUESTRO, detectado de una vez
 * (no por muestreo). Candado de regresión para feb–jul.
 *
 * Tipos oficiales del CONCENTRADO (12): I, ID, LEM, CI, C, CF, PF, P, PLEM, G, TI, TE
 *   + SALDO_INICIAL. (S/DS = pares Spei/DevSpei que el CONCENTRADO excluye por lavarse.)
 *
 * @param { import("knex").Knex } knex
 */
const MEGA = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  if (!(await knex.schema.withSchema('finance').hasTable('bank_concentrado_ref'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_concentrado_ref (
        tenant_id    uuid NOT NULL,
        period       text NOT NULL,            -- 'YYYY-MM'
        bank         text NOT NULL,
        cuenta       text NOT NULL,
        account_key  text NOT NULL,            -- normalizado (dígitos o token) para casar con bank_accounts
        tipo         text NOT NULL,            -- I|ID|LEM|CI|C|CF|PF|P|PLEM|G|TI|TE|SALDO_INICIAL
        monto        numeric NOT NULL DEFAULT 0,
        source_file  text,
        imported_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, period, account_key, tipo)
      )`);
    await knex.raw(`CREATE INDEX ix_conc_ref_period ON finance.bank_concentrado_ref (tenant_id, period)`);
    await knex.raw(`ALTER TABLE finance.bank_concentrado_ref ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.bank_concentrado_ref FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='bank_concentrado_ref' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.bank_concentrado_ref
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.bank_concentrado_ref TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('bank_concentrado_ref');
};
