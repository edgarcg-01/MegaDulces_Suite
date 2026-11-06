'use strict';
/**
 * `[PGP.79]` — El vale guarda qué pasó cuando la Suite intentó AUTORIZAR su solicitud en Kepler.
 *
 * Decisión del usuario (2026-11-06): firmar en `/finanzas/aprobacion-gastos` autoriza la solicitud
 * `X-A-15-1` en Kepler (`kdm1.c43: N → A`). Esa escritura puede salir de tres formas —la Suite la
 * escribió, Kepler ya la tenía (`A`/`F`), o no se pudo (Kepler caído, cancelada, sin conexión)— y
 * hoy el vale no tiene dónde guardarlo: sin esto, un «no se pudo» sólo vive en un log y nadie
 * sabe qué solicitud quedó sin autorizar.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-06) ──────────────────────────────────────────────
 *  · 1,674 vales con folio; todos de 7 dígitos y sucursal de 2 (la llave de `kdm1` sin rellenar).
 *  · De los aprobados en 30 días, Kepler ya tenía 338 en `F` y 63 en `A` cuando la Suite firmó;
 *    sólo 1 en `N`.
 *
 * Columnas NULLABLES y sin backfill: NULL = la Suite no intentó escribir (la firma es anterior a
 * PGP.79, o la escritura estaba apagada). No se rellena con el estado de Kepler: eso lo dice la
 * vista viva `analytics.expense_requests`, y copiarlo aquí sería una segunda forma del mismo dato.
 * Compatible con la API desplegada: nada la exige, y el código nuevo pregunta si existe.
 *
 * Idempotente. Sólo agrega columnas nulas: no reescribe la tabla.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN IF NOT EXISTS kepler_authorization_status text`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN IF NOT EXISTS kepler_authorization_at timestamptz`);
  await knex.raw(`ALTER TABLE finance.expense_proofs ADD COLUMN IF NOT EXISTS kepler_authorization_note text`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_proofs_kepler_authorization_status_chk') THEN
        ALTER TABLE finance.expense_proofs ADD CONSTRAINT expense_proofs_kepler_authorization_status_chk
          CHECK (kepler_authorization_status IN ('escrito', 'ya_estaba', 'no_escrito'));
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.kepler_authorization_status IS
    '[PGP.79] Al firmar, la Suite intenta autorizar la solicitud en Kepler (kdm1.c43 N→A): escrito = la Suite la autorizó · ya_estaba = Kepler ya la tenía en A o F · no_escrito = no se pudo (motivo en kepler_authorization_note). NULL = no se intentó (firma anterior a PGP.79 o escritura apagada).'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.kepler_authorization_at IS
    '[PGP.79] Cuándo se intentó la autorización en Kepler (el último intento).'`);
  await knex.raw(`COMMENT ON COLUMN finance.expense_proofs.kepler_authorization_note IS
    '[PGP.79] Por qué no se escribió (no_escrito) o en qué estado la tenía Kepler (ya_estaba: A o F).'`);
  console.log('[PGP.79] expense_proofs: kepler_authorization_status/_at/_note listas (NULL = no se intentó)');
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP CONSTRAINT IF EXISTS expense_proofs_kepler_authorization_status_chk`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS kepler_authorization_note`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS kepler_authorization_at`);
  await knex.raw(`ALTER TABLE finance.expense_proofs DROP COLUMN IF EXISTS kepler_authorization_status`);
};
