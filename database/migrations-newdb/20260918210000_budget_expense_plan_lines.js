/**
 * Fase PVG.2 — Rejilla de PROPUESTA del presupuesto de gastos: `budget.expense_plan_lines`.
 *
 * Capa de PROPUESTA (re-ejecutable, idempotente, overwrite-safe) — separada del libro mayor de 5 estados
 * `budget.budget_lines` (que lleva reserva/compromiso/ejercido y NO se pisa a ciegas). El motor la llena
 * desde los egresos de Kepler; el humano la revisa/ajusta; una materialización posterior (declarada, no
 * en este sprint) crea las partidas en `budget_lines`. Grano: cuenta mayor × sucursal × mes.
 *
 * Columnas:
 *   · account_code / account_name  cuenta mayor (p.ej. '610' Nómina) — el eje del presupuesto de gastos.
 *   · familia                      familia Kepler ('6' gasto, etc.) de la que salió la propuesta.
 *   · sucursal                     '' = consolidado (by_sucursal=false); código de sucursal si es por plaza.
 *   · year_month                   'YYYY-MM' dentro del ejercicio.
 *   · monto                        gasto presupuestado del mes (MXN).
 *   · method                       'historico_ajustado' (base real del mes × (1+crec)) | 'estacional'
 *                                  (promedio mensual del año × (1+crec) donde falta el mes) | 'manual'.
 *   · growth_pct / base_amount     trazabilidad de la propuesta (crecimiento aplicado, base histórica).
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  if (await knex.schema.withSchema('budget').hasTable('expense_plan_lines')) return;

  await knex.schema.withSchema('budget').createTable('expense_plan_lines', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('budget_id').notNullable();
    t.text('account_code').notNullable();
    t.text('account_name').nullable();
    t.string('familia', 4).nullable();
    t.text('sucursal').notNullable().defaultTo('');
    t.string('year_month', 7).notNullable();
    t.decimal('monto', 14, 2).notNullable().defaultTo(0);
    t.string('method', 20).notNullable().defaultTo('manual');
    t.decimal('growth_pct', 7, 4).nullable();
    t.decimal('base_amount', 14, 2).nullable();
    t.text('notes').nullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.text('created_by').nullable();
    t.text('updated_by').nullable();

    t.primary('id');
    t.unique(['tenant_id', 'budget_id', 'account_code', 'sucursal', 'year_month'], { indexName: 'budget_expense_plan_lines_natural_unique' });
    t.index(['tenant_id', 'budget_id'], 'budget_expense_plan_lines_budget_idx');
    t.check(`?? >= 0`, ['monto'], 'budget_expense_plan_lines_monto_nonneg');
    t.check(`?? in ('historico_ajustado','estacional','manual')`, ['method'], 'budget_expense_plan_lines_method_valid');
    t.check(`?? ~ '^[0-9]{4}-[0-9]{2}$'`, ['year_month'], 'budget_expense_plan_lines_ym_valid');
  });

  await knex.raw(`
    ALTER TABLE budget.expense_plan_lines
      ADD CONSTRAINT fk_budget_expense_plan_lines_budget
      FOREIGN KEY (tenant_id, budget_id) REFERENCES budget.budgets (tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE budget.expense_plan_lines ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE budget.expense_plan_lines FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON budget.expense_plan_lines`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON budget.expense_plan_lines
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON budget.expense_plan_lines TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE budget.expense_plan_lines IS
    'PVG.2 — Rejilla de PROPUESTA del presupuesto de gastos (cuenta mayor × sucursal × mes). Capa de propuesta re-ejecutable (no es el libro mayor de 5 estados budget_lines). method historico_ajustado|estacional|manual; nunca se pisa lo manual salvo overwrite. La materialización a budget_lines es un paso posterior declarado.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('budget').dropTableIfExists('expense_plan_lines');
};
