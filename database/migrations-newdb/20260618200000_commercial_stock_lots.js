/**
 * Fase P2.0 (FEFO / caducidad) — sub-ledger de lotes ADITIVO. Ver ADR-022.
 *
 * `commercial.stock_lots` descompone el total de `commercial.stock` por
 * (lote, fecha de caducidad). `commercial.stock` SIGUE siendo el total
 * autoritativo; invariante:
 *     SUM(stock_lots.quantity)          por (tenant,wh,product) = stock.quantity
 *     SUM(stock_lots.reserved_quantity) por (tenant,wh,product) = stock.reserved_quantity
 *
 * Así el order flow / conteo físico / portal NO se reescriben; FEFO (consumir el
 * lote que vence primero) se capa encima en fases siguientes.
 *
 * Backfill: 1 lote 'NA' (sin caducidad) por cada fila de `commercial.stock`, con
 * su quantity/reserved actuales → el invariante se cumple desde el día 1. Los
 * lotes reales con fecha se capturan en recepción (P2.1).
 *
 * Aditivo e idempotente (guard hasTable). RLS forzado + grant app_runtime.
 * FKs compuestas a tablas REALES (identity.tenants, commercial.warehouses,
 * catalog.products) — public.* son vistas, no FK-ables.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('commercial').hasTable('stock_lots')) return;

  await knex.schema.withSchema('commercial').createTable('stock_lots', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('warehouse_id').notNullable();
    t.uuid('product_id').notNullable();
    t.string('lot_code', 60).notNullable().defaultTo('NA'); // 'NA' = sin lote
    t.date('expiry_date'); // null = no caduca / desconocida
    t.decimal('quantity', 14, 3).notNullable().defaultTo(0);
    t.decimal('reserved_quantity', 14, 3).notNullable().defaultTo(0);
    t.timestamp('received_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.uuid('updated_by');

    t.primary('id');
    t.unique(['tenant_id', 'id'], { indexName: 'commercial_stock_lots_tenant_id_composite' });

    t.check('?? >= 0', ['quantity'], 'commercial_stock_lots_quantity_nonneg');
    t.check('?? >= 0', ['reserved_quantity'], 'commercial_stock_lots_reserved_nonneg');
    t.check('?? >= ??', ['quantity', 'reserved_quantity'], 'commercial_stock_lots_qty_ge_reserved');

    t.index(['tenant_id', 'warehouse_id', 'product_id'], 'idx_commercial_stock_lots_whp');
    // FEFO: dado (tenant,wh,product), ordenar por caducidad ascendente (null al final).
    t.index(['tenant_id', 'warehouse_id', 'product_id', 'expiry_date'], 'idx_commercial_stock_lots_fefo');
  });

  // Clave natural única — NULLS NOT DISTINCT (PG15+) para que un solo lote 'NA'
  // con expiry NULL exista por (tenant,wh,product,lote).
  await knex.raw(`
    CREATE UNIQUE INDEX commercial_stock_lots_natural_unique
      ON commercial.stock_lots (tenant_id, warehouse_id, product_id, lot_code, expiry_date)
      NULLS NOT DISTINCT
  `);

  await knex.raw(`
    ALTER TABLE commercial.stock_lots
      ADD CONSTRAINT fk_commercial_stock_lots_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock_lots
      ADD CONSTRAINT fk_commercial_stock_lots_warehouse
      FOREIGN KEY (tenant_id, warehouse_id)
      REFERENCES commercial.warehouses(tenant_id, id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.stock_lots
      ADD CONSTRAINT fk_commercial_stock_lots_product
      FOREIGN KEY (tenant_id, product_id)
      REFERENCES catalog.products(tenant_id, id) ON DELETE RESTRICT
  `);

  // Backfill ANTES de RLS (el owner ve todos los tenants): 1 lote 'NA' por fila de stock.
  const inserted = await knex.raw(`
    INSERT INTO commercial.stock_lots
      (tenant_id, warehouse_id, product_id, lot_code, expiry_date, quantity, reserved_quantity)
    SELECT tenant_id, warehouse_id, product_id, 'NA', NULL, quantity, reserved_quantity
      FROM commercial.stock
  `);
  // eslint-disable-next-line no-console
  console.log(`[stock_lots] backfill: ${inserted.rowCount ?? 0} lotes 'NA' creados desde commercial.stock.`);

  await knex.raw(`ALTER TABLE commercial.stock_lots ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.stock_lots FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON commercial.stock_lots`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.stock_lots
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.stock_lots TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.stock_lots IS 'Sub-ledger de lotes (FEFO/caducidad, ADR-022). Descompone commercial.stock por (lote, expiry_date). Invariante: SUM(quantity) por (tenant,wh,product) = commercial.stock.quantity. Lote NA = sin lote.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('stock_lots');
};
