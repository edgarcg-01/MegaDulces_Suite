'use strict';

// Diagnóstico read-only para dimensionar Fase I (Inventario físico).
// Mide: almacenes, cobertura de barcode/location/uom en products, stock por almacén.
//   node database/scripts/inventory-diagnostic.js

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')(require('../knexfile-newdb').development);

const MEGA = '00000000-0000-0000-0000-00000000d01c';

async function colExists(table, col, schema = 'public') {
  const r = await knex.raw(
    `SELECT 1 FROM information_schema.columns WHERE table_schema=? AND table_name=? AND column_name=?`,
    [schema, table, col],
  );
  return r.rows.length > 0;
}

(async () => {
  try {
    console.log('\n=== ALMACENES (folio = por almacén) ===');
    const whs = await knex('commercial.warehouses')
      .where('tenant_id', MEGA)
      .select('id', 'code', 'name', 'is_default')
      .orderBy('name');
    console.table(whs.map((w) => ({ code: w.code, name: w.name, default: w.is_default })));

    console.log('\n=== COLUMNAS products relevantes ===');
    for (const c of ['barcode', 'location', 'location_warehouse', 'unit_of_measure', 'uom', 'units_per_box', 'sku', 'nombre']) {
      console.log(`  products.${c}: ${(await colExists('products', c)) ? 'EXISTE' : '— no existe'}`);
    }

    console.log('\n=== COBERTURA products (tenant Mega Dulces) ===');
    const cov = await knex('public.products')
      .where('tenant_id', MEGA)
      .select(
        knex.raw('COUNT(*)::int AS total'),
        knex.raw(`COUNT(*) FILTER (WHERE barcode IS NOT NULL AND barcode <> '')::int AS con_barcode`),
        knex.raw(`COUNT(*) FILTER (WHERE location IS NOT NULL AND location <> '')::int AS con_location`),
        knex.raw(`COUNT(*) FILTER (WHERE activo)::int AS activos`),
      )
      .first();
    console.table([cov]);

    console.log('\n=== STOCK por almacén ===');
    const byWh = await knex('commercial.stock as s')
      .leftJoin('commercial.warehouses as w', 'w.id', 's.warehouse_id')
      .where('s.tenant_id', MEGA)
      .groupBy('w.code', 'w.name')
      .select(
        'w.code',
        'w.name',
        knex.raw('COUNT(*)::int AS skus'),
        knex.raw('SUM(s.quantity)::numeric AS unidades'),
        knex.raw('COUNT(*) FILTER (WHERE s.reserved_quantity > 0)::int AS skus_con_reserva'),
      )
      .orderBy('w.name');
    console.table(byWh);

    console.log('\n=== TIPO de quantity (¿enteros o fraccionados?) ===');
    const frac = await knex('commercial.stock')
      .where('tenant_id', MEGA)
      .whereRaw('quantity <> FLOOR(quantity)')
      .count('* as n')
      .first();
    console.log(`  filas con cantidad fraccionada: ${frac.n}`);
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await knex.destroy();
  }
})();
