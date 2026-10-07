/**
 * SM.2 — ledger de movimientos de inventario (Supervisor de Movimientos, Plano 1).
 * La alimenta `import-kardex.js` (lee md.kdij de las sucursales Kepler). Enfocado
 * en movimientos de INVENTARIO (género N: ajustes/mermas/traspasos/inv.físico) —
 * las ventas (U) y compras (X) ya viven en analytics.sales_daily / otros feeds.
 * Es la fuente del detector P1: mermas/ajustes de salida grandes.
 *
 * clase_mov (derivada de género/naturaleza/grupo vía kdmm):
 *   merma            = N/D grupo 5  (salida por ajuste/destrucción)
 *   traspaso_salida  = N/D grupo 6,25 · traspaso_entrada = N/A grupo 6,25
 *   ajuste_entrada   = N/A grupo 20 · inv_fisico = N/A grupo 30-45 · otro = resto
 *
 * analytics.* = sin RLS, filtro tenant_id EXPLÍCITO. Aditiva, idempotente.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('stock_ledger')) return;
  await knex.raw(`
    CREATE TABLE analytics.stock_ledger (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id      uuid NOT NULL,
      warehouse_code text NOT NULL,        -- sucursal (kdij.c1)
      almacen        text,                 -- almacén interno (c19, ej. ALM-40)
      sku            text NOT NULL,        -- c3
      genero         text NOT NULL,        -- c4 (N)
      naturaleza     text NOT NULL,        -- c5 (D/A)
      grupo          text,                 -- c6
      clase_mov      text NOT NULL,        -- derivada (merma/traspaso_*/ajuste_entrada/inv_fisico/otro)
      folio          text NOT NULL,        -- c8
      unidades       numeric NOT NULL DEFAULT 0,  -- c9
      unidad         text,                 -- c12
      importe        numeric NOT NULL DEFAULT 0,  -- c13/c21 (valor a costo)
      fecha          date NOT NULL,        -- c10
      source         text NOT NULL DEFAULT 'kepler',
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_ledger ON analytics.stock_ledger (tenant_id, warehouse_code, folio, genero, naturaleza, grupo, sku)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stock_ledger_clase ON analytics.stock_ledger (tenant_id, clase_mov, fecha DESC)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stock_ledger_sku ON analytics.stock_ledger (tenant_id, warehouse_code, sku)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON analytics.stock_ledger TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('stock_ledger');
};
