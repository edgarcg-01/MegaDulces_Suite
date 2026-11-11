'use strict';
/**
 * `[CB.60b]` — **«Usar el banco»**: una cuenta deja de pedir el libro «CUENTAS» y su descarga del banco
 * alimenta `finance.bank_movements` (la misma tabla que hoy llena el libro, la que leen la conciliación
 * con Kepler, las pólizas de ContPAQi, Caja y cobranza). Decisiones firmadas por Edgar el 2026-11-11:
 * se pasa CUENTA POR CUENTA con un botón, sólo con 10 días hábiles seguidos que cuadran y ninguno que
 * difiera; la sucursal sale de un catálogo de llaves que la persona confirma al pasarla.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-10/11) ─────────────────────────────────────
 *  · 15 cuentas con descarga; 66 días cuadran contra el libro y 2 difieren de verdad.
 *  · Categoría sin el libro: 227 de 230 coinciden (los 3 restantes el libro no los tiene).
 *  · Sucursal sin el libro: 379 de 383 deducidas coinciden con la S del libro.
 *  · `bank_movements.classified_by` sólo admite 'rule' | 'manual', y `reclassifyAll` reescribe las 'rule'
 *    con las reglas del libro (M/C): un renglón del banco perdería su categoría. Por eso 'banco'.
 *
 * Qué hace:
 *  1. `finance.bank_accounts.statement_source_since` (date, NULL = la cuenta sigue con el libro) + quién y cuándo.
 *  2. `bank_movements.classified_by` admite 'banco' (la categoría la dio el clasificador sin M/C).
 *  3. `finance.bank_branch_keys`: la llave del banco (terminal, afiliación, tarjeta, concepto) → la sucursal (S),
 *     CONFIRMADA por una persona. Es dato propio (no se deriva cuando ya no hay libro): sin copia de nada.
 *
 * Aditiva e idempotente: columnas NULL en tabla existente y un CHECK que sólo AGREGA un valor permitido;
 * la API desplegada no se entera.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // 1. Desde cuándo manda el banco en la cuenta.
  for (const [col, tipo] of [['statement_source_since', 'date'], ['statement_source_set_by', 'text'], ['statement_source_set_at', 'timestamptz']]) {
    if (!(await knex.schema.withSchema('finance').hasColumn('bank_accounts', col))) {
      await knex.raw(`ALTER TABLE finance.bank_accounts ADD COLUMN ${col} ${tipo}`);
    }
  }

  // 2. 'banco' como procedencia de la categoría.
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bank_movements_classified_by_check'
                      AND pg_get_constraintdef(oid) LIKE '%banco%') THEN
        ALTER TABLE finance.bank_movements DROP CONSTRAINT IF EXISTS bank_movements_classified_by_check;
        ALTER TABLE finance.bank_movements ADD CONSTRAINT bank_movements_classified_by_check
          CHECK (classified_by = ANY (ARRAY['rule'::text, 'manual'::text, 'banco'::text]));
      END IF;
    END $$`);

  // 3. El catálogo confirmado de llaves → sucursal.
  if (!(await knex.schema.withSchema('finance').hasTable('bank_branch_keys'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_branch_keys (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        bank_account_id  uuid NOT NULL REFERENCES finance.bank_accounts(id),
        key_type         text NOT NULL,                 -- terminal | afiliacion | tarjeta | concepto
        key_value        text NOT NULL,
        sucursal         text NOT NULL,                 -- la S del libro (unidad de negocio, VERDAD §37.1)
        seen             int  NOT NULL DEFAULT 0,       -- cuántas veces se vio al aprenderla (evidencia)
        active           boolean NOT NULL DEFAULT true,
        confirmed_by     text NOT NULL,                 -- ⛔ la afirma una persona, no un script
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       text,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       text,
        CONSTRAINT bank_branch_keys_tipo_ck CHECK (key_type IN ('terminal', 'afiliacion', 'tarjeta', 'concepto'))
      )`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS bank_branch_keys_una_activa
      ON finance.bank_branch_keys (tenant_id, bank_account_id, key_type, key_value) WHERE active`);
    await knex.raw('ALTER TABLE finance.bank_branch_keys ENABLE ROW LEVEL SECURITY');
    await knex.raw('ALTER TABLE finance.bank_branch_keys FORCE ROW LEVEL SECURITY');
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'finance' AND tablename = 'bank_branch_keys' AND policyname = 'tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.bank_branch_keys
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
  }
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON finance.bank_branch_keys TO app_runtime;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN
        GRANT SELECT ON finance.bank_branch_keys TO dev_ro;
      END IF;
    END $$`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS finance.bank_branch_keys');
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM finance.bank_movements WHERE classified_by = 'banco') THEN
        ALTER TABLE finance.bank_movements DROP CONSTRAINT IF EXISTS bank_movements_classified_by_check;
        ALTER TABLE finance.bank_movements ADD CONSTRAINT bank_movements_classified_by_check
          CHECK (classified_by = ANY (ARRAY['rule'::text, 'manual'::text]));
      END IF;
    END $$`);
  for (const col of ['statement_source_set_at', 'statement_source_set_by', 'statement_source_since']) {
    await knex.raw(`ALTER TABLE finance.bank_accounts DROP COLUMN IF EXISTS ${col}`);
  }
};
