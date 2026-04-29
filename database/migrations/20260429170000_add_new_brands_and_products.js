/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 * 
 * Migración para agregar nuevas marcas y productos del archivo kjb_clean.md
 * 
 * Esta migración:
 * 1. Agrega 156 marcas nuevas
 * 2. Agrega 436 productos nuevos
 * 3. Mantiene integridad referencial
 * 4. No afecta datos existentes
 */
exports.up = async function(knex) {
  console.log('[20260429170000_add_new_brands_and_products] Iniciando migración de nuevos productos...');
  
  try {
    // Cargar datos procesados del archivo
    const fs = require('fs');
    const path = require('path');
    
    const migrationDataPath = path.join(__dirname, '../../migration-data.json');
    
    if (!fs.existsSync(migrationDataPath)) {
      throw new Error('No se encuentra el archivo migration-data.json. Ejecuta primero: node scripts/process-new-products.js');
    }
    
    const migrationData = JSON.parse(fs.readFileSync(migrationDataPath, 'utf8'));
    
    console.log(`[20260429170000_add_new_brands_and_products] Datos cargados:`);
    console.log(`   - ${migrationData.newBrands.length} marcas nuevas`);
    console.log(`   - ${migrationData.newProducts.length} productos nuevos`);
    
    // 1. Insertar nuevas marcas
    if (migrationData.newBrands.length > 0) {
      console.log('[20260429170000_add_new_brands_and_products] Insertando nuevas marcas...');
      
      // Verificar que no existan duplicados
      const existingBrands = await knex('brands').select('nombre');
      const existingBrandNames = existingBrands.map(b => b.nombre);
      
      const brandsToInsert = migrationData.newBrands.filter(brand => 
        !existingBrandNames.includes(brand.nombre)
      );
      
      if (brandsToInsert.length > 0) {
        await knex('brands').insert(brandsToInsert);
        console.log(`[20260429170000_add_new_brands_and_products] ✅ ${brandsToInsert.length} marcas insertadas`);
      } else {
        console.log('[20260429170000_add_new_brands_and_products] ℹ️  No hay marcas nuevas para insertar (ya existen)');
      }
    }
    
    // 2. Obtener mapa de marcas actualizado
    const allBrands = await knex('brands').select('*');
    const brandMap = {};
    allBrands.forEach(brand => {
      brandMap[brand.nombre] = brand.id;
    });
    
    // 3. Insertar nuevos productos
    if (migrationData.newProducts.length > 0) {
      console.log('[20260429170000_add_new_brands_and_products] Insertando nuevos productos...');
      
      // Verificar que no existan duplicados
      const existingProducts = await knex('products').select('nombre');
      const existingProductNames = existingProducts.map(p => p.nombre);
      
      const productsToInsert = migrationData.newProducts.filter(product => 
        !existingProductNames.includes(product.nombre)
      ).map(product => ({
        brand_id: brandMap[product.brand_name],
        nombre: product.nombre,
        activo: product.activo,
        orden: product.orden,
        puntuacion: product.puntuacion
      })).filter(product => product.brand_id); // Solo productos con marca válida
      
      if (productsToInsert.length > 0) {
        // Insertar en lotes para evitar problemas de memoria
        const batchSize = 50;
        let insertedCount = 0;
        
        for (let i = 0; i < productsToInsert.length; i += batchSize) {
          const batch = productsToInsert.slice(i, i + batchSize);
          await knex('products').insert(batch);
          insertedCount += batch.length;
          console.log(`[20260429170000_add_new_brands_and_products] Progreso: ${insertedCount}/${productsToInsert.length} productos`);
        }
        
        console.log(`[20260429170000_add_new_brands_and_products] ✅ ${insertedCount} productos insertados`);
      } else {
        console.log('[20260429170000_add_new_brands_and_products] ℹ️  No hay productos nuevos para insertar (ya existen)');
      }
    }
    
    // 4. Validación final
    console.log('[20260429170000_add_new_brands_and_products] Validando migración...');
    
    const finalBrandCount = await knex('brands').count('* as count');
    const finalProductCount = await knex('products').count('* as count');
    
    console.log(`[20260429170000_add_new_brands_and_products] 📊 Estado final:`);
    console.log(`   - Total marcas: ${finalBrandCount[0].count}`);
    console.log(`   - Total productos: ${finalProductCount[0].count}`);
    
    // Verificar integridad referencial
    const orphanProducts = await knex('products')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .where('brands.id', null)
      .count('* as count');
    
    if (parseInt(orphanProducts[0].count) > 0) {
      throw new Error(`Se detectaron ${orphanProducts[0].count} productos huérfanos post-migración`);
    }
    
    console.log('[20260429170000_add_new_brands_and_products] ✅ Integridad referencial validada');
    console.log('[20260429170000_add_new_brands_and_products] ✅ Migración completada exitosamente');
    
  } catch (error) {
    console.error('[20260429170000_add_new_brands_and_products] ❌ Error durante la migración:', error.message);
    throw error;
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  console.log('[20260429170000_add_new_brands_and_products] Revirtiendo migración...');
  
  try {
    // Cargar datos para saber qué revertir
    const fs = require('fs');
    const path = require('path');
    
    const migrationDataPath = path.join(__dirname, '../../migration-data.json');
    
    if (!fs.existsSync(migrationDataPath)) {
      console.log('[20260429170000_add_new_brands_and_products] ℹ️  No hay datos de migración para revertir');
      return;
    }
    
    const migrationData = JSON.parse(fs.readFileSync(migrationDataPath, 'utf8'));
    
    // 1. Eliminar productos nuevos (primero por la relación FK)
    if (migrationData.newProducts.length > 0) {
      const productNames = migrationData.newProducts.map(p => p.nombre);
      const deletedProducts = await knex('products').whereIn('nombre', productNames).del();
      console.log(`[20260429170000_add_new_brands_and_products] 🗑️  ${deletedProducts} productos eliminados`);
    }
    
    // 2. Eliminar marcas nuevas
    if (migrationData.newBrands.length > 0) {
      const brandNames = migrationData.newBrands.map(b => b.nombre);
      const deletedBrands = await knex('brands').whereIn('nombre', brandNames).del();
      console.log(`[20260429170000_add_new_brands_and_products] 🗑️  ${deletedBrands} marcas eliminadas`);
    }
    
    console.log('[20260429170000_add_new_brands_and_products] ✅ Reversión completada exitosamente');
    
  } catch (error) {
    console.error('[20260429170000_add_new_brands_and_products] ❌ Error durante la reversión:', error.message);
    throw error;
  }
};
