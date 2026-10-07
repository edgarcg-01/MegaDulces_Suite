/**
 * Migración para cargar productos desde productos_final.json actualizado
 * Mantiene integridad referencial: si el producto ya existe, solo lo mueve a la marca correcta
 */

const path = require('path');
const fs = require('fs');

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  console.log('📦 Iniciando carga de productos desde JSON actualizado...');
  
  // Leer el JSON
  const jsonPath = path.join(__dirname, '../../scripts/productos_final.json');
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  
  console.log(`📊 Total de marcas en JSON: ${jsonData.total_marcas}`);
  
  let stats = {
    marcasCreadas: 0,
    marcasExistentes: 0,
    productosInsertados: 0,
    productosMovidos: 0,
    productosCorrectos: 0
  };
    // Procesar cada marca
  for (const marcaData of jsonData.marcas) {
    const nombreMarca = marcaData.marca.trim().toUpperCase();
    
    // Verificar si la marca ya existe (usando mayúsculas en la BD)
    const existingBrand = await knex('brands')
      .whereRaw('UPPER(nombre) = ?', [nombreMarca])
      .first();
    
    let brandId;
    
    if (existingBrand) {
      brandId = existingBrand.id;
      stats.marcasExistentes++;
      console.log(`✅ Marca existente: ${nombreMarca} (ID: ${brandId})`);
    } else {
      // Crear la marca
      const [newBrand] = await knex('brands')
        .insert({
          nombre: nombreMarca,
          activo: true,
          orden: 0
        })
        .returning('id');
      
      brandId = newBrand.id;
      stats.marcasCreadas++;
      console.log(`➕ Marca creada: ${nombreMarca} (ID: ${brandId})`);
    }
    
    // Procesar cada producto
    for (const nombreProducto of marcaData.productos) {
      const nombreProductoNormalizado = nombreProducto.trim().toUpperCase();
      
      // Verificar si el producto ya existe (usando mayúsculas en la BD)
      const existingProduct = await knex('products')
        .whereRaw('UPPER(nombre) = ?', [nombreProductoNormalizado])
        .first();
      
      if (!existingProduct) {
        // Insertar nuevo producto
        await knex('products').insert({
          id: knex.raw('gen_random_uuid()'),
          nombre: nombreProductoNormalizado,
          brand_id: brandId,
          activo: true,
          orden: 0,
          puntuacion: 0
        });
        
        stats.productosInsertados++;
      } else if (existingProduct.brand_id !== brandId) {
        // Producto existe pero está en marca incorrecta - moverlo
        await knex('products')
          .where('id', existingProduct.id)
          .update({
            brand_id: brandId
          });
        
        stats.productosMovidos++;
        console.log(`🔄 Producto movido: ${nombreProductoNormalizado} -> ${nombreMarca}`);
      } else {
        // Producto existe y está en la marca correcta - no hacer nada
        stats.productosCorrectos++;
      }
    }
  }
  
  console.log('\n📈 Estadísticas de la migración:');
  console.log(`   Marcas creadas: ${stats.marcasCreadas}`);
  console.log(`   Marcas existentes: ${stats.marcasExistentes}`);
  console.log(`   Productos insertados: ${stats.productosInsertados}`);
  console.log(`   Productos movidos a marca correcta: ${stats.productosMovidos}`);
  console.log(`   Productos ya correctos: ${stats.productosCorrectos}`);
  console.log('\n✅ Migración completada exitosamente');
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  console.log('⚠️ Rollback: Esta migración no se puede revertir automáticamente.');
  console.log('⚠️ Para revertir, necesitas un backup de la base de datos.');
};
