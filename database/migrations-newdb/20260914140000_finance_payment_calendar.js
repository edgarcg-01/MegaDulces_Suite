/**
 * Fase TP.0 — Calendario de Pagos: motor de asignación (ADR-064).
 *
 * Consume las obligaciones de `budget.expense_obligations` / `finance.financial_commitments` /
 * `commercial.supplier_payment_obligations` (migración previa) y las ASIGNA a un día, dentro de la
 * capacidad que Presupuestos fija (`budget.daily_capacity`). Nunca captura obligaciones sueltas.
 *
 * `finance.payment_calendar_lots`        — 1 fila por día (el "borrador" del día).
 * `finance.payment_allocations`          — 1 fila = 1 pago que el día agenda (nace con solo
 *                                           fecha+monto; método/banco se completan después).
 * `finance.payment_allocation_items`     — join N:M contra las obligaciones (polimórfico), con
 *                                           `applied_amount` por documento. Resuelve "un pago cubre
 *                                           varias facturas" y "una factura en varias parcialidades"
 *                                           sin reservar el mismo saldo dos veces.
 * `finance.payment_negotiation_agreements` — acuerdos (responsable/contraparte/fecha-monto
 *                                           comprometido/permite parcialidad/evidencia).
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime. Idempotente (hasTable).
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
  // ── finance.payment_negotiation_agreements — acuerdos (Compras/Sucursales/Finanzas) ──
  if (!(await knex.schema.withSchema('finance').hasTable('payment_negotiation_agreements'))) {
    await knex.raw(`
      CREATE TABLE finance.payment_negotiation_agreements (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        obligation_source text NOT NULL CHECK (obligation_source IN ('budget_expense','financial_commitment','supplier_payable')),
        obligation_id     uuid NOT NULL,
        responsible_user  text,
        counterpart_text  text,
        committed_date    date,
        committed_amount  numeric(14,2),
        allows_partial    boolean NOT NULL DEFAULT false,
        evidence_url      text,
        notes             text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_pna_obligation ON finance.payment_negotiation_agreements (tenant_id, obligation_source, obligation_id)`);
    await tenantRls(knex, 'finance', 'payment_negotiation_agreements');
  }

  // ── finance.payment_calendar_lots — 1 fila por día ───────────────────────────────────
  if (!(await knex.schema.withSchema('finance').hasTable('payment_calendar_lots'))) {
    await knex.raw(`
      CREATE TABLE finance.payment_calendar_lots (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    uuid NOT NULL,
        lot_date     date NOT NULL,
        status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','in_prep','released','executing','closed')),
        released_by  text,
        released_at  timestamptz,
        closed_by    text,
        closed_at    timestamptz,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, lot_date)
      )`);
    await tenantRls(knex, 'finance', 'payment_calendar_lots');
  }

  // ── finance.payment_allocations — 1 pago agendado (nace sin método/banco) ────────────
  if (!(await knex.schema.withSchema('finance').hasTable('payment_allocations'))) {
    await knex.raw(`
      CREATE TABLE finance.payment_allocations (
        id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               uuid NOT NULL,
        lot_id                  uuid NOT NULL,
        classification          text NOT NULL CHECK (classification IN ('compromiso_financiero','gasto','proveedor_mercancia')),
        priority_rank           integer,
        amount_assigned         numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_assigned >= 0),
        status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','executed','failed','cancelled')),
        payment_method          text CHECK (payment_method IN ('transferencia','cheque','efectivo','cargo_automatico')),
        bank_account_id         uuid REFERENCES finance.bank_accounts(id) ON DELETE SET NULL,
        destination_account_text text,
        cash_register_text      text,
        reference_text          text,
        notes                   text,
        reprogrammed_from_id    uuid,
        executed_at             timestamptz,
        failure_reason          text,
        created_by              text,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_by              text,
        updated_at              timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (lot_id) REFERENCES finance.payment_calendar_lots (id) ON DELETE CASCADE,
        FOREIGN KEY (reprogrammed_from_id) REFERENCES finance.payment_allocations (id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_pa_lot ON finance.payment_allocations (tenant_id, lot_id, status)`);
    await tenantRls(knex, 'finance', 'payment_allocations');
  }

  // ── finance.payment_allocation_items — join N:M pago↔obligación (con applied_amount) ─
  if (!(await knex.schema.withSchema('finance').hasTable('payment_allocation_items'))) {
    await knex.raw(`
      CREATE TABLE finance.payment_allocation_items (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        allocation_id     uuid NOT NULL,
        obligation_source text NOT NULL CHECK (obligation_source IN ('budget_expense','financial_commitment','supplier_payable')),
        obligation_id     uuid NOT NULL,
        applied_amount    numeric(14,2) NOT NULL CHECK (applied_amount > 0),
        agreement_id      uuid,
        created_at        timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (allocation_id) REFERENCES finance.payment_allocations (id) ON DELETE CASCADE,
        FOREIGN KEY (agreement_id)  REFERENCES finance.payment_negotiation_agreements (id) ON DELETE SET NULL
      )`);
    await knex.raw(`CREATE INDEX ix_pai_allocation ON finance.payment_allocation_items (tenant_id, allocation_id)`);
    await knex.raw(`CREATE INDEX ix_pai_obligation ON finance.payment_allocation_items (tenant_id, obligation_source, obligation_id)`);
    await tenantRls(knex, 'finance', 'payment_allocation_items');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('finance').dropTableIfExists('payment_allocation_items');
  await knex.schema.withSchema('finance').dropTableIfExists('payment_allocations');
  await knex.schema.withSchema('finance').dropTableIfExists('payment_calendar_lots');
  await knex.schema.withSchema('finance').dropTableIfExists('payment_negotiation_agreements');
};
