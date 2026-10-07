/**
 * CS.3.2 — La base de datos que APRENDE el enlace caja ⇄ CAOS.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 *
 * CAOS (cajero) y Kepler NO comparten ninguna llave (0% medido): el cajero guarda el BULTO
 * (depósitos de ruta, retiros por propósito) y Kepler los movimientos individuales. Así que el
 * enlace entre "un gasto de caja" y "el retiro del cajero que lo pagó" no se puede deducir de una
 * columna — hay que APRENDERLO de los enlaces que un humano confirma, y usar ese aprendizaje para
 * proponer mejor la próxima vez (patrón feedback, ADR-021 / Horus-L / Maat L2).
 *
 * ── Patrones medidos (prod, read-only, 2026-09-25) que alimentan el matcher ───────────────────
 *
 *   · FECHA: el enlace real es MISMO DÍA. Monto exacto + mismo día = ~90% de precisión
 *     (47 reales vs 5 placebo); ±3 días baja a ~68% (84 vs 27). `accounting_date` = `occurred_at`.
 *   · REF: depósitos = ruta (`rd28`, `ruta 21`), dispensaciones = propósito/proveedor
 *     (`cueritos`, `bolsas`, `nomina`, `gnf ma`). Es la señal fuerte, no el monto.
 *   · OPERADOR = rol: 006 sólo deposita (495/0), 003 sobre todo dispensa (125/250), 002 dispensa.
 *   · HORA: depósitos por la tarde (~15h), dispensaciones a mediodía (Kepler no guarda hora → sólo
 *     ordena dentro del día, no cruza).
 *   · MONTO solo NO alcanza y ADEMÁS falla el caso parcial (gasto 25k pagado con 20k del cajero:
 *     los montos no coinciden). Por eso el enlace se propone y un humano confirma; nunca se aplica
 *     a ciegas (1 de 3 "matches" por monto es falso por azar).
 *
 * ── Qué hay acá ───────────────────────────────────────────────────────────────────────────────
 *
 * 1. `finance.caos_cash_links` (tabla real — es dato propio HITL/feedback, la excepción legítima a
 *    derive-no-copy): cada enlace CONFIRMADO entre una captura de caja (`cash_ledger`) y un
 *    movimiento de CAOS. CONSUME el movimiento (índice único vivo) para que no se cuente dos veces,
 *    y guarda en `senales` QUÉ patrones matchearon (para aprender cuáles son confiables). RLS forzado.
 * 2. `analytics.v_caos_link_patterns` (VISTA — derive-no-copy, la superficie que APRENDE): deriva de
 *    los enlaces confirmados el mapa `ref → (cuenta, concepto, beneficiario, operador) típico + nº de
 *    casos + rezago típico`. Fresca, sin mantenimiento: cada enlace confirmado la afina sola. El
 *    matcher la lee para subir la confianza de sus propuestas con el tiempo.
 *
 * Aditiva e idempotente. ⛔ Ni un `?` en el SQL (knex lo toma como binding).
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, table) {
  await knex.raw(`ALTER TABLE finance.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE finance.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON finance.${table}
          USING (tenant_id = current_tenant_id())
          WITH CHECK (tenant_id = current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);

  const existe = await knex.schema.withSchema('finance').hasTable('caos_cash_links');
  if (!existe) {
    await knex.raw(`
      CREATE TABLE finance.caos_cash_links (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        cash_ledger_id   uuid NOT NULL REFERENCES finance.cash_ledger(id) ON DELETE CASCADE,
        caos_device      text NOT NULL,
        caos_external_id bigint NOT NULL,
        -- Cuánto del movimiento de CAOS aplicó a esta captura (permite parcial). Nunca 0.
        monto_enlazado   numeric(14,2) NOT NULL CHECK (monto_enlazado <> 0),
        -- Qué señales matchearon + score, para APRENDER cuáles son confiables:
        -- {mismo_dia, monto_exacto, ref_token, operador, lag_dias, score}.
        senales          jsonb,
        confirmed_by     uuid,
        confirmed_at     timestamptz NOT NULL DEFAULT now(),
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        deleted_at       timestamptz
      )`);
    // ⭐ Anti-doble-conteo: un movimiento de CAOS se enlaza UNA sola vez mientras viva.
    await knex.raw(`CREATE UNIQUE INDEX ux_caos_link_vivo
      ON finance.caos_cash_links (tenant_id, caos_device, caos_external_id) WHERE deleted_at IS NULL`);
    await knex.raw(`CREATE INDEX ix_caos_link_ledger
      ON finance.caos_cash_links (tenant_id, cash_ledger_id) WHERE deleted_at IS NULL`);
    await tenantRls(knex, 'caos_cash_links');
    await knex.raw(`COMMENT ON TABLE finance.caos_cash_links IS
      'CS.3.2 — enlaces CONFIRMADOS caja<->CAOS (feedback/aprendizaje). Consume el movimiento CAOS '
      '(ux_caos_link_vivo) para no contarlo dos veces. senales jsonb guarda que patrones matchearon.'`);
  }

  // La superficie que APRENDE: patrones derivados de los enlaces confirmados. Deriva-no-copia.
  // security_invoker: la RLS de finance aplica a quien pregunta; el filtro de tenant va por el JOIN.
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caos_link_patterns`);
  await knex.raw(`
    CREATE VIEW analytics.v_caos_link_patterns
      WITH (security_invoker = true) AS
    SELECT l.tenant_id,
           lower(btrim(m.ref))                                            AS ref_norm,
           count(*)                                                       AS casos,
           mode() WITHIN GROUP (ORDER BY cl.kepler_cuenta)                AS cuenta_tipica,
           mode() WITHIN GROUP (ORDER BY cl.kepler_concepto)              AS concepto_tipico,
           mode() WITHIN GROUP (ORDER BY cl.beneficiario)                 AS beneficiario_tipico,
           mode() WITHIN GROUP (ORDER BY m.user_external)                 AS operador_tipico,
           round(avg((cl.fecha - m.accounting_date)))                     AS lag_tipico_dias,
           max(l.confirmed_at)                                            AS ultimo
      FROM finance.caos_cash_links l
      JOIN analytics.caos_cash_movements m
        ON m.tenant_id = l.tenant_id AND m.device = l.caos_device AND m.external_id = l.caos_external_id
      JOIN finance.cash_ledger cl
        ON cl.tenant_id = l.tenant_id AND cl.id = l.cash_ledger_id AND cl.deleted_at IS NULL
     WHERE l.deleted_at IS NULL AND m.ref IS NOT NULL AND btrim(m.ref) <> ''
     GROUP BY 1, 2`);
  await knex.raw(`GRANT SELECT ON analytics.v_caos_link_patterns TO app_runtime`);
  await knex.raw(`COMMENT ON VIEW analytics.v_caos_link_patterns IS
    'CS.3.2 — lo APRENDIDO de los enlaces caja<->CAOS confirmados: ref -> cuenta/concepto/'
    'beneficiario/operador tipico + casos + rezago. Deriva de finance.caos_cash_links; el matcher '
    'la usa para subir la confianza de sus propuestas con cada enlace confirmado.'`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS analytics.v_caos_link_patterns`);
  await knex.raw(`DROP TABLE IF EXISTS finance.caos_cash_links`);
};
