/**
 * ÍNDICES CUBRIDORES para /tienda/analisis-semanal (store-analytics: weekly() + range()).
 *
 * DIAGNÓSTICO (medido contra prod 2026-09-10, EXPLAIN ANALYZE): la pantalla tardaba ~27s. Causa =
 * seq scan completo en las dos tablas de hecho, porque NINGÚN índice cubre las columnas que se suman:
 *   - analytics.sales_daily (3.1 GB / 4.5M filas): existe ix_sales_daily_date (tenant_id, sale_date)
 *     pero NO incluye revenue/margin/units → el planner elige Parallel Seq Scan (index scan + heap
 *     fetch por fila le sale más caro). ~4.5s repartidos en 4 queries (KPIs, serie, sucursal, productos).
 *   - analytics.product_sales_daily (1.1 GB): su único índice útil es uq_psd (tenant_id, product_id,
 *     warehouse_id, sale_date) — sale_date va 4ª, inservible para filtrar por fecha → seq scan. ~6.5s.
 *
 * FIX: un índice cubridor por tabla, clave (tenant_id, sale_date) + INCLUDE de las medidas + las FK
 * que la pantalla agrupa/junta (warehouse_id, product_id). Convierte el seq scan de GBs en un
 * index-only scan de sólo la ventana de fechas. Esperado: ~11s → sub-segundo en esas 5 queries.
 *
 * NO cambia ningún número (es transparente al código) — es puro rendimiento, legítimo (GOTCHAS §19).
 * La 6ª query lenta (tickets Wincaja, cast fecha::date que anula su índice) es un FIX DE CÓDIGO
 * aparte, no un índice — queda fuera de esta migración.
 *
 * ⚠️ CONCURRENTLY: no puede correr dentro de transacción → exports.config.transaction=false. No toma
 * lock exclusivo (sólo ShareUpdateExclusive breve) → NO bloquea al importer nocturno de estas tablas.
 * Idempotente: IF NOT EXISTS. Si una corrida previa dejó el índice INVALID, se dropea y se recrea.
 *
 * @param { import("knex").Knex } knex
 */
exports.config = { transaction: false };

const INDEXES = [
  {
    name: 'ix_sales_daily_cover',
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_sales_daily_cover
            ON analytics.sales_daily (tenant_id, sale_date)
            INCLUDE (warehouse_id, product_id, revenue, margin, units)`,
  },
  {
    name: 'ix_psd_date_cover',
    ddl: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_psd_date_cover
            ON analytics.product_sales_daily (tenant_id, sale_date)
            INCLUDE (warehouse_id, units)`,
  },
];

exports.up = async function (knex) {
  for (const ix of INDEXES) {
    // Limpia un intento previo fallido (índice INVALID) antes de recrear.
    const invalid = (await knex.raw(
      `SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = ? AND i.indisvalid = false`, [ix.name])).rows.length;
    if (invalid) {
      console.log(`  ${ix.name} estaba INVALID → DROP CONCURRENTLY antes de recrear.`);
      await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${ix.name}`);
    }
    await knex.raw(ix.ddl);
    console.log(`  ${ix.name} listo (index-only scan para /tienda/analisis-semanal).`);
  }
};

exports.down = async function (knex) {
  for (const ix of INDEXES) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS analytics.${ix.name}`);
  }
};
