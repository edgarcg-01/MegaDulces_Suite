/**
 * J.11.2 — logistics.payroll_adjustments: audit trail individual de
 * anticipos / préstamos / multas / faltas / bonos por colaborador y período.
 *
 * `liquidations.bonuses` y `liquidations.deductions` quedan como totales
 * agregados (cache); los detalles individuales viven acá.
 *
 * Mismo patrón de RLS forzado que el resto de logistics.* (policy USING
 * tenant_id = current_tenant_id(), grant a app_runtime).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('logistics').hasTable('payroll_adjustments');
  if (!exists) {
    await knex.schema.withSchema('logistics').createTable('payroll_adjustments', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.uuid('driver_id').notNullable();
      t.uuid('period_id').notNullable();
      t.string('type', 20).notNullable();
      t.decimal('amount', 12, 2).notNullable();
      t.date('date').notNullable();
      t.text('notes');
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');

      t.foreign(['tenant_id', 'driver_id'])
        .references(['tenant_id', 'id']).inTable('logistics.drivers');
      t.foreign(['tenant_id', 'period_id'])
        .references(['tenant_id', 'id']).inTable('logistics.payroll_periods');

      t.index(['tenant_id', 'driver_id', 'period_id'], 'idx_payroll_adj_driver_period');
      t.index(['tenant_id', 'period_id'], 'idx_payroll_adj_period');
    });

    await knex.raw(`
      ALTER TABLE logistics.payroll_adjustments
      ADD CONSTRAINT payroll_adjustments_type_check
      CHECK (type IN ('anticipo','prestamo','multa','falta','bono'))
    `);
    await knex.raw(`
      ALTER TABLE logistics.payroll_adjustments
      ADD CONSTRAINT payroll_adjustments_amount_positive
      CHECK (amount > 0)
    `);

    await knex.raw(`ALTER TABLE logistics.payroll_adjustments ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE logistics.payroll_adjustments FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON logistics.payroll_adjustments
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON logistics.payroll_adjustments TO app_runtime`);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('logistics').dropTableIfExists('payroll_adjustments');
};
