/**
 * Fase PVG.1 — Supuestos anuales del Presupuesto de GASTOS: `budget.expense_plan_settings`.
 *
 * El presupuesto de gastos se AUTO-PROPONE desde los egresos de Kepler (`analytics.expense_entries`),
 * al grano contable natural: la CUENTA MAYOR (siempre poblada; `dpto`/`concepto` son ralos). El humano
 * sólo ajusta las perillas de acá. Análogo a `budget.sales_plan_settings` (PVA).
 *
 * Columnas:
 *   · proposal_families  JSONB de familias Kepler a incluir. Default ["6"] (gasto operativo). 5=compras
 *                        (dominio de RA), 1=inversión (capex), 7=financieros — disponibles, off por default.
 *   · default_growth_pct crecimiento de respaldo (fracción, 0.10 = +10%) cuando una cuenta no tiene tendencia.
 *   · growth_by_account  JSONB {cuenta_mayor → fracción} — el objetivo de crecimiento por cuenta, editable.
 *   · by_sucursal        false = presupuesto consolidado (una partida por cuenta); true = por sucursal.
 *   · control_level      control por default de las partidas materializadas (informativo|advertencia|bloqueo).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (await knex.schema.withSchema('budget').hasTable('expense_plan_settings')) return;

  await knex.schema.withSchema('budget').createTable('expense_plan_settings', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('budget_id').notNullable();
    t.jsonb('proposal_families').notNullable().defaultTo('["6"]');
    t.decimal('default_growth_pct', 7, 4).notNullable().defaultTo(0);
    t.jsonb('growth_by_account').notNullable().defaultTo('{}');
    t.boolean('by_sucursal').notNullable().defaultTo(false);
    t.string('control_level', 16).notNullable().defaultTo('advertencia');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('created_by').nullable();
    t.text('updated_by').nullable();

    t.primary('id');
    t.unique(['tenant_id', 'budget_id'], { indexName: 'budget_expense_plan_settings_natural_unique' });
    t.check(`?? in ('informativo','advertencia','bloqueo')`, ['control_level'], 'budget_expense_plan_settings_control_valid');
  });

  await knex.raw(`
    ALTER TABLE budget.expense_plan_settings
      ADD CONSTRAINT fk_budget_expense_plan_settings_budget
      FOREIGN KEY (tenant_id, budget_id) REFERENCES budget.budgets (tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE budget.expense_plan_settings ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE budget.expense_plan_settings FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON budget.expense_plan_settings`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON budget.expense_plan_settings
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget.expense_plan_settings TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE budget.expense_plan_settings IS
    'PVG.1 — Supuestos anuales del presupuesto de gastos (una fila por ejercicio). proposal_families = familias Kepler a incluir (default ["6"] gasto operativo); growth_by_account = objetivo por cuenta mayor (el sistema lo propone del histórico, el humano ajusta); by_sucursal = consolidado vs por sucursal; control_level = default de las partidas. Análogo a sales_plan_settings.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('budget').dropTableIfExists('expense_plan_settings');
};
