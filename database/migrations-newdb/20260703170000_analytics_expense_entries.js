/**
 * GX.1 — `analytics.expense_entries`: pólizas contables de EGRESOS de Kepler
 * (gastos + compras a proveedores) por sucursal, para el reporte /comercial/egresos.
 *
 * Un renglón = un movimiento de póliza (cargo a cuenta 5xx/6xx) desde las tablas
 * mensuales `kdc2YYMM` de cada sucursal Kepler. Modelo:
 *   - egreso = cargo (kdc.c4='C') a cuenta de costo/compras (5xx) o gasto (6xx)
 *   - cuenta + nombre desde el catálogo `kdco`
 *   - beneficiario = kdc.c6 (proveedor / sucursal / nómina)
 *   - documento origen = tipo (XA2001, XA1001, …) + folio
 * Se construye desde las PÓLIZAS (no desde los documentos) → una sola postura por
 * transacción, evita el 4× de las 4 etapas XA20/35/37/40.
 *
 * Lo puebla `import-expenses-polizas.js` (server-side, bulk). Consumido por el
 * endpoint de egresos en commercial-analytics.
 *
 * Aditiva, idempotente, solo schema `analytics`. Filtro de tenant explícito en
 * queries (mismo patrón que analytics.inventory_health; sin RLS en analytics).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('expense_entries')) return;
  await knex.raw(`
    CREATE TABLE analytics.expense_entries (
      tenant_id     uuid NOT NULL,
      sucursal      text NOT NULL,
      doc_tipo      text NOT NULL,
      doc_folio     text NOT NULL,
      linea         int  NOT NULL,
      fecha         date,
      cuenta        text NOT NULL,
      cuenta_nombre text,
      familia       text,               -- '5' compras/costo · '6' gastos
      cargo_abono   text,               -- 'C' cargo · 'A' abono
      beneficiario  text,
      importe       numeric DEFAULT 0,
      computed_at   timestamptz DEFAULT now(),
      PRIMARY KEY (tenant_id, sucursal, doc_tipo, doc_folio, linea)
    )`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_fecha ON analytics.expense_entries (tenant_id, fecha)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_cuenta ON analytics.expense_entries (tenant_id, cuenta)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_suc ON analytics.expense_entries (tenant_id, sucursal)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_expense_benef ON analytics.expense_entries (tenant_id, beneficiario)`);
  await knex.raw(`GRANT SELECT ON analytics.expense_entries TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('expense_entries');
};
