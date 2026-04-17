const knex = require('knex');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const db = knex({
  client: 'pg',
  connection: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'trade_marketing',
  },
});

/**
 * Script para restaurar productos eliminados que aún están referenciados en exhibiciones
 * 
 * Este script:
 * 1. Busca todos los PIDs únicos en exhibiciones
 * 2. Identifica cuáles no existen en la tabla products
 * 3. Reinserta esos productos con nombres genéricos basados en su UUID
 */

async function run() {
  console.log('[RestoreDeletedProducts] Starting restoration process...');

  try {
    // Check specific UUIDs mentioned by user
    const specificUUIDs = ['3956e667', 'f1a8be96', 'b1f21f0e', 'e208c6a0'];
    console.log('[RestoreDeletedProducts] Checking specific UUIDs:', specificUUIDs);

    for (const uuid of specificUUIDs) {
      const product = await db('products')
        .whereRaw('id::text LIKE ?', [`%${uuid}%`])
        .first();
      
      if (product) {
        console.log(`[RestoreDeletedProducts] Found product with UUID ${uuid}:`, product.id, '-', product.nombre);
      } else {
        console.log(`[RestoreDeletedProducts] Product with UUID ${uuid} NOT FOUND in products table`);
      }
    }

    // 1. Get all unique PIDs from exhibiciones in daily_captures
    const exhibiciones = await db('daily_captures')
      .select('exhibiciones')
      .whereNotNull('exhibiciones');

    const allPIDs = new Set<string>();

    exhibiciones.forEach((row: any) => {
      let ex: any[];
      try {
        ex = typeof row.exhibiciones === 'string' 
          ? JSON.parse(row.exhibiciones) 
          : row.exhibiciones || [];
      } catch {
        ex = [];
      }

      ex.forEach((exhibicion: any) => {
        const productosMarcados = exhibicion.productosMarcados || [];
        productosMarcados.forEach((pid: string) => {
          allPIDs.add(pid);
        });
      });
    });

    console.log(`[RestoreDeletedProducts] Found ${allPIDs.size} unique PIDs in exhibiciones`);
    console.log(`[RestoreDeletedProducts] All PIDs:`, Array.from(allPIDs));

    // 2. Get all existing product IDs from products table
    const existingProducts = await db('products').select('id', 'nombre');
    const existingProductIds = new Set(existingProducts.map((p: any) => p.id));

    console.log(`[RestoreDeletedProducts] Found ${existingProductIds.size} products in database`);

    // 3. Find missing PIDs
    const missingPIDs = Array.from(allPIDs).filter(pid => !existingProductIds.has(pid));
    console.log(`[RestoreDeletedProducts] Found ${missingPIDs.length} missing products to restore`);

    if (missingPIDs.length === 0) {
      console.log('[RestoreDeletedProducts] No missing products found. Nothing to restore.');
      return;
    }

    // 4. Get all brands to assign a default brand
    const brands = await db('brands').select('id', 'nombre');
    const defaultBrand = brands[0]; // Use first brand as default
    console.log(`[RestoreDeletedProducts] Using default brand: ${defaultBrand?.nombre || 'N/A'}`);

    // 5. Reinsert missing products with generic names
    let restoredCount = 0;
    for (const pid of missingPIDs) {
      try {
        // Generate a generic name based on the PID
        const genericName = `Producto Restaurado (${pid.substring(0, 8)})`;
        
        await db('products').insert({
          id: pid,
          nombre: genericName,
          brand_id: defaultBrand?.id,
          activo: true,
          orden: 999, // Put at the end
          puntuacion: 5, // Default score
        });

        console.log(`[RestoreDeletedProducts] Restored product: ${pid} -> ${genericName}`);
        restoredCount++;
      } catch (error) {
        console.error(`[RestoreDeletedProducts] Error restoring product ${pid}:`, error);
      }
    }

    console.log(`[RestoreDeletedProducts] Restoration complete. Restored ${restoredCount} products.`);
  } catch (error) {
    console.error('[RestoreDeletedProducts] Error:', error);
    throw error;
  } finally {
    await db.destroy();
  }
}

run()
  .then(() => {
    console.log('✅ Script completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Script failed:', error);
    process.exit(1);
  });
