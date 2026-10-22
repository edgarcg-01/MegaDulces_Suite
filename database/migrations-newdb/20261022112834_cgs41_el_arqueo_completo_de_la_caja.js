'use strict';
/**
 * `[CGS.41]` — **El arqueo completo de la caja vive en la Suite**: efectivo pieza por pieza,
 * caja fuerte, cheques, vales y papeles, y dólares con su tipo de cambio. Es lo que hasta hoy sólo
 * contaba el Access de Control, que Edgar jubila el 2026-10-22 («lo jubilemos de por vida»).
 *
 * Plan: `docs/IMPLEMENTACION/FASES/FASE_CGS_SUPERVISION_DE_CAJA.md` §4b.
 *
 * ── Lo medido antes (prod, `dev_ro`, 2026-10-22) ────────────────────────────────────────────
 *  · Control: 30,268 registros (2013-09-13 → hoy); en 2026, **329 arqueos completos** (los cinco
 *    rubros; se distinguen por `dolares <> 0`, CG.126).
 *  · La Suite ya tiene dónde poner los rubros que no son efectivo —`finance.cash_ledger_cut_custody`,
 *    CG.100— pero sólo atados a un corte y **nadie los captura: 4 filas, sembradas a mano**.
 *  · El segundo conteo existe en la práctica: el 20-oct a las 09:56 Control volvió a contar
 *    («CORTE 19/10/2026»). Decisión de Edgar del 22-oct: **María recuenta cada mañana, a ciegas**.
 *
 * ── Por qué una tabla nueva ─────────────────────────────────────────────────────────────────
 * Un arqueo no siempre es el cierre de un corte: el recuento de la mañana y el arqueo a media
 * jornada no cierran nada. Es un hecho propio (lo que una persona contó, cuándo), que no se deriva
 * de ninguna fuente (GOTCHAS §32). El corte sigue guardando su propio conteo de cierre.
 *
 * ── Reglas ──────────────────────────────────────────────────────────────────────────────────
 *  · Sólo se AGREGA (app_runtime sin UPDATE ni DELETE): un arqueo no se corrige, se repite.
 *  · Un rubro en NULL es «no se contó»; en 0 es «se contó y no hay». Nunca se confunden.
 *  · Dólares con tipo de cambio y FUENTE obligatoria (CG.100: el 19.101 de Control llevaba seis
 *    meses congelado sin que nadie lo dijera).
 *  · El recuento dice qué corte recuenta: sin eso no es testigo de nada.
 *
 * ── La vista única `analytics.v_caja_arqueos` ───────────────────────────────────────────────
 * El histórico de Control **NO se copia** (regla 2): se queda en `caja_general_ods`, congelado, y
 * la vista lo compone con los arqueos de la Suite. Sin la réplica de Control en el entorno (la
 * base de pruebas del CI), la vista sólo trae los de la Suite.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const VISTA_SUITE = `
  SELECT 'suite'::text                         AS origen,
         a.id::text                            AS folio,
         a.counted_at                          AS at,
         (a.counted_at AT TIME ZONE 'America/Mexico_City')::date AS dia,
         a.tipo,
         (a.caja_fuerte IS NOT NULL AND a.cheques IS NOT NULL AND a.papeles IS NOT NULL AND a.usd IS NOT NULL) AS completo,
         a.efectivo, a.caja_fuerte, a.cheques, a.papeles, a.usd, a.tipo_cambio, a.tipo_cambio_fuente,
         a.created_by_username                 AS quien,
         a.corte_id,
         a.nota
    FROM finance.cash_arqueos a
   WHERE a.tenant_id = current_tenant_id()`;

const VISTA_CONTROL = `
  SELECT 'control'::text                       AS origen,
         m.folio,
         ((m.fecha + m.hora::time) AT TIME ZONE 'America/Mexico_City') AS at,
         m.fecha                               AS dia,
         'conteo'::text                        AS tipo,
         true                                  AS completo,
         m.total_efectivo                      AS efectivo,
         m.total_tarjeta                       AS caja_fuerte,
         m.total_cheques                       AS cheques,
         m.total_papeles                       AS papeles,
         m.dolares_usd                         AS usd,
         m.tipo_cambio,
         ('Control ' || m.folio)               AS tipo_cambio_fuente,
         ('Control ' || coalesce(m.capturo, '?')) AS quien,
         NULL::uuid                            AS corte_id,
         m.observaciones                       AS nota
    FROM analytics.v_caja_control_movimientos m
   WHERE NOT m.cancelado AND m.naturaleza = 'conteo'`;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('finance').hasTable('cash_arqueos'))) {
    await knex.raw(`
      CREATE TABLE finance.cash_arqueos (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL,
        sucursal             text NOT NULL DEFAULT '00',
        tipo                 text NOT NULL,
        corte_id             uuid REFERENCES finance.cash_ledger_cuts(id),
        counted_at           timestamptz NOT NULL DEFAULT now(),
        piezas               jsonb NOT NULL,
        morralla             numeric(18,2) NOT NULL DEFAULT 0,
        efectivo             numeric(18,2) NOT NULL,
        caja_fuerte          numeric(18,2),
        caja_fuerte_fuente   text,
        cheques              numeric(18,2),
        papeles              numeric(18,2),
        usd                  numeric(18,2),
        tipo_cambio          numeric(12,4),
        tipo_cambio_fuente   text,
        nota                 text,
        created_by           uuid NOT NULL,
        created_by_username  text,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_by           uuid,
        updated_at           timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT cash_arqueo_tipo_chk CHECK (tipo IN ('recuento', 'intermedio')),
        CONSTRAINT cash_arqueo_recuento_corte_chk CHECK (tipo <> 'recuento' OR corte_id IS NOT NULL),
        CONSTRAINT cash_arqueo_piezas_chk CHECK (jsonb_typeof(piezas) = 'array'),
        CONSTRAINT cash_arqueo_montos_chk CHECK (
          efectivo >= 0 AND morralla >= 0
          AND coalesce(caja_fuerte, 0) >= 0 AND coalesce(cheques, 0) >= 0
          AND coalesce(papeles, 0) >= 0 AND coalesce(usd, 0) >= 0),
        CONSTRAINT cash_arqueo_caja_fuerte_chk CHECK (caja_fuerte IS NULL OR caja_fuerte_fuente IS NOT NULL),
        CONSTRAINT cash_arqueo_dolares_chk CHECK (
          usd IS NULL OR usd = 0
          OR (tipo_cambio > 0 AND nullif(btrim(tipo_cambio_fuente), '') IS NOT NULL))
      )`);
    await knex.raw(`CREATE INDEX ix_cash_arqueos ON finance.cash_arqueos (tenant_id, counted_at DESC)`);
    await knex.raw(`CREATE INDEX ix_cash_arqueos_corte ON finance.cash_arqueos (tenant_id, corte_id) WHERE corte_id IS NOT NULL`);
  }

  await knex.raw(`ALTER TABLE finance.cash_arqueos ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.cash_arqueos FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='cash_arqueos' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.cash_arqueos
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`REVOKE UPDATE, DELETE ON finance.cash_arqueos FROM app_runtime`);
  await knex.raw(`GRANT SELECT, INSERT ON finance.cash_arqueos TO app_runtime`);
  await knex.raw(`COMMENT ON TABLE finance.cash_arqueos IS
    '[CGS.41] Arqueo completo de la caja en la Suite (efectivo por pieza, caja fuerte, cheques, papeles, dolares con tipo de cambio y fuente): el recuento de la manana y el arqueo a media jornada. Reemplaza al Access de Control, jubilado el 2026-10-22. Solo se agrega: un arqueo no se corrige, se repite. NULL = no se conto; 0 = se conto y no hay.'`);

  // La vista única: Control (congelado) + Suite. Sin la réplica de Control, sólo la Suite.
  const hayControl = (await knex.raw(`SELECT to_regclass('analytics.v_caja_control_movimientos') IS NOT NULL AS t`)).rows[0].t === true;
  await knex.raw(`CREATE OR REPLACE VIEW analytics.v_caja_arqueos AS ${hayControl ? `${VISTA_CONTROL}\n  UNION ALL\n${VISTA_SUITE}` : VISTA_SUITE}`);
  await knex.raw(`GRANT SELECT ON analytics.v_caja_arqueos TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_caja_arqueos IS
    '[CGS.41] Todos los arqueos completos de la caja: los de Control (historico congelado, 2013 al 2026-10-22) y los de la Suite. No copia nada: compone las dos fuentes. Los de la Suite filtran por current_tenant_id().'`);
};

/** Deshace sólo si no hay arqueos guardados: con arqueos, bajarla tira la constancia. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caja_arqueos`);
  if (!(await knex.schema.withSchema('finance').hasTable('cash_arqueos'))) return;
  const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM finance.cash_arqueos`);
  if (rows[0].n > 0) throw new Error(`[CGS.41] hay ${rows[0].n} arqueo(s): bajar la migración tiraría la constancia.`);
  await knex.raw(`DROP TABLE finance.cash_arqueos`);
};
