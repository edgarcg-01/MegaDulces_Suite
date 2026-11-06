'use strict';
/**
 * `[CB.56]` — El estado de cuenta TAL COMO LO DA EL BANCO: el archivo y cada renglón.
 *
 * Hoy el lado banco de la conciliación es el libro «CUENTAS» que Tesorería copia a mano de la
 * banca en línea (`finance.bank_movements`, `sync_source` 'upload'/'sheet'). Para retirarlo
 * (FASE_CB §8) hace falta guardar el documento del banco mismo, que hoy no está en ningún lado:
 *
 *   · `finance.bank_statement_files` — cada archivo descargado de la banca y su control de saldo.
 *   · `finance.bank_statement_lines` — cada renglón del banco con lo que el libro no tiene:
 *     hora, referencia, clave de rastreo, cuenta/RFC/nombre de la contraparte y el texto original.
 *
 * ⛔ No es una copia de `bank_movements`: es OTRO dato (el del banco, no el capturado). Durante el
 * mes en paralelo (CB.60) conviven y se comparan; los ~40 lectores de `bank_movements` no se
 * tocan, así que nada sale doble. Que el banco reemplace al libro en `bank_movements` es CB.60.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-05) ──────────────────────────────────────────────
 *  · 4 muestras reales (Santander, Banorte, BBVA, BanBajío): 230 renglones, las 4 cuadran por
 *    saldo; BBVA, Banorte y BanBajío NO dicen su cuenta → `account_check` guarda cómo se fijó.
 *  · Las descargas se enciman (Banorte trae del 31-oct al 3-nov): `line_key` evita el doble.
 *
 * Idempotente. Sin columnas `NOT NULL` en tablas existentes: la API desplegada no se entera.
 *
 * @param { import("knex").Knex } knex
 */

const TABLAS = ['bank_statement_lines', 'bank_statement_files'];

async function rls(knex, tabla) {
  await knex.raw(`ALTER TABLE finance.${tabla} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${tabla} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'finance' AND tablename = '${tabla}' AND policyname = 'tenant_isolation') THEN
        CREATE POLICY tenant_isolation ON finance.${tabla}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        GRANT SELECT, INSERT, UPDATE ON finance.${tabla} TO app_runtime;
      END IF;
    END $$`);
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable('bank_statement_files'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_statement_files (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        bank_account_id  uuid NOT NULL REFERENCES finance.bank_accounts(id),
        bank             text NOT NULL,                 -- santander | banorte | bbva | banbajio
        file_name        text,
        file_sha1        text NOT NULL,                 -- el mismo archivo dos veces no entra dos veces
        date_from        date NOT NULL,
        date_to          date NOT NULL,
        lines_in_file    int  NOT NULL,
        lines_new        int  NOT NULL,                 -- los que no venían ya en otra descarga
        opening_balance  numeric(16,2) NOT NULL,
        closing_balance  numeric(16,2) NOT NULL,
        total_in         numeric(16,2) NOT NULL,
        total_out        numeric(16,2) NOT NULL,
        balance_ok       boolean NOT NULL,              -- saldo inicial + abonos − cargos = final, renglón por renglón
        declared_ok      boolean,                       -- NULL = el banco no declara totales (sólo BanBajío los trae)
        account_check    text NOT NULL,                 -- cómo se fijó la cuenta: en_archivo | saldo_continuo | sin_testigo
        created_at       timestamptz NOT NULL DEFAULT now(),
        created_by       text,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       text,
        CONSTRAINT bank_statement_files_sha1_uq UNIQUE (tenant_id, file_sha1),
        CONSTRAINT bank_statement_files_rango_ck CHECK (date_from <= date_to),
        CONSTRAINT bank_statement_files_check_ck CHECK (account_check IN ('en_archivo', 'saldo_continuo', 'sin_testigo'))
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bank_statement_files_cuenta ON finance.bank_statement_files (tenant_id, bank_account_id, date_to)`);
    await rls(knex, 'bank_statement_files');
  }

  if (!(await knex.schema.withSchema('finance').hasTable('bank_statement_lines'))) {
    await knex.raw(`
      CREATE TABLE finance.bank_statement_lines (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        file_id               uuid NOT NULL REFERENCES finance.bank_statement_files(id),
        bank_account_id       uuid NOT NULL REFERENCES finance.bank_accounts(id),
        line_no               int  NOT NULL,            -- renglón en el archivo que lo trajo primero (evidencia)
        seq                   int  NOT NULL,            -- orden CRONOLÓGICO dentro del archivo (BBVA y BanBajío vienen al revés)
        movement_date         date NOT NULL,
        movement_time         text,                     -- HH:MM, si el banco la da
        concept               text NOT NULL,
        amount_in             numeric(16,2) NOT NULL DEFAULT 0,
        amount_out            numeric(16,2) NOT NULL DEFAULT 0,
        running_balance       numeric(16,2) NOT NULL,
        reference             text,
        tracking_key          text,                     -- clave de rastreo SPEI
        counterparty_account  text,
        counterparty_rfc      text,
        counterparty_name     text,
        raw_line              text,                     -- el renglón original, como evidencia
        line_key              text NOT NULL,            -- cuenta+fecha+importes+saldo+concepto: la misma línea en dos descargas
        created_at            timestamptz NOT NULL DEFAULT now(),
        created_by            text,
        updated_at            timestamptz NOT NULL DEFAULT now(),
        updated_by            text,
        CONSTRAINT bank_statement_lines_key_uq UNIQUE (tenant_id, bank_account_id, line_key),
        CONSTRAINT bank_statement_lines_importe_ck CHECK (amount_in >= 0 AND amount_out >= 0)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bank_statement_lines_fecha ON finance.bank_statement_lines (tenant_id, bank_account_id, movement_date)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bank_statement_lines_rastreo ON finance.bank_statement_lines (tenant_id, tracking_key) WHERE tracking_key IS NOT NULL`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_bank_statement_lines_archivo ON finance.bank_statement_lines (file_id)`);
    await rls(knex, 'bank_statement_lines');
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  for (const t of TABLAS) await knex.raw(`DROP TABLE IF EXISTS finance.${t}`);
};
