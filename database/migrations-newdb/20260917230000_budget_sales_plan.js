/**
 * Fase PV.3 — Modelo del Presupuesto de Ventas: `budget.sales_plan_lines`.
 *
 * La meta de ventas vive en Presupuestos (decisión de negocio: "partidas ingreso"), al grano
 * del molde del Excel: ENTIDAD (PV.2, `v_sales_entity.entity_key`) × PERIODO 13×4 (PV.1, 1..13).
 * Es una sub-tabla del ejercicio (`budget.budgets`): 23 entidades × 13 periodos = hasta 299
 * filas por ejercicio. El detalle semanal/trimestral y los rollups (por sucursal, TOTAL VEC,
 * RD, Total Venta) son AGREGACIONES sobre estas filas — no se materializan.
 *
 * Dato PROPIO capturado (HITL) → tabla real legítima (no derivable del ODS). El "real" con el
 * que se compara SÍ sale del ODS (PV.4). Método de captura (spec §4):
 *   · historico_ajustado: meta = real del año anterior (rolado por PV.1/PV.2) × (1 + growth_pct).
 *     base_amount = ese real. Si NO hay real del año anterior (la data viva arranca ~fin 2025),
 *     NO se fabrica meta: simplemente no se crea la fila → la UI la declara "sin base histórica"
 *     y el usuario la captura a mano («sin datos» ≠ cero).
 *   · manual: captura/override directo.
 *
 * Patrón MT del proyecto: FK compuesta (tenant_id, budget_id) → budget.budgets, RLS forzado,
 * audit, grant app_runtime, idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (await knex.schema.withSchema('budget').hasTable('sales_plan_lines')) return;

  await knex.schema.withSchema('budget').createTable('sales_plan_lines', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('budget_id').notNullable();
    t.string('entity_key', 64).notNullable();       // v_sales_entity.entity_key (channel:warehouse_code)
    t.smallint('period_no').notNullable();          // 1..13 (calendario 13×4)
    t.decimal('meta_amount', 16, 2).notNullable().defaultTo(0);
    t.string('method', 24).notNullable().defaultTo('manual'); // historico_ajustado | manual
    t.decimal('growth_pct', 7, 4).nullable();       // objetivo de crecimiento aplicado (0.10 = +10%)
    t.decimal('base_amount', 16, 2).nullable();     // real año anterior usado como base (NULL = sin base)
    t.text('notes').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('created_by').nullable();
    t.text('updated_by').nullable();

    t.primary('id');
    t.unique(['tenant_id', 'budget_id', 'entity_key', 'period_no'], { indexName: 'budget_sales_plan_natural_unique' });
    t.check('?? between 1 and 13', ['period_no'], 'budget_sales_plan_period_valid');
    t.check(`?? in ('historico_ajustado','manual')`, ['method'], 'budget_sales_plan_method_valid');
    t.index(['tenant_id', 'budget_id'], 'idx_budget_sales_plan_budget');
  });

  await knex.raw(`
    ALTER TABLE budget.sales_plan_lines
      ADD CONSTRAINT fk_budget_sales_plan_budget
      FOREIGN KEY (tenant_id, budget_id) REFERENCES budget.budgets (tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE budget.sales_plan_lines ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE budget.sales_plan_lines FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON budget.sales_plan_lines`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON budget.sales_plan_lines
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget.sales_plan_lines TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE budget.sales_plan_lines IS
    'PV.3 — Meta del Presupuesto de Ventas por entidad (v_sales_entity) × periodo 13×4. Dato propio (HITL); el real se compara por vista sobre el ODS (PV.4). method historico_ajustado (meta = real año anterior × (1+growth), base_amount = ese real) | manual. Sin base histórica → no se crea fila (sin datos ≠ cero).'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('budget').dropTableIfExists('sales_plan_lines');
};
