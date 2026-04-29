/**
 * Script de Deploy para Producción usando productos_final.json
 * 
 * Este script ejecuta la migración específica para agregar los productos
 * y marcas del archivo productos_final.json en la base de datos de producción Railway.
 * 
 * Uso: node scripts/deploy-json-production.js
 */

const knex = require('knex');
const fs = require('fs');
const path = require('path');

// Configuración para producción Railway
const productionConfig = {
  client: 'postgresql',
  connection: {
    host: 'switchback.proxy.rlwy.net',
    port: 16885,
    user: 'postgres',
    password: process.env.RAILWAY_DB_PASSWORD || '********', // Configurar contraseña
    database: 'railway',
    ssl: { rejectUnauthorized: false }
  },
  pool: {
    min: 2,
    max: 10
  }
};

// Validar contraseña
if (!process.env.RAILWAY_DB_PASSWORD && productionConfig.connection.password === '********') {
  console.log('❌ ERROR: Debes configurar la contraseña de la base de datos');
  console.log('');
  console.log('Opción 1 - Variable de entorno:');
  console.log('  set RAILWAY_DB_PASSWORD=tu_contraseña_aqui');
  console.log('  node scripts/deploy-json-production.js');
  console.log('');
  console.log('Opción 2 - Editar este archivo:');
  console.log('  Cambia la línea: password: process.env.RAILWAY_DB_PASSWORD || "********"');
  console.log('  Por: password: "tu_contraseña_real_aqui"');
  process.exit(1);
}

const db = knex(productionConfig);

