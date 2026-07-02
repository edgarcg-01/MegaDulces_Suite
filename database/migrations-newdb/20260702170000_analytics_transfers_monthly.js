/**
 * T.3 — Tabla `analytics.transfers_monthly`: MOVIMIENTOS que NO son venta
 * (traspasos / consolidación interna) por sucursal × tipo × mes. Se reportan en
 * un apartado propio (`/logistica/traspasos`) y se mantienen FUERA de todo
 * reporte de venta.
 *
 * `kind`:
 *   - `consolidacion`     = docs U/D/6 (serie UD06): consolidación interna diaria
 *                           (CONTADO, sin destino). Era el causante del ×2 en venta.
 *   - `recepcion`         = docs U/A/50 "Recepción Traspaso Suc" (entrada por traspaso).
 *   - `traspaso_salida`   = docs N/D/6 + N/D/25 (Salida Traspaso Sucursal/almacén).
 *   - `traspaso_entrada`  = docs N/A/6 + N/A/25 (Entrada Traspaso Sucursal/almacén).
 *
 * La alimenta el feed on-prem `import-transfers-monthly.js` (UPSERT-acumulativo
 * GREATEST, igual que ventas-por-ruta: las sucursales vivas purgan historia).
 * Aditiva, idempotente, solo schema `analytics`. NO toca mart.ventas ni ventas.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (await knex.schema.withSchema('analytics').hasTable('transfers_monthly')) return;
  await knex.raw(`
    CREATE TABLE analytics.transfers_monthly (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id    uuid NOT NULL,
      warehouse_id uuid NOT NULL,
      kind         text NOT NULL,
      month        date NOT NULL,
      units        numeric NOT NULL DEFAULT 0,
      value        numeric NOT NULL DEFAULT 0,
      docs         integer NOT NULL DEFAULT 0,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT chk_transfers_kind CHECK (kind IN ('consolidacion','recepcion','traspaso_salida','traspaso_entrada'))
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_transfers_monthly ON analytics.transfers_monthly (tenant_id, warehouse_id, kind, month)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_transfers_month ON analytics.transfers_monthly (tenant_id, month)`);
  await knex.raw(`GRANT SELECT ON analytics.transfers_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('transfers_monthly');
};
