/**
 * CG.17 — Sustrato del autorrelleno: mapa HITL + reglas editables (ADR-070 §8).
 *
 * El autorrelleno propone por NIVELES DE CERTEZA, nunca "adivina":
 *   0 contexto        sesión/JWT/secuencia                    → certeza, silencioso
 *   1 documento       fiscal.cfdis · erp_collections ·        → se LIGA, no se teclea
 *                     erp_supplier_payments · bank_movements
 *   2 aprendido       analytics.expense_entries               → propone con soporte n/% visible
 *   3 reglas          ESTA migración (caja_classify_rules)    → propone, editable sin redeploy
 *   4 OCR             extractRemision / extractDepositSlip    → propone con cuadre por monto
 *
 * Dos tablas:
 *
 * `caja_kepler_concept_map` — las 122 cuentas del Access `Control` → (kepler_cuenta,
 *   kepler_concepto). Molde exacto de `finance.caja_bank_crosswalk` (CG.7) y RA-PRO.3: se
 *   PROPONE por derivación y lo CONFIRMA un humano. `source='derivado'` + `support` dice
 *   cuántas veces lo respalda la historia; `confirmed_by/at` dice quién se hizo cargo.
 *   ⚠️ Una fila sin `kepler_cuenta` NO es un error: es el estado honesto "sin propuesta".
 *   Por eso son NULLables y hay una vista de cobertura — un mapa vacío y un mapa completo no
 *   pueden verse igual (ADR-056).
 *
 * `caja_classify_rules` — regex sobre glosa/beneficiario → (cuenta, concepto), ordenadas por
 *   `priority`, LA PRIMERA QUE APLICA GANA, y si ninguna aplica → NO propone (no un default).
 *   Calcado de `finance.bank_classify_rules` (CB.6, ADR-033), cuya razón de existir está
 *   escrita ahí: "cada patrón nuevo hoy exige cambio de código + redeploy, y arriesga que las
 *   dos copias se desincronicen". No repetir ese error.
 *
 * ⛔ NO se siembran reglas de ejemplo. Una regla inventada por el programador que nunca vio la
 * operación es exactamente el "default disfrazado" que ADR-056 prohíbe: se vería como
 * conocimiento y sería ruido. Las reglas nacen de CG.17 midiendo contra los 12,253 movimientos
 * de 2026 ya capturados, o de la mano de quien captura.
 *
 * RLS FORZADO + grants. Idempotente. Aditiva.
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

  // --- Mapa cuenta de Control → par contable de Kepler (HITL) --------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('caja_kepler_concept_map'))) {
    await knex.raw(`
      CREATE TABLE finance.caja_kepler_concept_map (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        source_caja       text NOT NULL DEFAULT '20',   -- backend de Control (20 = Comisionistas)
        legacy_cuenta     text NOT NULL,                -- Cuenta.IdCuenta del Access, ej '1009'
        legacy_nombre     text,                         -- snapshot, ej 'Matriz Viaticos'
        sucursal          text,                         -- la que el concepto necesita (54 pares divergen)
        kepler_cuenta     text,                         -- NULL = sin propuesta (estado honesto)
        kepler_concepto   text,
        support           int  NOT NULL DEFAULT 0,      -- n de veces que la historia lo respalda
        support_ratio     numeric(5,4),                 -- dominancia 0..1 del par propuesto
        source            text NOT NULL DEFAULT 'derivado',
        confirmed_by      text,
        confirmed_at      timestamptz,
        note              text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT caja_map_source_chk CHECK (source IN ('derivado','manual')),
        CONSTRAINT caja_map_ratio_chk  CHECK (support_ratio IS NULL OR (support_ratio >= 0 AND support_ratio <= 1)),
        -- si hay propuesta, va COMPLETA: media propuesta es peor que ninguna
        CONSTRAINT caja_map_par_chk    CHECK ((kepler_cuenta IS NULL) = (kepler_concepto IS NULL))
      )`);
    await knex.raw(`CREATE UNIQUE INDEX ux_caja_map ON finance.caja_kepler_concept_map (tenant_id, source_caja, legacy_cuenta, coalesce(sucursal,''))`);
    await tenantRls(knex, 'caja_kepler_concept_map');
  }

  // --- Reglas de clasificación (molde CB.6) --------------------------------------------------
  if (!(await knex.schema.withSchema('finance').hasTable('caja_classify_rules'))) {
    await knex.raw(`
      CREATE TABLE finance.caja_classify_rules (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        priority          int  NOT NULL,                -- menor = primero; la primera que aplica GANA
        match_tipo        text,                         -- regex contra cash_ledger.tipo; NULL = comodín
        match_glosa       text,                         -- regex contra la glosa
        match_beneficiario text,                        -- regex contra el beneficiario
        kepler_cuenta     text NOT NULL,
        kepler_concepto   text NOT NULL,
        centro_costo      text,
        active            boolean NOT NULL DEFAULT true,
        note              text,
        -- telemetría de la regla 4 del §8.5: una regla que se corrige seguido se suprime sola
        applied_count     int NOT NULL DEFAULT 0,
        corrected_count   int NOT NULL DEFAULT 0,
        suppressed_at     timestamptz,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        -- una regla sin ningún matcher aplicaría a TODO: es un default disfrazado (ADR-056)
        CONSTRAINT caja_rule_matcher_chk CHECK (
          match_tipo IS NOT NULL OR match_glosa IS NOT NULL OR match_beneficiario IS NOT NULL),
        CONSTRAINT caja_rule_counts_chk CHECK (applied_count >= 0 AND corrected_count >= 0)
      )`);
    await knex.raw(`CREATE INDEX ix_caja_rules_prio ON finance.caja_classify_rules (tenant_id, priority) WHERE active AND suppressed_at IS NULL`);
    await tenantRls(knex, 'caja_classify_rules');
  }

  // --- Cobertura del mapa: un mapa vacío NO puede verse igual que uno completo ---------------
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_concept_map_coverage`);
  await knex.raw(`
    CREATE VIEW finance.v_caja_concept_map_coverage
      WITH (security_invoker = true) AS
    SELECT tenant_id,
           source_caja,
           count(*)::int                                                        AS cuentas,
           count(*) FILTER (WHERE kepler_cuenta IS NOT NULL)::int               AS con_propuesta,
           count(*) FILTER (WHERE kepler_cuenta IS NULL)::int                   AS sin_propuesta,
           count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int                AS confirmadas,
           count(*) FILTER (WHERE kepler_cuenta IS NOT NULL
                              AND confirmed_at IS NULL)::int                    AS por_confirmar
      FROM finance.caja_kepler_concept_map
     WHERE tenant_id = current_tenant_id()
     GROUP BY 1, 2`);
  await knex.raw(`GRANT SELECT ON finance.v_caja_concept_map_coverage TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP VIEW IF EXISTS finance.v_caja_concept_map_coverage`);
  await knex.schema.withSchema('finance').dropTableIfExists('caja_classify_rules');
  await knex.schema.withSchema('finance').dropTableIfExists('caja_kepler_concept_map');
};
