/**
 * RA-PRO.1 + RA-PRO.2 — Reabastecimiento profesional: safety stock por NIVEL DE
 * SERVICIO + segmentación ABC-XYZ. Ver FASE_RA_BENCHMARK_ENTERPRISE.md.
 *
 * Eleva el reorden de "días de cobertura fijos" (heurístico) a la fórmula estándar
 * de la industria:
 *   safety_stock  = Z(service_level) × σ_demanda_diaria × √lead_time
 *   reorder_point = avg_daily × lead_time + safety_stock
 * y clasifica cada producto×almacén por variabilidad de demanda (XYZ) sobre el ABC
 * que ya calcula la Fase ABC:
 *   demand_cv = σ/μ   →   X ≤ 0.5 (estable) · Y ≤ 1.0 (variable) · Z > 1.0 (errático)
 *
 * Dos bloques aditivos idempotentes (solo columnas):
 *   analytics.inventory_health  += stddev_daily_units, demand_cv, xyz_class
 *       (la dispersión de demanda se computa donde ya vive avg_daily_units)
 *   commercial.reorder_policy   += service_level, abc_class, xyz_class, demand_cv, policy_method
 *       (snapshot legible para el UI de Compras; safety_stock/lead_time_days ya existían)
 *
 * @param { import("knex").Knex } knex
 */

async function addCol(knex, schema, table, col, ddl) {
  if (!(await knex.schema.withSchema(schema).hasColumn(table, col))) {
    await knex.raw(`ALTER TABLE ${schema}.${table} ADD COLUMN ${ddl}`);
  }
}

exports.up = async function (knex) {
  // ── analytics.inventory_health: dispersión de demanda ─────────────────
  await addCol(knex, 'analytics', 'inventory_health', 'stddev_daily_units', 'stddev_daily_units numeric');
  await addCol(knex, 'analytics', 'inventory_health', 'demand_cv', 'demand_cv numeric');
  await addCol(knex, 'analytics', 'inventory_health', 'xyz_class', "xyz_class char(1)");
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_invhealth_xyz') THEN
        ALTER TABLE analytics.inventory_health
          ADD CONSTRAINT chk_invhealth_xyz CHECK (xyz_class IS NULL OR xyz_class IN ('X','Y','Z'));
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON COLUMN analytics.inventory_health.demand_cv IS 'Coeficiente de variación σ/μ de la venta diaria (90d, incluye días cero). Base de la clase XYZ.'`);

  // ── commercial.reorder_policy: política por nivel de servicio ──────────
  await addCol(knex, 'commercial', 'reorder_policy', 'service_level', 'service_level numeric(4,3)');
  await addCol(knex, 'commercial', 'reorder_policy', 'abc_class', "abc_class char(1)");
  await addCol(knex, 'commercial', 'reorder_policy', 'xyz_class', "xyz_class char(1)");
  await addCol(knex, 'commercial', 'reorder_policy', 'demand_cv', 'demand_cv numeric');
  await addCol(knex, 'commercial', 'reorder_policy', 'policy_method', "policy_method varchar(16)");
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_reorder_policy_method') THEN
        ALTER TABLE commercial.reorder_policy
          ADD CONSTRAINT chk_reorder_policy_method
          CHECK (policy_method IS NULL OR policy_method IN ('days_cover','service_level'));
      END IF;
    END $$`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_reorder_policy_abcxyz') THEN
        ALTER TABLE commercial.reorder_policy
          ADD CONSTRAINT chk_reorder_policy_abcxyz
          CHECK ((abc_class IS NULL OR abc_class IN ('A','B','C'))
             AND (xyz_class IS NULL OR xyz_class IN ('X','Y','Z')));
      END IF;
    END $$`);
  await knex.raw(`COMMENT ON COLUMN commercial.reorder_policy.service_level IS 'RA-PRO.1 — nivel de servicio objetivo (0..1) usado para el safety stock. Default por clase ABC.'`);
  await knex.raw(`COMMENT ON COLUMN commercial.reorder_policy.policy_method IS 'RA-PRO.1 — cómo se derivó: service_level (Z×σ×√LT) | days_cover (heurístico legacy).'`);
};

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.reorder_policy DROP CONSTRAINT IF EXISTS chk_reorder_policy_abcxyz`);
  await knex.raw(`ALTER TABLE commercial.reorder_policy DROP CONSTRAINT IF EXISTS chk_reorder_policy_method`);
  for (const c of ['service_level', 'abc_class', 'xyz_class', 'demand_cv', 'policy_method']) {
    if (await knex.schema.withSchema('commercial').hasColumn('reorder_policy', c)) {
      await knex.raw(`ALTER TABLE commercial.reorder_policy DROP COLUMN ${c}`);
    }
  }
  await knex.raw(`ALTER TABLE analytics.inventory_health DROP CONSTRAINT IF EXISTS chk_invhealth_xyz`);
  for (const c of ['stddev_daily_units', 'demand_cv', 'xyz_class']) {
    if (await knex.schema.withSchema('analytics').hasColumn('inventory_health', c)) {
      await knex.raw(`ALTER TABLE analytics.inventory_health DROP COLUMN ${c}`);
    }
  }
};
