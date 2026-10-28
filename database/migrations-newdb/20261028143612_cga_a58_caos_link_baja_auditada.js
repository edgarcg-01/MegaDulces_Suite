'use strict';
/**
 * `[CGA-A.58]` — Quitar un vínculo CAOS ↔ Caja General deja QUIÉN y POR QUÉ.
 *
 * Edgar, 2026-10-28: *«una interfaz, permiso sólo superadmin, que pueda quitar la sociedad (en caso
 * de error) y lo vuelvan a vincular o generar»*. El vínculo ya se daba de baja por `deleted_at`,
 * pero sin decir quién ni por qué: un peso que deja de estar explicado tiene que poder rastrearse.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-28) ────────────────────────────────────────
 *  · `finance.caos_cash_links`: 201 filas, 0 dadas de baja. `app_runtime` ya tiene UPDATE y la
 *    política `tenant_isolation` cubre ALL.
 *
 * Dos columnas NULLABLE (tabla chica, sin reescritura). El CHECK sólo mira las bajas NUEVAS: una
 * baja sin motivo es exactamente lo que esta fase vino a impedir, y lo exige la base además del
 * servicio. `NOT VALID` porque las bajas viejas (hoy cero) no lo traen.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.caos_cash_links ADD COLUMN IF NOT EXISTS deleted_by uuid`);
  await knex.raw(`ALTER TABLE finance.caos_cash_links ADD COLUMN IF NOT EXISTS motivo_baja text`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'caos_link_baja_con_motivo') THEN
        ALTER TABLE finance.caos_cash_links ADD CONSTRAINT caos_link_baja_con_motivo
          CHECK (deleted_at IS NULL OR (deleted_by IS NOT NULL AND length(btrim(coalesce(motivo_baja, ''))) >= 10))
          NOT VALID;
      END IF;
    END $$`);
  console.log('[cga_a58] caos_cash_links: deleted_by + motivo_baja + CHECK caos_link_baja_con_motivo (NOT VALID)');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`ALTER TABLE finance.caos_cash_links DROP CONSTRAINT IF EXISTS caos_link_baja_con_motivo`);
  await knex.raw(`ALTER TABLE finance.caos_cash_links DROP COLUMN IF EXISTS motivo_baja`);
  await knex.raw(`ALTER TABLE finance.caos_cash_links DROP COLUMN IF EXISTS deleted_by`);
};
