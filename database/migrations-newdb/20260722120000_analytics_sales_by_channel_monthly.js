/**
 * Ventas contables reclasificadas por CANAL real (desde el concepto `c6` de la póliza
 * Kepler, cuenta 401) → `analytics.sales_by_channel_monthly`.
 *
 * La subcuenta 401-NNN NO sirve para separar canal (todo 2026 cae en 401-002) y su NOMBRE
 * engaña ('VENTA FLETES A TERCEROS' / 'VENTAS VECINAL'). El canal real vive en `c6`:
 * P.V. (mostrador) · TLMKT (telemarketing/mayoreo) · R.D./RUTA (reparto) · R.V. (vecinal).
 * Ver docs/IMPLEMENTACION/KEPLER_CONTABILIDAD_MODELO.md §Familia 4.
 *
 * Grano: (sucursal contable × canal × plaza × mes). ventas = abonos - cargos (neto acreedor).
 * Lo alimenta `import-sales-by-channel.js`. analytics.* sin RLS → filtro tenant explícito.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`CREATE SCHEMA IF NOT EXISTS analytics`);
  if (!(await knex.schema.withSchema('analytics').hasTable('sales_by_channel_monthly'))) {
    await knex.raw(`
      CREATE TABLE analytics.sales_by_channel_monthly (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   uuid NOT NULL,
        sucursal    text NOT NULL,            -- sucursal contable (kdc2.c14; casi todo '00')
        canal       text NOT NULL,            -- mostrador | contado | telemarketing | ruta | reparto_vecinal | otro
        plaza       text NOT NULL DEFAULT '', -- plaza/ruta parseada del concepto c6
        anio_mes    text NOT NULL,            -- 'YYYY-MM'
        ventas      numeric NOT NULL DEFAULT 0,
        movs        integer NOT NULL DEFAULT 0,
        computed_at timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT sales_by_channel_canal_check CHECK (canal IN ('mostrador','contado','telemarketing','ruta','reparto_vecinal','otro'))
      )`);
  }
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_by_channel_monthly
    ON analytics.sales_by_channel_monthly (tenant_id, sucursal, canal, plaza, anio_mes)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_by_channel_mes ON analytics.sales_by_channel_monthly (tenant_id, anio_mes)`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_sales_by_channel_canal ON analytics.sales_by_channel_monthly (tenant_id, canal, anio_mes)`);
  await knex.raw(`GRANT SELECT ON analytics.sales_by_channel_monthly TO app_runtime`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('analytics').dropTableIfExists('sales_by_channel_monthly');
};
