/**
 * Script de Deploy para Nuevos Productos en Producción
 * 
 * Este script ejecuta la migración específica para agregar los nuevos productos
 * y marcas del archivo kjb_clean.md en la base de datos de producción Railway.
 * 
 * Uso: node scripts/deploy-new-products-production.js
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
  console.log('  node scripts/deploy-new-products-production.js');
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
const logFile = path.join(logDir, `deploy-new-products-production-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

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
      operation: 'pre-deploy-new-products-backup',
      records: brands
    };
    
    // Backup de products
    const products = await db('products').select('*');
    const productsBackup = {
      table: 'products',
      timestamp: new Date().toISOString(),
      environment: 'production',
      operation: 'pre-deploy-new-products-backup',
      records: products
    };
    
    // Guardar backups
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const brandsBackupFile = path.join(backupDir, `brands-pre-deploy-new-products-${timestamp}.json`);
    const productsBackupFile = path.join(backupDir, `products-pre-deploy-new-products-${timestamp}.json`);
    
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
      .where({ migration: '20260429170000_add_new_brands_and_products.js' })
      .first();
    
    if (existingMigration) {
      log('⚠️  La migración ya fue ejecutada anteriormente');
      log('   Si necesitas volver a ejecutarla, primero haz rollback:');
      log('   knex migrate:rollback --specific 20260429170000_add_new_brands_and_products.js');
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
  log('🚀 Ejecutando migración de nuevos productos...');
  
  try {
    // Cargar y ejecutar la migración
    const migration = require('../database/migrations/20260429170000_add_new_brands_and_products.js');
    await migration.up(db);
    
    log('✅ Migración ejecutada exitosamente');
    
    // Registrar migración en knex_migrations
    await db('knex_migrations').insert({
      id: require('uuid').v4(),
      name: 'add_new_brands_and_products',
      batch: Date.now(),
      migration_time: new Date(),
      migration: '20260429170000_add_new_brands_and_products.js'
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
      .limit(5);
    
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
      .limit(5);
    
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
  log('INICIO - Deploy de Nuevos Productos (PRODUCCIÓN Railway)');
  log(`Base de datos: switchback.proxy.rlwy.net:16885/railway`);
  log('='.repeat(70));
  
  try {
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
    log('📊 Se agregaron 20 marcas nuevas y 551 productos nuevos');
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
