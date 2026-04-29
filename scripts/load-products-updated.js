/**
 * Script directo para cargar productos desde productos_final.json actualizado
 * Mantiene integridad referencial: si el producto ya existe, solo lo mueve a la marca correcta
 * Usa conexión directa a PostgreSQL sin sistema de migraciones
 */

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

async function loadProducts() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'trade_marketing',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  });

  try {
    console.log('📦 Iniciando carga de productos desde JSON actualizado...');
    
    const client = await pool.connect();
    
    // Leer el JSON
    const jsonPath = path.join(__dirname, 'productos_final.json');
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
      
      // Verificar si la marca ya existe
      const existingBrand = await client.query(
        'SELECT id FROM brands WHERE UPPER(nombre) = $1',
        [nombreMarca]
      );
      
      let brandId;
      
      if (existingBrand.rows.length > 0) {
        brandId = existingBrand.rows[0].id;
        stats.marcasExistentes++;
        console.log(`✅ Marca existente: ${nombreMarca} (ID: ${brandId})`);
      } else {
        // Crear la marca
        const newBrand = await client.query(
          'INSERT INTO brands (id, nombre, activo, orden) VALUES (gen_random_uuid(), $1, true, 0) RETURNING id',
          [nombreMarca]
        );
        
        brandId = newBrand.rows[0].id;
        stats.marcasCreadas++;
        console.log(`➕ Marca creada: ${nombreMarca} (ID: ${brandId})`);
      }
      
      // Procesar cada producto
      for (const nombreProducto of marcaData.productos) {
        const nombreProductoNormalizado = nombreProducto.trim().toUpperCase();
        
        // Verificar si el producto ya existe
        const existingProduct = await client.query(
          'SELECT id, brand_id FROM products WHERE UPPER(nombre) = $1',
          [nombreProductoNormalizado]
        );
        
        if (existingProduct.rows.length === 0) {
          // Insertar nuevo producto
          await client.query(
            'INSERT INTO products (id, nombre, brand_id, activo, orden, puntuacion) VALUES (gen_random_uuid(), $1, $2, true, 0, 0)',
            [nombreProductoNormalizado, brandId]
          );
          
          stats.productosInsertados++;
        } else if (existingProduct.rows[0].brand_id !== brandId) {
          // Producto existe pero está en marca incorrecta - moverlo
          await client.query(
            'UPDATE products SET brand_id = $1 WHERE id = $2',
            [brandId, existingProduct.rows[0].id]
          );
          
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
    
    client.release();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Detalle:', error.detail);
  } finally {
    await pool.end();
  }
}

loadProducts();
