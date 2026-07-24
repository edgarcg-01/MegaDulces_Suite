/**
 * MA.0 — Tareas de conciliación asignables (Maat · ADR-028/016).
 *
 * `finance.recon_tasks` = la capa de TRABAJO sobre los hallazgos de conciliación
 * bancaria (finance.findings, regla banco_retiro_sin_kepler). Una tarea agrupa
 * los movimientos sin conciliar de UN proveedor en UN periodo ("concilia los N
 * pagos a La Rosa de enero") y se ASIGNA a un usuario de Finanzas. El humano lo
 * resuelve EN KEPLER (captura la póliza); nuestras tablas SOLO rastrean — nunca
 * escribimos en Kepler (read-only/on-prem).
 *
 * Motor decide (qué falta + a quién) / agente comunica / humano ejecuta en Kepler
 * / feedback = re-match verifica el cierre. El LLM queda fuera del lazo.
 *
 * Modelo: el reparto es DETERMINISTA (por cuenta/round-robin balanceado). El
 * cierre se VERIFICA cruzando de nuevo (no por auto-reporte): cuando los findings
 * cubiertos pasan a corregido/matched, la tarea pasa a resuelto.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado (current_tenant_id()) +
 * grants app_runtime. Idempotente (hasTable). Un solo permiso nuevo:
 * FINANCE_RECON_ASIGNAR (autoridad de reparto/reasignación — líder de Finanzas);
 * ver "mis tareas" reusa FINANCE_BANK_VER y resolver reusa FINANCE_BANK_GESTIONAR.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS finance`);
  await knex.raw(`GRANT USAGE ON SCHEMA finance TO app_runtime`);

  if (!(await knex.schema.withSchema('finance').hasTable('recon_tasks'))) {
    await knex.raw(`
      CREATE TABLE finance.recon_tasks (
        id                  uuid NOT NULL DEFAULT gen_random_uuid(),
        tenant_id           uuid NOT NULL,
        rule_key            text NOT NULL DEFAULT 'banco_retiro_sin_kepler',
        periodo             text NOT NULL,          -- 'YYYY-MM'
        group_key           text NOT NULL,          -- proveedor_key normalizado (PK de negocio con periodo)
        proveedor_label     text NOT NULL,          -- beneficiario legible (del concepto bancario)
        finding_ids         jsonb NOT NULL DEFAULT '[]'::jsonb,  -- findings cubiertos por la tarea
        n_movimientos       int  NOT NULL DEFAULT 0,
        importe_total       numeric(16,2) NOT NULL DEFAULT 0,
        -- Asignación
        assigned_to          uuid,                  -- public.users.id (NULL = pool sin repartir)
        assigned_to_username text,
        assigned_by          text,                  -- 'maat' (motor) | username (manual)
        assigned_at          timestamptz,
        -- Ciclo de vida
        status              text NOT NULL DEFAULT 'pendiente'
                              CHECK (status IN ('pendiente','en_proceso','resuelto','no_aplica')),
        due_at              timestamptz,
        resolved_at         timestamptz,
        resolved_by         text,
        resolution_note     text,
        resolution_source   text,                   -- 'verificado' (re-match) | 'manual' (auto-reporte)
        kepler_ref          text,                   -- folio/póliza capturada (opcional, audit)
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (id),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, rule_key, periodo, group_key)   -- re-runs idempotentes
      )`);
    await knex.raw(`CREATE INDEX ix_fin_recon_tasks_status ON finance.recon_tasks (tenant_id, status, assigned_to)`);
    await knex.raw(`CREATE INDEX ix_fin_recon_tasks_periodo ON finance.recon_tasks (tenant_id, periodo, status)`);
    await knex.raw(`ALTER TABLE finance.recon_tasks ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE finance.recon_tasks FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='finance' AND tablename='recon_tasks' AND policyname='tenant_isolation') THEN
          CREATE POLICY tenant_isolation ON finance.recon_tasks
            USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
        END IF;
      END $$`);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON finance.recon_tasks TO app_runtime`);
  }

  // Permiso de reparto (líder de Finanzas). Se ancla a quien ya gestiona Bancos;
  // customer_b2b nunca. Backfill idempotente (patrón `-> 'KEY' IS NULL`).
  const res = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('FINANCE_RECON_ASIGNAR',
              CASE WHEN role_name = 'customer_b2b' THEN false
                   ELSE COALESCE((permissions->>'FINANCE_BANK_GESTIONAR')::boolean, false) END)
      WHERE permissions -> 'FINANCE_RECON_ASIGNAR' IS NULL`,
  );
  console.log(`[finance_recon_tasks] up FINANCE_RECON_ASIGNAR ← FINANCE_BANK_GESTIONAR: filas = ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_RECON_ASIGNAR' WHERE permissions -> 'FINANCE_RECON_ASIGNAR' IS NOT NULL`);
  await knex.schema.withSchema('finance').dropTableIfExists('recon_tasks');
};
