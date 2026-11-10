'use strict';
/**
 * `[PGP.111c]` — **La cuenta de gasto de un proveedor, FIRMADA por Contabilidad** (P3, Edgar 2026-11-10: «la cuenta
 * contable de cada proveedor de gasto la define la contadora, en el sistema»).
 *
 * La cuenta se deriva sola de lo que la contadora ya hizo (`cuentaGastoMasUsada`, `[CP.8.87]`: la cuenta 52 que más
 * usó con ese RFC; 93 %, placebo 9 %). Lo que NO se deriva —un proveedor sin historia, o uno que ella carga a
 * cuentas distintas (CFE: 64 de 127 a la misma)— lo decide ella. Hasta hoy no había dónde: el Puente ContPAQi firma
 * reglas POR CATEGORÍA del movimiento bancario (`contpaqi.account_rules`) y alias de proveedor de COMPRA (2120,
 * `contpaqi.supplier_aliases`), pero no la cuenta de gasto de un RFC.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-10) ───────────────────────────────────────────
 *  · 21 RFC de gasto en el Calendario de Pagos (60 días): 19 con cuenta derivada, 2 sin historia; la réplica da la
 *    misma cuenta en los 18 comparables. Las firmas empiezan en 0.
 *
 * ── Qué crea ───────────────────────────────────────────────────────────────────────────────────
 *  `contpaqi.supplier_expense_accounts` — molde `contpaqi.supplier_aliases` (`[CP.8.36]`):
 *  · una firma ACTIVA por RFC (`UNIQUE (tenant_id, rfc) WHERE active`); re-firmar desactiva la anterior: queda el
 *    historial de quién cambió qué;
 *  · `cuenta` de gasto: 10 dígitos que empiezan con 52 (CHECK); que exista y sea afectable lo valida el servicio
 *    contra el catálogo de ContPAQi;
 *  · `firmada_por` NOT NULL: esto no lo deriva un script, lo afirma una persona;
 *  · `tenant_id` + RLS forzada (`tenant_isolation`) + auditoría; `app_runtime` lee y escribe, `dev_ro` lee.
 *  Lo leen la póliza de gasto (`FuentePagoProveedor`) y el Calendario: una firma le GANA a lo derivado.
 *
 * Aditiva e idempotente. Va en prod ANTES del código (el Calendario la lee).
 *
 * @param { import("knex").Knex } knex
 */

const TABLA = 'contpaqi.supplier_expense_accounts';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw('CREATE SCHEMA IF NOT EXISTS contpaqi');
  if (!(await knex.schema.withSchema('contpaqi').hasTable('supplier_expense_accounts'))) {
    await knex.schema.withSchema('contpaqi').createTable('supplier_expense_accounts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      /** RFC del proveedor, en mayúsculas y sin espacios. */
      t.text('rfc').notNullable();
      /** La cuenta de gasto de ContPAQi (52, 10 dígitos) a la que carga. */
      t.text('cuenta').notNullable();
      t.text('cuenta_nombre');
      /** ⛔ NOT NULL: una firma sin autor no es una afirmación. */
      t.text('firmada_por').notNullable();
      t.text('nota');
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.text('updated_by');
    });
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS supplier_expense_accounts_una_por_rfc ON ${TABLA} (tenant_id, rfc) WHERE active`);
  for (const [nombre, expr] of [
    ['supplier_expense_accounts_cuenta_gasto_chk', `cuenta ~ '^52[0-9]{8}$'`],
    ['supplier_expense_accounts_rfc_forma_chk', `rfc ~ '^[A-Z&Ñ]{3,4}[0-9]{6}[A-Z0-9]{3}$'`],
  ]) {
    await knex.raw(`DO $$ BEGIN ALTER TABLE ${TABLA} ADD CONSTRAINT ${nombre} CHECK (${expr});
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  }
  await knex.raw(`COMMENT ON TABLE ${TABLA} IS
    '[PGP.111c] Cuenta de gasto (52) de un proveedor por RFC, FIRMADA por Contabilidad. Le gana a la derivada (la que la contadora uso mas con ese RFC, CP.8.87). Una activa por RFC; re-firmar desactiva la anterior.'`);

  await knex.raw(`ALTER TABLE ${TABLA} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${TABLA} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${TABLA}`);
  await knex.raw(`CREATE POLICY tenant_isolation ON ${TABLA} USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())`);
  await knex.raw(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN EXECUTE 'GRANT SELECT, INSERT, UPDATE ON ${TABLA} TO app_runtime'; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN EXECUTE 'GRANT SELECT ON ${TABLA} TO dev_ro'; END IF;
  END $$`);

  // ⛔ Freno de verdad: el estado FINAL, no que las sentencias corrieron.
  const { rows: [e] } = await knex.raw(`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forzado,
           (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'contpaqi' AND p.tablename = 'supplier_expense_accounts') AS politicas
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'contpaqi' AND c.relname = 'supplier_expense_accounts'`);
  if (!e || !e.rls || !e.forzado || e.politicas < 1) {
    throw new Error(`[PGP.111c] ${TABLA} no quedó con RLS forzada y su política: no se deja a medias.`);
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.schema.withSchema('contpaqi').dropTableIfExists('supplier_expense_accounts');
};
