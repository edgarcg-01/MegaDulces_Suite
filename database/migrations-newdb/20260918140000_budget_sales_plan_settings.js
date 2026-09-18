/**
 * Fase PVA.1 — Supuestos anuales del Presupuesto de Ventas: `budget.sales_plan_settings`.
 *
 * La ÚNICA perilla que el humano toca al automatizar el armado: el crecimiento objetivo por canal
 * (el sistema lo PROPONE desde la tendencia histórica; el humano lo ajusta). Una fila por ejercicio.
 * Patrón `commercial.replenishment_settings` (parámetros que antes iban hardcodeados) + patrón MT del
 * proyecto (FK compuesta a budget.budgets, RLS forzado, audit, idempotente).
 *
 * Columnas:
 *   · proposal_method   'hibrido' (base×crecimiento donde hay real + PART/estacionalidad donde no) | 'historico'
 *                       (solo base×crecimiento, comportamiento plano previo).
 *   · default_growth_pct crecimiento de respaldo (fracción, 0.10 = +10%) cuando un canal no tiene tendencia.
 *   · growth_by_channel  JSONB {mostrador,credito,ruta,preventa → fracción} — el objetivo por canal, editable.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (await knex.schema.withSchema('budget').hasTable('sales_plan_settings')) return;

  await knex.schema.withSchema('budget').createTable('sales_plan_settings', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('budget_id').notNullable();
    t.string('proposal_method', 16).notNullable().defaultTo('hibrido');
    t.decimal('default_growth_pct', 7, 4).notNullable().defaultTo(0);
    t.jsonb('growth_by_channel').notNullable().defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('created_by').nullable();
    t.text('updated_by').nullable();

    t.primary('id');
    t.unique(['tenant_id', 'budget_id'], { indexName: 'budget_sales_plan_settings_natural_unique' });
    t.check(`?? in ('hibrido','historico')`, ['proposal_method'], 'budget_sales_plan_settings_method_valid');
  });

  await knex.raw(`
    ALTER TABLE budget.sales_plan_settings
      ADD CONSTRAINT fk_budget_sales_plan_settings_budget
      FOREIGN KEY (tenant_id, budget_id) REFERENCES budget.budgets (tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE budget.sales_plan_settings ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE budget.sales_plan_settings FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON budget.sales_plan_settings`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON budget.sales_plan_settings
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget.sales_plan_settings TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE budget.sales_plan_settings IS
    'PVA.1 — Supuestos anuales del presupuesto de ventas (una fila por ejercicio). growth_by_channel = objetivo de crecimiento por canal (el sistema lo propone del histórico, el humano lo ajusta); proposal_method hibrido|historico; default_growth_pct = respaldo. Patrón replenishment_settings, degrada a defaults si falta.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('budget').dropTableIfExists('sales_plan_settings');
};
