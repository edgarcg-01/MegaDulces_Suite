/**
 * Fase LM.0 (M5) — corte de caja del repartidor (§11–12 del SOP).
 *
 * commercial.rider_liquidations           — 1 corte por (repartidor, día).
 * commercial.rider_liquidation_sequences  — counter atómico para folio LIQ-YYYY-NNNNN.
 *
 * Distinta de logistics.liquidations (esa = nómina/comisiones). Esta es el
 * CUADRE DE EFECTIVO: qué cobró el repartidor vs qué entregó, con ARQUEO por
 * denominación (cash_breakdown JSONB). El encargado cierra el corte.
 *
 * cash_expected  = suma de cobros efectivo esperados del día.
 * cash_counted   = efectivo entregado (derivado del arqueo).
 * cash_breakdown = {"1000":n,"500":n,...} conteo por denominación MXN.
 * cash_difference= counted - expected (meta 0; ≠0 se documenta en notes).
 * card_total / transfer_total = no-efectivo (tarjeta solo registro).
 *
 * Sucursal = branch_store_id (FK a public.stores; decisión ADR-027: sucursal
 * es store dentro del tenant, no tenant propio).
 *
 * FK payments.liquidation_id → rider_liquidations (cablea el pago al corte).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── sequences (folio atómico por tenant+año) ─────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('rider_liquidation_sequences'))) {
    await knex.schema.withSchema('commercial').createTable('rider_liquidation_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('year').notNullable();
      t.integer('current_value').notNullable().defaultTo(0);
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'year']);
      t.check('?? >= 0', ['current_value'], 'commercial_rider_liq_seq_nonneg');
    });
    await knex.raw(`
      ALTER TABLE commercial.rider_liquidation_sequences
        ADD CONSTRAINT fk_commercial_rider_liq_seq_tenant
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE
    `);
  }

  // ── rider_liquidations ───────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('rider_liquidations'))) {
    await knex.schema.withSchema('commercial').createTable('rider_liquidations', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('rider_user_id').notNullable();
      t.uuid('branch_store_id');
      t.date('business_date').notNullable();
      t.string('folio', 40);
      t.integer('deliveries_count').notNullable().defaultTo(0);
      t.decimal('cash_expected', 14, 2).notNullable().defaultTo(0);
      t.decimal('cash_counted', 14, 2);
      t.jsonb('cash_breakdown'); // arqueo por denominación
      t.decimal('cash_difference', 14, 2);
      t.decimal('transfer_total', 14, 2).notNullable().defaultTo(0);
      t.decimal('card_total', 14, 2).notNullable().defaultTo(0);
      t.integer('incidents_count').notNullable().defaultTo(0);
      t.string('status', 20).notNullable().defaultTo('open');
      t.uuid('closed_by');
      t.timestamp('closed_at');
      t.text('notes');
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.timestamp('deleted_at');
      t.uuid('deleted_by');

      t.primary('id');
      t.unique(['tenant_id', 'id'], { indexName: 'commercial_rider_liq_tenant_id_composite' });
      t.check(`?? IN ('open', 'closed', 'reconciled')`, ['status'], 'commercial_rider_liq_status_valid');

      t.index(['tenant_id', 'rider_user_id', 'business_date'], 'idx_commercial_rider_liq_rider_date');
      t.index(['tenant_id', 'business_date'], 'idx_commercial_rider_liq_date');
      t.index(['tenant_id', 'branch_store_id'], 'idx_commercial_rider_liq_branch');
    });

    // Un corte abierto por (repartidor, día) — parcial anti-duplicado.
    await knex.raw(`
      CREATE UNIQUE INDEX commercial_rider_liq_one_per_rider_day
        ON commercial.rider_liquidations (tenant_id, rider_user_id, business_date)
        WHERE deleted_at IS NULL
    `);

    await knex.raw(`
      ALTER TABLE commercial.rider_liquidations
        ADD CONSTRAINT fk_commercial_rider_liq_tenant
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE RESTRICT
    `);
    await knex.raw(`
      ALTER TABLE commercial.rider_liquidations
        ADD CONSTRAINT fk_commercial_rider_liq_rider
        FOREIGN KEY (tenant_id, rider_user_id)
        REFERENCES public.users(tenant_id, id) ON DELETE RESTRICT
    `);
  }

  // ── RLS + grants ─────────────────────────────────────────────────────────
  for (const t of ['commercial.rider_liquidations', 'commercial.rider_liquidation_sequences']) {
    await knex.raw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${t}`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON ${t}
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
  }
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.rider_liquidations, commercial.rider_liquidation_sequences TO app_runtime');

  // ── FK payments.liquidation_id → rider_liquidations (columna creada en M3) ─
  if (await knex.schema.hasColumn('commercial.payments', 'liquidation_id')) {
    await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS fk_commercial_payments_liquidation`);
    await knex.raw(`
      ALTER TABLE commercial.payments
        ADD CONSTRAINT fk_commercial_payments_liquidation
        FOREIGN KEY (tenant_id, liquidation_id)
        REFERENCES commercial.rider_liquidations(tenant_id, id) ON DELETE SET NULL
    `);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_commercial_payments_liquidation
        ON commercial.payments (tenant_id, liquidation_id)
    `);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS fk_commercial_payments_liquidation`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.idx_commercial_payments_liquidation`);
  await knex.schema.withSchema('commercial').dropTableIfExists('rider_liquidations');
  await knex.schema.withSchema('commercial').dropTableIfExists('rider_liquidation_sequences');
};
