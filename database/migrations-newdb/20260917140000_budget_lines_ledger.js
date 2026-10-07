/**
 * Fase PU.1 — Presupuestos: motor de egresos (ADR-066).
 *
 * La Fase TP (ADR-064) dejó `budget.expense_obligations` como ALIMENTADOR del Calendario de Pagos:
 * 2 buckets (`reserved_amount`/`paid_amount`) y `disponible = original − reservado − pagado` (resta
 * el pagado, contra la spec §8.1). Esta migración construye el ledger de 5 estados que la spec pide,
 * SIN tocar esa tabla (el Calendario sigue leyéndola igual) — Opción A de ADR-066: absorber, no
 * reemplazar.
 *
 * Grano correcto (refina ADR-066): el ledger de 5 estados vive en la PARTIDA (`budget_lines`, el
 * sobre autorizado), no en la obligación. Una obligación ("pagar renta $20k") CONSUME de una partida
 * ("gastos de renta 2026 $240k"). §8.2 opera a nivel partida. La obligación de TP gana un
 * `budget_line_id` opcional para colgarse de su partida — aditivo, no rompe nada.
 *
 * Modelo:
 *   budget.budgets        — cabecera (ejercicio, entidad, moneda MXN, estado borrador→…→cerrado, v1).
 *   budget.budget_lines   — partida: original/vigente + buckets reserved/committed/exercised/paid.
 *                           disponible = vigente − reserved − committed − exercised (pagado APARTE).
 *   budget.line_movements — ledger inmutable: cada transición deja un movimiento con clave idempotente.
 *   budget.expense_obligations.budget_line_id — link opcional obligación→partida (aditivo).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime; FKs compuestas
 * (tenant_id, id). Idempotente (hasTable/hasColumn). NO pone CHECK duro sobre la suma de buckets:
 * el sobregiro se permite bajo control 'informativo'/'advertencia' (spec §8.3) y lo arbitra el
 * servicio, no un constraint.
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS budget`);

  // ── budget.budgets — cabecera del presupuesto (una versión; escenarios = Capa 4) ─────────
  if (!(await knex.schema.withSchema('budget').hasTable('budgets'))) {
    await knex.raw(`
      CREATE TABLE budget.budgets (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL,
        name           text NOT NULL,
        fiscal_year    int  NOT NULL,
        entity         text,
        currency       text NOT NULL DEFAULT 'MXN',
        status         text NOT NULL DEFAULT 'borrador'
                         CHECK (status IN ('borrador','en_revision','pendiente','aprobado','cerrado')),
        version        int  NOT NULL DEFAULT 1,
        notes          text,
        authorized_by  text,
        authorized_at  timestamptz,
        created_by     text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     text,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, fiscal_year, name, version)
      )`);
    await knex.raw(`CREATE INDEX ix_budget_budgets_year ON budget.budgets (tenant_id, fiscal_year, status)`);
    await tenantRls(knex, 'budget', 'budgets');
  }

  // ── budget.budget_lines — partida presupuestaria (el sobre de 5 estados) ─────────────────
  if (!(await knex.schema.withSchema('budget').hasTable('budget_lines'))) {
    await knex.raw(`
      CREATE TABLE budget.budget_lines (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id        uuid NOT NULL,
        budget_id        uuid NOT NULL,
        concept          text NOT NULL,
        line_type        text NOT NULL DEFAULT 'gasto'
                           CHECK (line_type IN ('ingreso','costo_ventas','gasto','compra_inventario','inversion','flujo')),
        area             text,
        cost_center      text,
        account_code     text,
        responsible      text,
        period_month     date,
        original_amount  numeric(14,2) NOT NULL CHECK (original_amount >= 0),
        vigente_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (vigente_amount >= 0),
        reserved_amount  numeric(14,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
        committed_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (committed_amount >= 0),
        exercised_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (exercised_amount >= 0),
        paid_amount      numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
        control_level    text NOT NULL DEFAULT 'bloqueo'
                           CHECK (control_level IN ('informativo','advertencia','bloqueo')),
        status           text NOT NULL DEFAULT 'activa' CHECK (status IN ('activa','cerrada')),
        created_by       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_by       text,
        updated_at       timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, budget_id) REFERENCES budget.budgets (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_budget_lines_budget ON budget.budget_lines (tenant_id, budget_id)`);
    await knex.raw(`CREATE INDEX ix_budget_lines_status ON budget.budget_lines (tenant_id, status)`);
    await tenantRls(knex, 'budget', 'budget_lines');
  }

  // ── budget.line_movements — ledger inmutable de cada transición ──────────────────────────
  if (!(await knex.schema.withSchema('budget').hasTable('line_movements'))) {
    await knex.raw(`
      CREATE TABLE budget.line_movements (
        id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             uuid NOT NULL,
        budget_line_id        uuid NOT NULL,
        movement_type         text NOT NULL
                                CHECK (movement_type IN ('apertura','ampliacion','reduccion',
                                  'transferencia_in','transferencia_out','reserva','compromiso',
                                  'ejercido','pago','cancelacion','reversion')),
        amount                numeric(14,2) NOT NULL CHECK (amount > 0),
        counterpart_line_id   uuid,
        source_kind           text,
        source_ref            text,
        reverses_movement_id  uuid,
        note                  text,
        created_by            text,
        created_at            timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id, budget_line_id) REFERENCES budget.budget_lines (tenant_id, id) ON DELETE CASCADE
      )`);
    await knex.raw(`CREATE INDEX ix_budget_mov_line ON budget.line_movements (tenant_id, budget_line_id, created_at)`);
    // Idempotencia: un mismo (origen, documento, tipo) NO se aplica dos veces (reintento no re-consume).
    await knex.raw(`CREATE UNIQUE INDEX ux_budget_mov_idem ON budget.line_movements
                      (tenant_id, source_kind, source_ref, movement_type)
                      WHERE source_ref IS NOT NULL`);
    await tenantRls(knex, 'budget', 'line_movements');
  }

  // ── budget.expense_obligations.budget_line_id — link opcional obligación→partida (aditivo) ─
  if (!(await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'budget_line_id'))) {
    await knex.raw(`ALTER TABLE budget.expense_obligations ADD COLUMN budget_line_id uuid`);
    await knex.raw(`ALTER TABLE budget.expense_obligations
                      ADD CONSTRAINT fk_expense_obl_budget_line
                      FOREIGN KEY (tenant_id, budget_line_id)
                      REFERENCES budget.budget_lines (tenant_id, id) ON DELETE SET NULL`);
    await knex.raw(`CREATE INDEX ix_expense_obl_budget_line ON budget.expense_obligations (tenant_id, budget_line_id)`);
  }
};

exports.down = async function (knex) {
  // Link primero (depende de budget_lines).
  if (await knex.schema.withSchema('budget').hasColumn('expense_obligations', 'budget_line_id')) {
    await knex.raw(`ALTER TABLE budget.expense_obligations DROP CONSTRAINT IF EXISTS fk_expense_obl_budget_line`);
    await knex.raw(`DROP INDEX IF EXISTS budget.ix_expense_obl_budget_line`);
    await knex.raw(`ALTER TABLE budget.expense_obligations DROP COLUMN budget_line_id`);
  }
  await knex.schema.withSchema('budget').dropTableIfExists('line_movements');
  await knex.schema.withSchema('budget').dropTableIfExists('budget_lines');
  await knex.schema.withSchema('budget').dropTableIfExists('budgets');
};
