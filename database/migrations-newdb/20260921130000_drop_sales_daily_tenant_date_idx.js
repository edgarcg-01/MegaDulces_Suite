/**
 * REVERSIÓN de `20260921120000_sales_daily_tenant_date_idx` — medición desmintió la hipótesis.
 *
 * Se creó `ix_sales_daily_tenant_date (tenant_id, sale_date)` para acelerar la agregación del bloque
 * «real» del resumen de Presupuestos. Medido en PROD (3.0M filas, 2000→2026): el filtro por año NO es
 * selectivo para el tenant principal (2026 ≈ 1.48M filas ≈ 49% de la tabla), así que el planner elige
 * un Index Scan con ~1.5M lecturas aleatorias al heap → 40s (PEOR que el Parallel Seq Scan de ~29s).
 * Un índice sobre un rango no selectivo perjudica. El gate de <1s ya lo cubre DIFERIR el bloque ODS del
 * summary (opt-in ?real=1). Una cifra «real» rápida es un rollup mensual (analytics.sales_monthly) —
 * fase de perf declarada, no un índice.
 *
 * No se edita ni borra la migración de creación (regla dura: knex valida FS vs knex_migrations). Esta
 * migración la revierte. En prod ya se dropeó a mano con DROP INDEX CONCURRENTLY (sin lock); este `up`
 * (DROP IF EXISTS no-concurrente) queda no-op. Idempotente.
 * @param { import("knex").Knex } knex
 */

exports.up = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS analytics.ix_sales_daily_tenant_date`);
};

exports.down = async function (knex) {
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_daily_tenant_date
    ON analytics.sales_daily (tenant_id, sale_date)`);
};
