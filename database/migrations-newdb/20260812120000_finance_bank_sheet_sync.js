/**
 * CB.23.0 — Sync del workbook maestro (Google Sheet vía export público, ADR-033).
 *
 * Habilita el sincronizado del Excel maestro del mes en curso hacia finance.bank_*:
 *   - bank_movements.sync_source  = origen de la fila ('upload' manual | 'sheet' auto).
 *   - bank_movements.deleted_at   = soft-delete por barrido (fila borrada del Sheet).
 *   - finance.sheet_sync_config   = qué Sheet + periodo se sincroniza, con hash/estado.
 *
 * Idempotente (hasColumn/hasTable). RLS forzado + grants app_runtime en la tabla nueva.
 * Sin webhook ni cuenta de servicio: el pull baja el .xlsx de la URL de export.
 *
 * @param { import("knex").Knex } knex
 */

const MEGA = '00000000-0000-0000-0000-00000000d01c';
// Workbook maestro vivo (compartido "cualquiera con el enlace" → export público).
const MASTER_SHEET_ID = '17CZdSzuTLhEERAjHzU72e1dKFcb4F1Fr4igjq4XVg5g';

exports.up = async function (knex) {
  // ── bank_movements: origen + soft-delete ──
  if (!(await knex.schema.withSchema('finance').hasColumn('bank_movements', 'sync_source'))) {
    await knex.raw(`ALTER TABLE finance.bank_movements ADD COLUMN sync_source text NOT NULL DEFAULT 'upload'`);
  }
  if (!(await knex.schema.withSchema('finance').hasColumn('bank_movements', 'deleted_at'))) {
    await knex.raw(`ALTER TABLE finance.bank_movements ADD COLUMN deleted_at timestamptz`);
    // Índice parcial: la lectura por default filtra deleted_at IS NULL.
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_fin_mov_live ON finance.bank_movements (tenant_id, statement_id) WHERE deleted_at IS NULL`);
  }

  // ── finance.sheet_sync_config (qué Sheet + periodo se sincroniza) ──
  if (!(await knex.schema.withSchema('finance').hasTable('sheet_sync_config'))) {
    await knex.raw(`
      CREATE TABLE finance.sheet_sync_config (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        sheet_id       text NOT NULL,                 -- id del Google Sheet (export /d/<id>/export?format=xlsx)
        period         text NOT NULL,                 -- 'YYYY-MM' del mes en curso
        active         boolean NOT NULL DEFAULT false,-- el cron solo jala si active
        last_hash      text,                          -- sha1 del último .xlsx procesado (evita reprocesar)
        last_synced_at timestamptz,
        last_rows      int,
        last_changed   int,                           -- upserts + soft-deletes del último pull
        last_error     text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id)
      )`);
    await knex.raw(`ALTER TABLE finance.sheet_sync_config ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.sheet_sync_config FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='sheet_sync_config' AND policyname='tenant_isolation'
        ) THEN
          CREATE POLICY tenant_isolation ON finance.sheet_sync_config
            USING (tenant_id = current_tenant_id())
            WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.sheet_sync_config TO app_runtime`);

    // Seed del tenant mega_dulces (SET LOCAL pasa el WITH CHECK). active=false: se
    // prende desde la UI (botón/toggle) cuando se valide el primer pull manual.
    await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
    await knex.raw(
      `INSERT INTO finance.sheet_sync_config (tenant_id, sheet_id, period, active)
       VALUES (?, ?, ?, false)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [MEGA, MASTER_SHEET_ID, '2026-08'],
    );
  }

  // ── Alinear alias Santander: el Sheet trae 'STDR ####', el seed CB.0 puso 'SNTDR ####'.
  // Sin esto las 4 cuentas Santander no casan con su pestaña → se omiten en silencio.
  await knex.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
  await knex.raw(`
    UPDATE finance.bank_accounts
       SET alias = regexp_replace(alias, '^SNTDR ', 'STDR '), updated_at = now()
     WHERE tenant_id = ? AND bank = 'SANTANDER' AND alias LIKE 'SNTDR %'`, [MEGA]);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('sheet_sync_config');
  if (await knex.schema.withSchema('finance').hasColumn('bank_movements', 'deleted_at')) {
    await knex.raw(`DROP INDEX IF EXISTS finance.ix_fin_mov_live`);
    await knex.raw(`ALTER TABLE finance.bank_movements DROP COLUMN deleted_at`);
  }
  if (await knex.schema.withSchema('finance').hasColumn('bank_movements', 'sync_source')) {
    await knex.raw(`ALTER TABLE finance.bank_movements DROP COLUMN sync_source`);
  }
  // El alias Santander no se revierte (dato correcto).
};
