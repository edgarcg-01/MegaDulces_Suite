/**
 * DM.0 — Diario de movimientos → analytics.stock_movements (feed line-level).
 *
 * Reemplaza/mejora el reporte Kepler "Diario de movimientos" (Almacenes → Reportes →
 * Existencia → Movimientos), que lee md.kdm1 (cabecera) ⋈ md.kdm2 (líneas). Ver
 * docs/IMPLEMENTACION/ERP_KEPLER_SCHEMA.md §"Reporte Diario de movimientos".
 *
 * Grano = una fila por LÍNEA de documento que MUEVE inventario. La lo alimenta
 * `import-stock-movements.js`, que filtra por el catálogo autoritativo md.doctype
 * (k_binv=1) y firma la cantidad por naturaleza:
 *    naturaleza 'A' (Acreedora/Credit) → ENTRADA  (+qty)   [InvIn, Compra, Devol. de venta, Orden entrada]
 *    naturaleza 'D' (Deudora/Debit)    → SALIDA   (-qty)   [Venta, Remisión, Traspaso, Devol. a proveedor, InvOut, Físico]
 * (Validado 2026-07-10 reconciliando Σ signed vs md.kdil existencia: 48≈47, 98≈84, 18≈15.
 *  La factura U/D/10 NO mueve stock → se excluye vía k_binv, si no duplicaría.)
 *
 * Diseño: agregación primero (GROUP BY producto en el endpoint), folio a folio bajo
 * demanda (esta tabla guarda las líneas para el drill-down). Feed windowed por fecha.
 *
 * analytics.* = SIN RLS → filtro tenant_id EXPLÍCITO en cada query. Idempotente/aditiva.
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('stock_movements')) return;
  await knex.raw(`
    CREATE TABLE analytics.stock_movements (
      id             bigint GENERATED ALWAYS AS IDENTITY,
      tenant_id      uuid NOT NULL,
      warehouse_id   uuid NOT NULL,       -- commercial.warehouses.id (resuelto del code del importer)
      product_id     uuid NOT NULL,       -- catalog.products.id (resuelto del sku)
      doc_date       date NOT NULL,       -- kdm1.c9
      genero         char(1) NOT NULL,    -- kdm1.c2  (U/X/N)
      naturaleza     char(1) NOT NULL,    -- kdm1.c3  (A=entrada / D=salida)
      doc_type       text NOT NULL,       -- kdm1.c4  (tipo: 05/40/25…)
      doc_code       text NOT NULL,       -- doctype.k_code (Sale1/Purchas1/InvIn1…)
      movement_kind  text NOT NULL,       -- 'entrada' | 'salida'
      movement_label text NOT NULL,       -- legible ES: Venta / Compra / Traspaso / Ajuste…
      folio          text NOT NULL,       -- kdm1.c6
      signed_qty     numeric NOT NULL,    -- +entrada / -salida
      qty            numeric NOT NULL,    -- abs
      unit_cost      numeric,             -- kdm2.c12 / qty (valor a costo)
      amount         numeric,             -- valorizado (abs)
      parent_group   text,                -- kdm1.c37 (back-pointer cadena)
      parent_folio   text,                -- kdm1.c39
      source_branch  text NOT NULL,       -- nº sucursal Kepler (kdm1.c1)
      imported_at    timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, id)
    )`);
  // Agregación por producto (vista default) + rango de fechas.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stockmov_prod ON analytics.stock_movements (tenant_id, warehouse_id, product_id, doc_date)`);
  // Serie temporal / re-agrupación por día.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stockmov_date ON analytics.stock_movements (tenant_id, warehouse_id, doc_date)`);
  // Re-agrupación por tipo de documento.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stockmov_code ON analytics.stock_movements (tenant_id, warehouse_id, doc_code)`);
  // Drill directo a folio.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stockmov_folio ON analytics.stock_movements (tenant_id, folio)`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON analytics.stock_movements TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('stock_movements');
};
