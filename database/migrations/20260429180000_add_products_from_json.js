/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 * 
 * Migración para agregar marcas y productos del archivo productos_final.json
 * 
 * Estructura del JSON:
 * {
 *   "total_marcas": 47,
 *   "marcas": [
 *     {
 *       "id": 1,
 *       "marca": "Mars",
 *       "linea_inicio_productos": 1,
 *       "linea_fin_productos": 30,
 *       "total_productos": 29,
 *       "productos": ["producto1", "producto2", ...]
 *     }
 *   ]
 * }
 */
exports.up = async function(knex) {
  console.log('[20260429180000_add_products_from_json] Iniciando migración desde productos_final.json...');
  
  try {
    // Cargar datos del JSON
    const fs = require('fs');
    const path = require('path');
    
    const jsonPath = path.join(__dirname, '../../scripts/productos_final.json');
    
    if (!fs.existsSync(jsonPath)) {
      throw new Error('No se encuentra el archivo productos_final.json');
    }
    
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    console.log(`[20260429180000_add_products_from_json] Datos cargados:`);
    console.log(`   - Total marcas en JSON: ${jsonData.total_marcas}`);
    console.log(`   - Marcas procesadas: ${jsonData.marcas.length}`);
    
    // Obtener marcas existentes en BD
    const existingBrands = await knex('brands').select('*');
    const existingBrandNames = existingBrands.map(b => b.nombre);
    const brandMap = {};
    existingBrands.forEach(brand => {
      brandMap[brand.nombre] = brand.id;
    });
    
    console.log(`[20260429180000_add_products_from_json] Marcas existentes en BD: ${existingBrandNames.length}`);
    
    // 1. Procesar y agregar marcas nuevas
    const newBrands = [];
    const brandOrderMap = {};
    
    jsonData.marcas.forEach((brandData, index) => {
      const brandName = brandData.marca;
      
      if (!existingBrandNames.includes(brandName)) {
        newBrands.push({
          nombre: brandName,
          activo: true,
          orden: existingBrands.length + newBrands.length + 1
        });
        brandOrderMap[brandName] = existingBrands.length + newBrands.length;
      } else {
        brandOrderMap[brandName] = existingBrands.find(b => b.nombre === brandName).orden;
      }
    });
    
    if (newBrands.length > 0) {
      console.log(`[20260429180000_add_products_from_json] Insertando ${newBrands.length} marcas nuevas...`);
      await knex('brands').insert(newBrands);
      console.log(`[20260429180000_add_products_from_json] ✅ Marcas insertadas`);
    } else {
      console.log(`[20260429180000_add_products_from_json] ℹ️  No hay marcas nuevas para insertar`);
    }
    
    // 2. Actualizar mapa de marcas con las nuevas
    const allBrands = await knex('brands').select('*');
    allBrands.forEach(brand => {
      brandMap[brand.nombre] = brand.id;
    });
    
    // 3. Procesar productos
    const existingProducts = await knex('products').select('*');
    const existingProductMap = {};
    existingProducts.forEach(p => {
      existingProductMap[p.nombre] = p;
    });
    
    let totalNewProducts = 0;
    let totalBrandCorrections = 0;
    let totalProductsProcessed = 0;
    
    console.log(`[20260429180000_add_products_from_json] Procesando productos...`);
    
    for (const brandData of jsonData.marcas) {
      const brandName = brandData.marca;
      const brandId = brandMap[brandName];
      
      if (!brandId) {
        console.warn(`[20260429180000_add_products_from_json] ⚠️  Marca no encontrada: ${brandName}`);
        continue;
      }
      
      const productsToInsert = [];
      const productsToCorrect = [];
      
      for (const productName of brandData.productos) {
        totalProductsProcessed++;
        
        const existingProduct = existingProductMap[productName];
        
        if (!existingProduct) {
          // Producto nuevo - insertar
          productsToInsert.push({
            brand_id: brandId,
            nombre: productName,
            activo: true,
            orden: 0,
            puntuacion: 5
          });
        } else if (existingProduct.brand_id !== brandId) {
          // Producto existe pero en marca incorrecta - corregir
          productsToCorrect.push({
            productId: existingProduct.id,
            currentBrandId: existingProduct.brand_id,
            correctBrandId: brandId,
            productName: productName
          });
        }
        // Si el producto existe y ya está en la marca correcta, no hacer nada
      }
      
      // Insertar productos nuevos
      if (productsToInsert.length > 0) {
        const batchSize = 50;
        for (let i = 0; i < productsToInsert.length; i += batchSize) {
          const batch = productsToInsert.slice(i, i + batchSize);
          await knex('products').insert(batch);
        }
        
        totalNewProducts += productsToInsert.length;
        console.log(`[20260429180000_add_products_from_json] ${brandName}: ${productsToInsert.length} productos nuevos`);
      }
      
      // Corregir productos en marca incorrecta
      if (productsToCorrect.length > 0) {
        for (const correction of productsToCorrect) {
          // Obtener nombre de la marca actual y correcta para logs
          const currentBrand = await knex('brands').where({ id: correction.currentBrandId }).first();
          const correctBrand = await knex('brands').where({ id: correction.correctBrandId }).first();
          
          await knex('products')
            .where({ id: correction.productId })
            .update({ brand_id: correction.correctBrandId });
          
          console.log(`[20260429180000_add_products_from_json] ${brandName}: "${correction.productName}" movido de "${currentBrand?.nombre}" a "${correctBrand?.nombre}"`);
          
          totalBrandCorrections++;
        }
      }
    }
    
    console.log(`[20260429180000_add_products_from_json] 📊 Resumen de migración:`);
    console.log(`   - Marcas nuevas: ${newBrands.length}`);
    console.log(`   - Productos nuevos: ${totalNewProducts}`);
    console.log(`   - Correcciones de marca: ${totalBrandCorrections}`);
    console.log(`   - Productos procesados: ${totalProductsProcessed}`);
    
    // 4. Validación final
    console.log(`[20260429180000_add_products_from_json] Validando migración...`);
    
    const finalBrandCount = await knex('brands').count('* as count');
    const finalProductCount = await knex('products').count('* as count');
    
    console.log(`[20260429180000_add_products_from_json] 📊 Estado final:`);
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
    
    console.log(`[20260429180000_add_products_from_json] ✅ Integridad referencial validada`);
    console.log(`[20260429180000_add_products_from_json] ✅ Migración completada exitosamente`);
    
  } catch (error) {
    console.error(`[20260429180000_add_products_from_json] ❌ Error durante la migración:`, error.message);
    throw error;
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  console.log('[20260429180000_add_products_from_json] Revirtiendo migración...');
  
  try {
    // Cargar datos del JSON para saber qué revertir
    const fs = require('fs');
    const path = require('path');
    
    const jsonPath = path.join(__dirname, '../../scripts/productos_final.json');
    
    if (!fs.existsSync(jsonPath)) {
      console.log('[20260429180000_add_products_from_json] ℹ️  No hay datos de migración para revertir');
      return;
    }
    
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    // 1. Eliminar productos (primero por la relación FK)
    const allProductNames = [];
    jsonData.marcas.forEach(brandData => {
      allProductNames.push(...brandData.productos);
    });
    
    if (allProductNames.length > 0) {
      const deletedProducts = await knex('products').whereIn('nombre', allProductNames).del();
      console.log(`[20260429180000_add_products_from_json] 🗑️  ${deletedProducts} productos eliminados`);
    }
    
    // 2. Eliminar marcas nuevas (solo las que no existen en los seeds originales)
    const originalSeedBrands = [
      'LA ROSA', 'HERSHEY', 'ARCOR', 'WINIS', 'CANELS', 'MONTES', 'AP', 
      'DELICIATE', 'BOLSAS DE LOS ALTOS', 'LAS DELICIAS', 'INTERCANDY', 
      'KALU', 'FRUTI FRESK'
    ];
    
    const jsonBrandNames = jsonData.marcas.map(b => b.marca);
    const brandsToDelete = jsonBrandNames.filter(brand => 
      !originalSeedBrands.includes(brand)
    );
    
    if (brandsToDelete.length > 0) {
      const deletedBrands = await knex('brands').whereIn('nombre', brandsToDelete).del();
      console.log(`[20260429180000_add_products_from_json] 🗑️  ${deletedBrands} marcas eliminadas`);
    }
    
    console.log('[20260429180000_add_products_from_json] ✅ Reversión completada exitosamente');
    
  } catch (error) {
    console.error('[20260429180000_add_products_from_json] ❌ Error durante la reversión:', error.message);
    throw error;
  }
};
