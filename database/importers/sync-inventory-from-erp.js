#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Sync `inventory.products` + `inventory.products_active` desde el ERP
 * MegaDulces via FDW.
 *
 * Fuentes:
 *   erp.catalogo_completo  → inventory.products       (~13,852)
 *   erp.productos_activos  → inventory.products_active (~6,489)
 *
 * Estrategia:
 *   - INSERT ... ON CONFLICT (sku) DO UPDATE para mantener data fresca.
 *   - Para active: JOIN-eamos con catalogo_completo para tener metadata
 *     (nombre, codigo_barras, etc.) ya que productos_activos solo tiene `articulo`.
 *
 * Idempotente. Re-ejecutable.
 *
 * Solo funciona donde el FDW `mega_dulces_srv` es accesible (red de Mega Dulces).
 * Para Railway prod usar `sync-inventory-to-railway.js` después de correr este.
 *
 * Uso:
 *   node database/importers/sync-inventory-from-erp.js [--dry-run]
 */

require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '..', '.env'),
});
const knexLib = require('knex');

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  let knexCfg;
  if (process.env.DATABASE_URL_NEW) {
    knexCfg = {
      client: 'pg',
      connection: process.env.DATABASE_URL_NEW.includes('rlwy.net')
        ? {
            connectionString: process.env.DATABASE_URL_NEW,
            ssl: { rejectUnauthorized: false },
          }
        : { connectionString: process.env.DATABASE_URL_NEW },
      pool: { min: 1, max: 5 },
    };
  } else {
    knexCfg = require('../knexfile-newdb.js').development;
  }

  const knex = knexLib(knexCfg);
  const start = Date.now();

  try {
    // Verificar que el FDW está accesible
    try {
      await knex.raw(`SELECT 1 FROM erp.catalogo_completo LIMIT 1`);
    } catch (e) {
      console.error(
        `[inventory_sync] ERROR: FDW erp.catalogo_completo no accesible: ${e.message}`,
      );
      console.error(
        '[inventory_sync] Este importer solo corre donde el FDW al ERP está accesible (red Mega Dulces).',
      );
      process.exit(1);
    }

    // Counts pre-sync
    const before = await knex.raw(`
      SELECT
        (SELECT COUNT(*) FROM erp.catalogo_completo)  AS erp_total,
        (SELECT COUNT(*) FROM erp.productos_activos)  AS erp_active,
        (SELECT COUNT(*) FROM inventory.products)     AS inv_total,
        (SELECT COUNT(*) FROM inventory.products_active) AS inv_active
    `);
    console.log(
      `[inventory_sync] pre: ERP=${before.rows[0].erp_total}/${before.rows[0].erp_active} inventory=${before.rows[0].inv_total}/${before.rows[0].inv_active}`,
    );

    if (args.dryRun) {
      console.log('[DRY RUN] Sync would UPSERT from FDW into inventory.products + products_active');
      return;
    }

    // 1. UPSERT inventory.products desde catalogo_completo
    const r1 = await knex.raw(`
      INSERT INTO inventory.products (
        sku, producto_servicio, codigo_barras, subfamilia, nombre, descripcion,
        unidad_compra, unidad_venta, factor_compra, factor_venta,
        venta_valor_anual, venta_valor_costo_anual, venta_unidad_anual,
        categoria, ieps_compra, iva_compra, ieps_venta, iva_venta,
        ptos_frecuencia, fecha_alta, fecha_ultima_modificacion,
        a_1, a_2, a_3, synced_at
      )
      SELECT
        articulo, producto_servicio, codigo_barras, subfamilia, nombre, descripcion,
        unidad_compra, unidad_venta, factor_compra, factor_venta,
        venta_valor_anual, venta_valor_costo_anual, venta_unidad_anual,
        categoria, ieps_compra, iva_compra, ieps_venta, iva_venta,
        ptos_frecuencia, fecha_alta, fecha_ultima_modificacion,
        a_1, a_2, a_3, NOW()
      FROM erp.catalogo_completo
      ON CONFLICT (sku) DO UPDATE SET
        producto_servicio = EXCLUDED.producto_servicio,
        codigo_barras = EXCLUDED.codigo_barras,
        subfamilia = EXCLUDED.subfamilia,
        nombre = EXCLUDED.nombre,
        descripcion = EXCLUDED.descripcion,
        unidad_compra = EXCLUDED.unidad_compra,
        unidad_venta = EXCLUDED.unidad_venta,
        factor_compra = EXCLUDED.factor_compra,
        factor_venta = EXCLUDED.factor_venta,
        venta_valor_anual = EXCLUDED.venta_valor_anual,
        venta_valor_costo_anual = EXCLUDED.venta_valor_costo_anual,
        venta_unidad_anual = EXCLUDED.venta_unidad_anual,
        categoria = EXCLUDED.categoria,
        ieps_compra = EXCLUDED.ieps_compra,
        iva_compra = EXCLUDED.iva_compra,
        ieps_venta = EXCLUDED.ieps_venta,
        iva_venta = EXCLUDED.iva_venta,
        ptos_frecuencia = EXCLUDED.ptos_frecuencia,
        fecha_ultima_modificacion = EXCLUDED.fecha_ultima_modificacion,
        a_1 = EXCLUDED.a_1,
        a_2 = EXCLUDED.a_2,
        a_3 = EXCLUDED.a_3,
        synced_at = NOW()
    `);
    console.log(`[inventory_sync] products: ${r1.rowCount} rows affected`);

    // 2. Sync products_active: TRUNCATE + INSERT (más rápido que UPSERT para subset)
    // JOIN con catalogo_completo para traer metadata
    await knex.raw(`TRUNCATE inventory.products_active`);
    const r2 = await knex.raw(`
      INSERT INTO inventory.products_active (
        sku, codigo_barras, subfamilia, nombre, descripcion,
        unidad_compra, unidad_venta, categoria, synced_at
      )
      SELECT
        pa.articulo, cc.codigo_barras, cc.subfamilia, cc.nombre, cc.descripcion,
        cc.unidad_compra, cc.unidad_venta, cc.categoria, NOW()
      FROM erp.productos_activos pa
      LEFT JOIN erp.catalogo_completo cc ON cc.articulo = pa.articulo
      WHERE pa.articulo IN (SELECT sku FROM inventory.products)
    `);
    console.log(`[inventory_sync] products_active: ${r2.rowCount} rows inserted`);

    const after = await knex.raw(`
      SELECT
        (SELECT COUNT(*) FROM inventory.products)        AS inv_total,
        (SELECT COUNT(*) FROM inventory.products_active) AS inv_active
    `);
    const ms = Date.now() - start;
    console.log(
      `[inventory_sync] OK (${ms}ms): inventory.products=${after.rows[0].inv_total} active=${after.rows[0].inv_active}`,
    );
  } catch (e) {
    console.error('[inventory_sync] ERROR:', e.message);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
}

main();
