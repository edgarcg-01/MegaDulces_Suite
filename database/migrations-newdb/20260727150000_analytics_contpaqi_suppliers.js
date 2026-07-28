/**
 * CP.3 (Fase CP, ADR-040) — Catálogo de proveedores de ContPAQi → analytics.contpaqi_suppliers.
 *
 * Los proveedores de la CONTABILIDAD (ContPAQi `Proveedores`, con RFC + config de retención)
 * para cruzarlos contra la lista negra del SAT (`fiscal.sat_list_rfcs`, EFOS 69-B / 69) → riesgo
 * fiscal / materialidad sobre los proveedores REALES de los libros. Complementa el bridge fiscal
 * que ya cruza los proveedores de Kepler (expense_documents): esta es la vista del contador.
 *
 * La puebla `database/importers/contpaqi/import-contpaqi-suppliers.js`. Aditiva, idempotente,
 * schema analytics, sin RLS (filtro de tenant explícito, igual que el resto de analytics.*).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);

  if (!(await knex.schema.withSchema('analytics').hasTable('contpaqi_suppliers'))) {
    await knex.raw(`
      CREATE TABLE analytics.contpaqi_suppliers (
        tenant_id       uuid NOT NULL,
        codigo          text NOT NULL,          -- Proveedores.Codigo
        nombre          text,
        rfc             text,
        tipo_tercero    int,                    -- clasificación fiscal ContPAQi
        retencion_iva   numeric,
        retencion_isr   numeric,
        computed_at     timestamptz DEFAULT now(),
        PRIMARY KEY (tenant_id, codigo)
      )`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_cpq_sup_rfc ON analytics.contpaqi_suppliers (tenant_id, rfc)`);
    await knex.raw(`GRANT SELECT ON analytics.contpaqi_suppliers TO app_runtime`);
  }
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('contpaqi_suppliers');
};
