'use strict';
/**
 * `[CGS.22]` — El **conteo físico** de la caja fuerte CAOS: lo que una persona contó, billete por
 * billete, a ciegas, contra lo que la máquina decía tener en ese momento.
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §2.5.
 *
 * ── Lo medido antes (prod, `dev_ro`, 2026-10-21) ────────────────────────────────────────────
 *  · **0 conteos físicos en toda la historia.** El saldo de la caja fuerte sólo lo dice la propia
 *    máquina (`analytics.caos_cash_counts`, que llena el demonio `caos-live`, también 0 filas hoy).
 *    Un saldo que sólo afirma el aparato no tiene testigo: es la regla 10 del proyecto.
 *
 * ── Por qué una tabla nueva y no `analytics.caos_cash_counts` ───────────────────────────────
 * Aquélla es la LECTURA de la máquina (sistema externo, la escribe un demonio). Ésta es un hecho
 * propio —el conteo de una persona— que no se deriva de nada (GOTCHAS §32: tabla real para datos
 * propios). Guarda también la referencia con la que se comparó, porque la de la máquina cambia
 * con el siguiente movimiento y el conteo tiene que poder defenderse después.
 *
 * ── Reglas ──────────────────────────────────────────────────────────────────────────────────
 *  · Sólo se AGREGA (app_runtime sin UPDATE ni DELETE): un conteo no se corrige, se repite.
 *  · `diferencia = total − referencia_total` exacta cuando hay referencia; sin referencia, NULL
 *    (no se midió contra qué) — nunca 0.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable('caos_conteos_fisicos'))) {
    await knex.raw(`
      CREATE TABLE finance.caos_conteos_fisicos (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        device               text,
        piezas               jsonb NOT NULL,
        total                numeric(18,2) NOT NULL,
        referencia_total     numeric(18,2),
        referencia_origen    text,
        referencia_parcial   boolean,
        diferencia           numeric(18,2),
        nota                 text,
        created_by           uuid NOT NULL,
        created_by_username  text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT caos_conteo_total_chk CHECK (total >= 0),
        CONSTRAINT caos_conteo_piezas_chk CHECK (jsonb_typeof(piezas) = 'array'),
        CONSTRAINT caos_conteo_dif_chk CHECK (
          (referencia_total IS NULL AND diferencia IS NULL)
          OR (referencia_total IS NOT NULL AND diferencia = total - referencia_total))
      )`);
    await knex.raw(`CREATE INDEX ix_caos_conteos_fisicos ON finance.caos_conteos_fisicos (tenant_id, created_at DESC)`);
  }

  await knex.raw(`ALTER TABLE finance.caos_conteos_fisicos ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.caos_conteos_fisicos FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='caos_conteos_fisicos' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.caos_conteos_fisicos
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`REVOKE UPDATE, DELETE ON finance.caos_conteos_fisicos FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT ON finance.caos_conteos_fisicos TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE finance.caos_conteos_fisicos IS
    '[CGS.22] Conteo fisico de la caja fuerte CAOS por una persona, a ciegas, contra lo que la maquina decia en ese momento (guardado). Solo se agrega: un conteo no se corrige, se repite.'`);
};

/** Deshace sólo si está vacía: con conteos guardados, borrarla tira la constancia. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('finance').hasTable('caos_conteos_fisicos'))) return;
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.caos_conteos_fisicos`);
  if (rows[0].n > 0) throw new Error(`[CGS.22] hay ${rows[0].n} conteo(s) físicos: bajar la migración tiraría la constancia.`);
  await knex.raw(`DROP TABLE finance.caos_conteos_fisicos`);
};