// Configuración de logs
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = path.join(logDir, `deploy-json-production-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(logFile, logMessage + '\n');
}

async function createBackup() {
  log('🔄 Creando backup de producción antes del deploy...');
  
  try {
    // Backup de brands
    const brands = await db('brands').select('*');
    const brandsBackup = {
      table: 'brands',
      timestamp: new Date().toISOString(),
      environment: 'production',
      operation: 'pre-deploy-json-backup',
      records: brands
    };
    
    // Backup de products
    const products = await db('products').select('*');
    const productsBackup = {
      table: 'products',
      timestamp: new Date().toISOString(),
      environment: 'production',
      operation: 'pre-deploy-json-backup',
      records: products
    };
    
    // Guardar backups
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const brandsBackupFile = path.join(backupDir, `brands-pre-deploy-json-${timestamp}.json`);
    const productsBackupFile = path.join(backupDir, `products-pre-deploy-json-${timestamp}.json`);
    
    fs.writeFileSync(brandsBackupFile, JSON.stringify(brandsBackup, null, 2));
    fs.writeFileSync(productsBackupFile, JSON.stringify(productsBackup, null, 2));
    
    log(`✅ Backup pre-deploy creado:`);
    log(`   📁 Brands: ${brandsBackupFile} (${brands.length} registros)`);
    log(`   📁 Products: ${productsBackupFile} (${products.length} registros)`);
    
    return { brands, products };
    
  } catch (error) {
    log(`❌ Error creando backup: ${error.message}`);
    throw error;
  }
}

async function validateJsonFile() {
  log('🔍 Validando archivo productos_final.json...');
  
  try {
    const jsonPath = path.join(__dirname, '../scripts/productos_final.json');
    
    if (!fs.existsSync(jsonPath)) {
      throw new Error('No se encuentra el archivo productos_final.json');
    }
    
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    
    if (!jsonData.marcas || !Array.isArray(jsonData.marcas)) {
      throw new Error('El archivo JSON no tiene la estructura esperada (falta array "marcas")');
    }
    
    if (!jsonData.total_marcas || jsonData.total_marcas !== jsonData.marcas.length) {
      log(`⚠️  Advertencia: total_marcas (${jsonData.total_marcas}) no coincide con el tamaño del array (${jsonData.marcas.length})`);
    }
    
    let totalProducts = 0;
    let validBrands = 0;
    
    for (const brand of jsonData.marcas) {
      if (brand.marca && brand.productos && Array.isArray(brand.productos)) {
        validBrands++;
        totalProducts += brand.productos.length;
      }
    }
    
    log(`✅ Archivo JSON validado:`);
    log(`   - Marcas válidas: ${validBrands}/${jsonData.marcas.length}`);
    log(`   - Total productos: ${totalProducts}`);
    
    return jsonData;
    
  } catch (error) {
    log(`❌ Error validando JSON: ${error.message}`);
    throw error;
  }
}

async function testConnection() {
  log('🔍 Probando conexión a producción...');
  
  try {
    await db.raw('SELECT 1 as test');
    log('✅ Conexión exitosa a producción');
    return true;
  } catch (error) {
    log(`❌ Error de conexión: ${error.message}`);
    return false;
  }
}

async function checkMigrationHistory() {
  log('🔍 Verificando historial de migraciones...');
  
  try {
    const existingMigration = await db('knex_migrations')
      .where({ migration: '20260429180000_add_products_from_json.js' })
      .first();
    
    if (existingMigration) {
      log('⚠️  La migración ya fue ejecutada anteriormente');
      log('   Si necesitas volver a ejecutarla, primero haz rollback:');
      log('   knex migrate:rollback --specific 20260429180000_add_products_from_json.js');
      return false;
    }
    
    log('✅ Migración no ejecutada previamente, procediendo con deploy');
    return true;
    
  } catch (error) {
    log('⚠️  No se pudo verificar historial de migraciones (puede ser la primera ejecución)');
    return true;
  }
}

async function executeMigration() {
  log('🚀 Ejecutando migración desde productos_final.json...');
  
  try {
    // Cargar y ejecutar la migración
    const migration = require('../database/migrations/20260429180000_add_products_from_json.js');
    await migration.up(db);
    
    log('✅ Migración ejecutada exitosamente');
    
    // Registrar migración en knex_migrations
    await db('knex_migrations').insert({
      id: require('uuid').v4(),
      name: 'add_products_from_json',
      batch: Date.now(),
      migration_time: new Date(),
      migration: '20260429180000_add_products_from_json.js'
    });
    
    log('✅ Migración registrada en el historial');
    
  } catch (error) {
    log(`❌ Error ejecutando migración: ${error.message}`);
    throw error;
  }
}

async function validatePostDeploy() {
  log('🔍 Validando estado post-deploy...');
  
  try {
    // Verificar integridad referencial
    const orphanProducts = await db('products')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .where('brands.id', null)
      .count('* as count');
    
    if (parseInt(orphanProducts[0].count) > 0) {
      log(`❌ Se detectaron ${orphanProducts[0].count} productos huérfanos post-deploy`);
      return false;
    }
    
    // Verificar conteos finales
    const finalBrands = await db('brands').count('* as count');
    const finalProducts = await db('products').count('* as count');
    
    log('📊 Estado final de producción:');
    log(`   - Total marcas: ${finalBrands[0].count}`);
    log(`   - Total productos: ${finalProducts[0].count}`);
    
    // Mostrar algunas marcas nuevas agregadas
    const newBrands = await db('brands')
      .whereNotIn('nombre', [
        'LA ROSA', 'HERSHEY', 'ARCOR', 'WINIS', 'CANELS', 'MONTES', 'AP', 
        'DELICIATE', 'BOLSAS DE LOS ALTOS', 'LAS DELICIAS', 'INTERCANDY', 
        'KALU', 'FRUTI FRESK'
      ])
      .limit(10);
    
    if (newBrands.length > 0) {
      log('📋 Ejemplo de marcas nuevas agregadas:');
      newBrands.forEach(brand => {
        log(`   - ${brand.nombre}`);
      });
    }
    
    // Mostrar algunos productos nuevos agregados
    const newProducts = await db('products')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .whereNotIn('brands.nombre', [
        'LA ROSA', 'HERSHEY', 'ARCOR', 'WINIS', 'CANELS', 'MONTES', 'AP', 
        'DELICIATE', 'BOLSAS DE LOS ALTOS', 'LAS DELICIAS', 'INTERCANDY', 
        'KALU', 'FRUTI FRESK'
      ])
      .select('products.nombre', 'brands.nombre as brand_name')
      .limit(10);
    
    if (newProducts.length > 0) {
      log('📋 Ejemplo de productos nuevos agregados:');
      newProducts.forEach(product => {
        log(`   - ${product.nombre} (${product.brand_name})`);
      });
    }
    
    log('✅ Todas las validaciones post-deploy pasaron correctamente');
    return true;
    
  } catch (error) {
    log(`❌ Error en validación post-deploy: ${error.message}`);
    return false;
  }
}

async function main() {
  log('='.repeat(70));
  log('INICIO - Deploy desde productos_final.json (PRODUCCIÓN Railway)');
  log(`Base de datos: switchback.proxy.rlwy.net:16885/railway`);
  log('='.repeat(70));
  
  try {
    // 0. Validar archivo JSON
    const jsonData = await validateJsonFile();
    
    // 1. Probar conexión
    const connectionOk = await testConnection();
    if (!connectionOk) {
      process.exit(1);
    }
    
    // 2. Verificar historial de migraciones
    const canProceed = await checkMigrationHistory();
    if (!canProceed) {
      process.exit(1);
    }
    
    // 3. Crear backup
    await createBackup();
    
    // 4. Ejecutar migración
    await executeMigration();
    
    // 5. Validar post-deploy
    const validationOk = await validatePostDeploy();
    if (!validationOk) {
      log('❌ Validación post-deploy falló');
      process.exit(1);
    }
    
    log('\n='.repeat(70));
    log('✅ Deploy completado exitosamente en producción');
    log(`📊 Se procesaron ${jsonData.marcas.length} marcas del JSON`);
    log(`📁 Log guardado en: ${logFile}`);
    log('='.repeat(70));
    
  } catch (error) {
    log(`\n❌ ERROR FATAL EN DEPLOY: ${error.message}`);
    log('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Ejecutar deploy
main();
