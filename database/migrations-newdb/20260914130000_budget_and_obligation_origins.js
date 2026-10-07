/**
 * Fase TP.0 — Calendario de Pagos: orígenes de obligación (ADR-064).
 *
 * El Calendario de Pagos es un CONSUMIDOR: cada obligación nace precargada y autorizada en su
 * módulo de origen. Presupuestos no existía como módulo (cero tablas) — esta migración lo crea
 * (schema `budget`) con dos responsabilidades: capacidad diaria de pago + gastos autorizados.
 * Finanzas tampoco tenía "compromisos financieros de deuda" como entidad (factoraje/interés/
 * amortización) — se agrega en `finance.*`. Compras tampoco tenía "cuenta por pagar a proveedor"
 * (RA.15 trackea unidades/costo pactado, no obligación con vencimiento negociable) — se agrega en
 * `commercial.*`, opcionalmente ligada a `purchase_orders`/`goods_receipts`.
 *
 * Las tres tablas comparten CONTRATO (montos + vencimientos + status + autorización NOT NULL) pero
 * viven separadas — cada una es dueña de su verdad, igual que Compras/Presupuestos/Finanzas son
 * responsables distintos (regla del pedido: "no permitas capturar obligaciones independientes
 * directamente en el calendario").
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime; FKs compuestas
 * (tenant_id, id) donde aplica. Idempotente (hasSchema/hasTable/hasColumn).
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
  // ⚠️ USAGE del schema + default privileges, igual que el patrón canónico
  // (20260526100001_commercial_customers_warehouses). Sin esto los GRANT de tabla de abajo son
  // inútiles: Postgres deniega el schema primero y el runtime tira `permission denied for schema
  // budget` (42501). Esta línea faltaba y rompió /api/finance/payment-calendar/* en prod
  // (2026-09-17); se repuso aquí para que un entorno fresco quede correcto de una sola pasada.
  await knex.raw(`GRANT USAGE ON SCHEMA budget TO app_runtime`);
  await knex.raw(`ALTER DEFAULT PRIVILEGES IN SCHEMA budget GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime`);

  // ── budget.daily_capacity — Presupuestos fija el tope de pago por fecha ──────────────
  if (!(await knex.schema.withSchema('budget').hasTable('daily_capacity'))) {
    await knex.raw(`
      CREATE TABLE budget.daily_capacity (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        capacity_date     date NOT NULL,
        authorized_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (authorized_amount >= 0),
        note              text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, capacity_date)
      )`);
    await knex.raw(`CREATE INDEX ix_budget_capacity_date ON budget.daily_capacity (tenant_id, capacity_date)`);
    await tenantRls(knex, 'budget', 'daily_capacity');
  }

  // ── budget.daily_capacity_history — auditoría de cada cambio (quién/cuándo/por qué) ──
  if (!(await knex.schema.withSchema('budget').hasTable('daily_capacity_history'))) {
    await knex.raw(`
      CREATE TABLE budget.daily_capacity_history (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        capacity_date     date NOT NULL,
        previous_amount   numeric(14,2),
        new_amount        numeric(14,2) NOT NULL,
        reason            text,
        changed_by        text,
        changed_at        timestamptz NOT NULL DEFAULT now()
      )`);
    await knex.raw(`CREATE INDEX ix_budget_capacity_hist_date ON budget.daily_capacity_history (tenant_id, capacity_date, changed_at)`);
    await tenantRls(knex, 'budget', 'daily_capacity_history');
  }

  // ── budget.expense_obligations — gastos autorizados (Presupuestos) ───────────────────
  if (!(await knex.schema.withSchema('budget').hasTable('expense_obligations'))) {
    await knex.raw(`
      CREATE TABLE budget.expense_obligations (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        concept           text NOT NULL,
        area              text,                       -- centro de costo / sucursal
        subtype           text CHECK (subtype IN ('luz','renta','sueldos','comisiones','operativo','otro')),
        beneficiary       text NOT NULL,
        original_amount   numeric(14,2) NOT NULL CHECK (original_amount > 0),
        reserved_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
        paid_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
        original_due_date date,
        negotiated_date   date,
        status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','cancelled')),
        is_critical       boolean NOT NULL DEFAULT false,
        critical_reason   text,
        authorized_by     text NOT NULL,
        authorized_at     timestamptz NOT NULL DEFAULT now(),
        notes             text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CHECK (reserved_amount + paid_amount <= original_amount)
      )`);
    await knex.raw(`CREATE INDEX ix_budget_expense_status ON budget.expense_obligations (tenant_id, status)`);
    await knex.raw(`CREATE INDEX ix_budget_expense_due ON budget.expense_obligations (tenant_id, original_due_date)`);
    await tenantRls(knex, 'budget', 'expense_obligations');
  }

  // ── catalog.suppliers.is_critical — flag MANUAL con motivo, nunca inferido por importe ──
  if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', 'is_critical'))) {
    await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN is_critical boolean NOT NULL DEFAULT false`);
  }
  if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', 'critical_reason'))) {
    await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN critical_reason text`);
  }

  // ── finance.financial_commitments — compromisos financieros de deuda (Finanzas) ─────
  if (!(await knex.schema.withSchema('finance').hasTable('financial_commitments'))) {
    await knex.raw(`
      CREATE TABLE finance.financial_commitments (
        id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         uuid NOT NULL,
        concept           text NOT NULL,
        subtype           text NOT NULL CHECK (subtype IN ('factoraje','interes','amortizacion','otro')),
        beneficiary       text NOT NULL,
        bank_account_id   uuid REFERENCES finance.bank_accounts(id) ON DELETE SET NULL,
        original_amount   numeric(14,2) NOT NULL CHECK (original_amount > 0),
        reserved_amount   numeric(14,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
        paid_amount       numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
        original_due_date date,
        negotiated_date   date,
        status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','cancelled')),
        is_critical       boolean NOT NULL DEFAULT false,
        critical_reason   text,
        authorized_by     text NOT NULL,
        authorized_at     timestamptz NOT NULL DEFAULT now(),
        notes             text,
        created_by        text,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_by        text,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CHECK (reserved_amount + paid_amount <= original_amount)
      )`);
    await knex.raw(`CREATE INDEX ix_fin_commitments_status ON finance.financial_commitments (tenant_id, status)`);
    await knex.raw(`CREATE INDEX ix_fin_commitments_due ON finance.financial_commitments (tenant_id, original_due_date)`);
    await tenantRls(knex, 'finance', 'financial_commitments');
  }

  // ── commercial.supplier_payment_obligations — proveedores de mercancía (Compras) ─────
  if (!(await knex.schema.withSchema('commercial').hasTable('supplier_payment_obligations'))) {
    await knex.raw(`
      CREATE TABLE commercial.supplier_payment_obligations (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          uuid NOT NULL,
        supplier_id        uuid NOT NULL,
        purchase_order_id  uuid,
        goods_receipt_id   uuid,
        invoice_folio      text,
        concept            text,
        original_amount    numeric(14,2) NOT NULL CHECK (original_amount > 0),
        reserved_amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
        paid_amount        numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
        original_due_date  date,
        negotiated_date    date,
        status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','partial','paid','cancelled')),
        authorized_by      text NOT NULL,
        authorized_at      timestamptz NOT NULL DEFAULT now(),
        notes              text,
        created_by         text,
        created_at         timestamptz NOT NULL DEFAULT now(),
        updated_by         text,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CHECK (reserved_amount + paid_amount <= original_amount),
        FOREIGN KEY (tenant_id, supplier_id)       REFERENCES catalog.suppliers            (tenant_id, id) ON DELETE RESTRICT,
        FOREIGN KEY (tenant_id, purchase_order_id) REFERENCES commercial.purchase_orders    (tenant_id, id) ON DELETE SET NULL,
        FOREIGN KEY (tenant_id, goods_receipt_id)  REFERENCES commercial.goods_receipts     (tenant_id, id) ON DELETE SET NULL,
        UNIQUE (tenant_id, id)
      )`);
    await knex.raw(`CREATE INDEX ix_spo_status ON commercial.supplier_payment_obligations (tenant_id, status)`);
    await knex.raw(`CREATE INDEX ix_spo_supplier ON commercial.supplier_payment_obligations (tenant_id, supplier_id)`);
    await knex.raw(`CREATE INDEX ix_spo_due ON commercial.supplier_payment_obligations (tenant_id, original_due_date)`);
    await tenantRls(knex, 'commercial', 'supplier_payment_obligations');
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('supplier_payment_obligations');
  await knex.schema.withSchema('finance').dropTableIfExists('financial_commitments');
  await knex.schema.withSchema('budget').dropTableIfExists('expense_obligations');
  await knex.schema.withSchema('budget').dropTableIfExists('daily_capacity_history');
  await knex.schema.withSchema('budget').dropTableIfExists('daily_capacity');
  // is_critical/critical_reason de catalog.suppliers: no se dropean (aditivas, seguras).
};
