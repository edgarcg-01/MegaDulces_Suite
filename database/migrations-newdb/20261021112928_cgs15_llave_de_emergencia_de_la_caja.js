'use strict';
/**
 * `[CGS.15]` — La **llave de emergencia** de la caja: el permiso escrito, con nombre y motivo, para
 * capturar mientras una jornada anterior sigue sin corte.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §2.1. Decisión D1 de Edgar
 * (2026-10-21): *candado duro + llave de emergencia*.
 *
 * ── Lo medido antes (prod, `dev_ro`, 2026-10-21) ────────────────────────────────────────────
 *  · La jornada del 20-oct quedó con **30 movimientos ($494,128.13) y sin corte**, y el 21-oct ya
 *    se capturaron **5 gastos ($145,906.50)** encima. Hoy nada lo impide.
 *  · Un candado sin salida detendría un pago urgente: una caja no puede dejar de pagar. La salida
 *    es esta tabla — cada excepción queda escrita, con quién la dio, para quién y por qué.
 *
 * ── Las reglas, en la base ──────────────────────────────────────────────────────────────────
 *  · Quien la da no es para quien es (`llave_ajena_chk`): nadie se abre su propio candado.
 *  · Motivo de 10+ caracteres y vencimiento obligatorio. El servicio la vence al terminar el día.
 *  · Sólo se AGREGA: app_runtime tiene SELECT e INSERT, sin UPDATE ni DELETE. Una llave que se
 *    puede borrar después no deja rastro de que existió.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_llaves'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_ledger_llaves (
        id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id              uuid NOT NULL,
        sucursal               text NOT NULL,
        para_usuario           uuid NOT NULL,
        para_username          text,
        otorgada_por           uuid NOT NULL,
        otorgada_por_username  text,
        motivo                 text NOT NULL,
        jornada_pendiente      date,
        vence_at               timestamptz NOT NULL,
        created_by             uuid NOT NULL,
        created_at             timestamptz NOT NULL DEFAULT now(),
        updated_by             uuid,
        updated_at             timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT llave_ajena_chk CHECK (para_usuario <> otorgada_por),
        CONSTRAINT llave_motivo_chk CHECK (length(btrim(motivo)) >= 10),
        CONSTRAINT llave_vence_chk CHECK (vence_at > created_at)
      )`);
    await knex.raw(`
      CREATE INDEX ix_cash_ledger_llaves_vigentes
        ON finance.cash_ledger_llaves (tenant_id, sucursal, para_usuario, vence_at DESC)`);
  }

  await knex.raw(`ALTER TABLE finance.cash_ledger_llaves ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.cash_ledger_llaves FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='cash_ledger_llaves' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.cash_ledger_llaves
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  // Sin UPDATE ni DELETE a propósito: una excepción que se puede borrar no es una excepción escrita.
  await knex.raw(`REVOKE UPDATE, DELETE ON finance.cash_ledger_llaves FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT ON finance.cash_ledger_llaves TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE finance.cash_ledger_llaves IS
    '[CGS.15] Llave de emergencia: permiso escrito para capturar mientras una jornada anterior no tiene corte cerrado. La da alguien con FINANCE_CAJA_AUTORIZAR a OTRA persona, con motivo; vence al terminar el dia. Solo se agrega.'`);
};

/** Deshace la tabla sólo si está vacía: con llaves dadas, borrarla tira la constancia. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable('cash_ledger_llaves'))) return;
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.cash_ledger_llaves`);
  if (rows[0].n > 0) {
    throw new Error(`[CGS.15] hay ${rows[0].n} llave(s) dadas: bajar la migración tiraría la constancia de esas excepciones.`);
  }
  await knex.raw(`DROP TABLE finance.cash_ledger_llaves`);
};
