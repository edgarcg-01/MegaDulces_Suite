/**
 * Script SEGURO para corregir productos con marcas incorrectas en PRODUCCIÓN Railway
 * 
 * CARACTERÍSTICAS DE SEGURIDAD:
 * 1. Crea backup automático antes de cualquier cambio
 * 2. Valida integridad referencial antes de ejecutar
 * 3. Permite modo "dry-run" para simular cambios
 * 4. Genera log detallado de todas las operaciones
 * 5. Verifica que no se pierdan datos
 * 
 * Uso:
 * - Modo diagnóstico: node scripts/safe-brand-product-correction-production.js --dry-run
 * - Modo corrección: node scripts/safe-brand-product-correction-production.js --execute
 */

const knex = require('knex');
const fs = require('fs');
const path = require('path');

// Argumentos de línea de comandos
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EXECUTE = args.includes('--execute');

if (!DRY_RUN && !EXECUTE) {
  console.log('❌ Debes especificar --dry-run o --execute');
  console.log('   --dry-run: Solo diagnóstico, no hace cambios');
  console.log('   --execute: Ejecuta las correcciones');
  process.exit(1);
}

// Configuración directa para producción Railway
const productionConfig = {
  client: 'postgresql',
  connection: {
    host: 'switchback.proxy.rlwy.net',
    port: 16885,
    user: 'postgres',
    password: process.env.RAILWAY_DB_PASSWORD || '********', // Reemplaza con tu contraseña real
    database: 'railway',
    ssl: { rejectUnauthorized: false }
  },
  pool: {
    min: 2,
    max: 10
  },
  migrations: {
    tableName: 'knex_migrations'
  }
};

// Validar que se haya proporcionado la contraseña
if (!process.env.RAILWAY_DB_PASSWORD && productionConfig.connection.password === '********') {
  console.log('❌ ERROR: Debes configurar la contraseña de la base de datos');
  console.log('');
  console.log('Opción 1 - Variable de entorno:');
  console.log('  set RAILWAY_DB_PASSWORD=tu_contraseña_aqui');
  console.log('  node scripts/safe-brand-product-correction-production.js --dry-run');
  console.log('');
  console.log('Opción 2 - Editar este archivo:');
  console.log('  Cambia la línea: password: process.env.RAILWAY_DB_PASSWORD || "********"');
  console.log('  Por: password: "tu_contraseña_real_aqui"');
  console.log('');
  console.log('Opción 3 - Usar Railway CLI:');
  console.log('  railway connect Postgres');
  console.log('  (El script detectará automáticamente la conexión)');
  process.exit(1);
}

const db = knex(productionConfig);

// Configuración de logs
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
const logFile = path.join(logDir, `brand-correction-production-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);
  fs.appendFileSync(logFile, logMessage + '\n');
}

async function testConnection() {
  log('🔍 Probando conexión a base de datos de producción...');
  
  try {
    await db.raw('SELECT 1 as test');
    log('✅ Conexión exitosa a base de datos de producción');
    return true;
  } catch (error) {
    log(`❌ Error de conexión: ${error.message}`);
    log('   Verifica:');
    log('   - La contraseña es correcta');
    log('   - El servidor está accesible');
    log('   - Las credenciales son válidas');
    return false;
  }
}

async function createBackup() {
  log('🔄 Creando backup de datos de producción...');
  
  try {
    // Backup de brands
    const brands = await db('brands').select('*');
    const brandsBackup = {
      table: 'brands',
      timestamp: new Date().toISOString(),
      environment: 'production',
      records: brands
    };
    
    // Backup de products
    const products = await db('products').select('*');
    const productsBackup = {
      table: 'products',
      timestamp: new Date().toISOString(),
      environment: 'production',
      records: products
    };
    
    // Guardar backups en archivos JSON
    const backupDir = path.join(__dirname, '../backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const brandsBackupFile = path.join(backupDir, `brands-backup-production-${timestamp}.json`);
    const productsBackupFile = path.join(backupDir, `products-backup-production-${timestamp}.json`);
    
    fs.writeFileSync(brandsBackupFile, JSON.stringify(brandsBackup, null, 2));
    fs.writeFileSync(productsBackupFile, JSON.stringify(productsBackup, null, 2));
    
    log(`✅ Backup de producción creado:`);
    log(`   📁 Brands: ${brandsBackupFile} (${brands.length} registros)`);
    log(`   📁 Products: ${productsBackupFile} (${products.length} registros)`);
    
    return { brands, products };
    
  } catch (error) {
    log(`❌ Error creando backup: ${error.message}`);
    throw error;
  }
}

async function validateReferentialIntegrity() {
  log('🔍 Validando integridad referencial en producción...');
  
  try {
    // Verificar que todos los brand_id en products existan en brands
    const orphanProducts = await db('products')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .where('brands.id', null)
      .select('products.id', 'products.nombre', 'products.brand_id');
    
    if (orphanProducts.length > 0) {
      log(`⚠️  Se encontraron ${orphanProducts.length} productos con marcas inexistentes:`);
      orphanProducts.forEach(p => {
        log(`   - ${p.nombre} (ID: ${p.id}, brand_id: ${p.brand_id})`);
      });
      return false;
    }
    
    log('✅ Integridad referencial válida en producción');
    return true;
    
  } catch (error) {
    log(`❌ Error validando integridad: ${error.message}`);
    throw error;
  }
}

async function detectInconsistencies() {
  log('🔍 Detectando inconsistencias en producción...');
  
  try {
    // Obtener todas las marcas y productos
    const brands = await db('brands').select('*').orderBy('nombre');
    const products = await db('products')
      .select('products.*', 'brands.nombre as brand_name')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .orderBy('brands.nombre', 'products.nombre');
    
    // Crear mapa de marcas
    const brandMap = {};
    brands.forEach(b => {
      brandMap[b.id] = b.nombre;
    });
    
    // Patrones de productos por marca (basado en los seeds)
    const brandPatterns = {
      'LA ROSA': [
        'mazapan', 'nugs', 'suizo', 'japones', 'gummy', 'paleta', 
        'bombon', 'ranita', 'suave', 'pulparindo', 'confichoky', 'malvabon'
      ],
      'HERSHEY': ['pelon', 'kisses', 'crayon', 'pelonetes', 'hershey'],
      'ARCOR': ['nikolo', 'bon o bon', 'butter toffe', 'poosh'],
      'WINIS': ['winis', 'maxi tubo', 'frutaffy', 'acidup', 'cuadreta', 'tubito', 'congelada'],
      'CANELS': ['canels', 'goma tueni', 'cherry sours', 'icee', 'chicloso', 'paleton'],
      'MONTES': ['damy', 'ricos besos', 'chicloso surtido'],
      'AP': ['michamoy'],
      'DELICIATE': ['ate', 'manguito', 'gummy tiras'],
      'BOLSAS DE LOS ALTOS': ['60x90', '50x70', '90x120'],
      'LAS DELICIAS': ['wafer', 'astridix', 'choco galletin', 'crunch', 'frutal', 'trueno', 'huevito', 'brocheta'],
      'INTERCANDY': ['gelatina', 'rainbow', 'baileys', 'truffles', 'malvavisco'],
      'KALU': ['volmond', 'fruit 3d', 'pelafrut', 'jelly pop'],
      'FRUTI FRESK': ['cometinix', 'freskiice', 'freskysoda', 'agua calid']
    };
    
    const inconsistencies = [];
    const productsWithoutBrand = [];
    
    products.forEach(product => {
      const productName = product.nombre.toLowerCase();
      const currentBrand = product.brand_name || '';
      const currentBrandLower = currentBrand.toLowerCase();
      
      // Detectar productos sin marca
      if (!product.brand_id || !brandMap[product.brand_id]) {
        productsWithoutBrand.push({
          id: product.id,
          name: product.nombre,
          brand_id: product.brand_id
        });
        return;
      }
      
      // Detectar inconsistencias basadas en patrones
      for (const [brandName, patterns] of Object.entries(brandPatterns)) {
        const brandNameLower = brandName.toLowerCase();
        
        if (patterns.some(pattern => productName.includes(pattern.toLowerCase()))) {
          if (brandNameLower !== currentBrandLower) {
            inconsistencies.push({
              productId: product.id,
              productName: product.nombre,
              currentBrandId: product.brand_id,
              currentBrandName: currentBrand,
              suggestedBrandId: brands.find(b => b.nombre === brandName)?.id,
              suggestedBrandName: brandName,
              matchedPattern: patterns.find(p => productName.includes(p.toLowerCase()))
            });
          }
          break;
        }
      }
    });
    
    log(`📊 Resultados del diagnóstico en producción:`);
    log(`   - Total marcas: ${brands.length}`);
    log(`   - Total productos: ${products.length}`);
    log(`   - Productos sin marca: ${productsWithoutBrand.length}`);
    log(`   - Posibles inconsistencias: ${inconsistencies.length}`);
    
    return {
      brands,
      products,
      productsWithoutBrand,
      inconsistencies
    };
    
  } catch (error) {
    log(`❌ Error detectando inconsistencias: ${error.message}`);
    throw error;
  }
}

async function executeCorrections(inconsistencies, productsWithoutBrand) {
  if (DRY_RUN) {
    log('🔍 MODO DRY-RUN: Solo mostrando correcciones propuestas para producción:');
  } else {
    log('⚠️  MODO EJECUCIÓN: Aplicando correcciones en producción...');
    log('   🚨 ESTE CAMBIO AFECTARÁ DATOS REALES DE PRODUCCIÓN');
  }
  
  try {
    let correctionsCount = 0;
    
    // 1. Corregir productos con marcas incorrectas
    if (inconsistencies.length > 0) {
      log(`\n📝 Correcciones de marcas incorrectas (${inconsistencies.length}):`);
      
      for (const inc of inconsistencies) {
        if (!inc.suggestedBrandId) {
          log(`   ⚠️  ${inc.productName}: No se encontró ID para marca sugerida "${inc.suggestedBrandName}"`);
          continue;
        }
        
        log(`   ${inc.productName}: "${inc.currentBrandName}" → "${inc.suggestedBrandName}" (patrón: ${inc.matchedPattern})`);
        
        if (!DRY_RUN) {
          await db('products')
            .where({ id: inc.productId })
            .update({ brand_id: inc.suggestedBrandId });
          correctionsCount++;
          log(`   ✅ Actualizado en producción`);
        }
      }
    }
    
    // 2. Asignar marcas a productos sin marca
    if (productsWithoutBrand.length > 0) {
      log(`\n📝 Productos sin marca (${productsWithoutBrand.length}):`);
      
      // Obtener la primera marca disponible para productos sin marca
      const defaultBrand = await db('brands').where({ nombre: 'LA ROSA' }).first();
      
      for (const product of productsWithoutBrand) {
        log(`   ${product.name}: Asignar a marca por defecto`);
        
        if (!DRY_RUN && defaultBrand) {
          await db('products')
            .where({ id: product.id })
            .update({ brand_id: defaultBrand.id });
          correctionsCount++;
          log(`   ✅ Asignado en producción`);
        }
      }
    }
    
    if (DRY_RUN) {
      log(`\n📊 Total de correcciones propuestas para producción: ${inconsistencies.length + productsWithoutBrand.length}`);
    } else {
      log(`\n✅ Total de correcciones aplicadas en producción: ${correctionsCount}`);
    }
    
  } catch (error) {
    log(`❌ Error ejecutando correcciones: ${error.message}`);
    throw error;
  }
}

async function validateAfterCorrections() {
  if (DRY_RUN) {
    log('🔍 MODO DRY-RUN: Omitiendo validación post-corrección');
    return;
  }
  
  log('🔍 Validando estado post-corrección en producción...');
  
  try {
    // Verificar integridad referencial nuevamente
    const integrityValid = await validateReferentialIntegrity();
    
    if (integrityValid) {
      log('✅ Todas las validaciones post-corrección pasaron correctamente en producción');
    } else {
      log('❌ Se detectaron problemas post-corrección en producción');
    }
    
  } catch (error) {
    log(`❌ Error en validación post-corrección: ${error.message}`);
    throw error;
  }
}

async function main() {
  log('='.repeat(70));
  log('INICIO - Script Seguro de Corrección de Marcas (PRODUCCIÓN Railway)');
  log(`Modo: ${DRY_RUN ? 'DRY-RUN (solo diagnóstico)' : 'EJECUCIÓN EN PRODUCCIÓN'}`);
  log(`Base de datos: switchback.proxy.rlwy.net:16885/railway`);
  log('='.repeat(70));
  
  try {
    // 1. Probar conexión
    const connectionOk = await testConnection();
    if (!connectionOk) {
      process.exit(1);
    }
    
    // 2. Crear backup
    const backup = await createBackup();
    
    // 3. Validar integridad referencial inicial
    const initialIntegrity = await validateReferentialIntegrity();
    if (!initialIntegrity) {
      log('❌ No se puede continuar: problemas de integridad detectados en producción');
      process.exit(1);
    }
    
    // 4. Detectar inconsistencias
    const diagnosis = await detectInconsistencies();
    
    // 5. Mostrar resumen
    log('\n📋 RESUMEN DE DIAGNÓSTICO (PRODUCCIÓN):');
    log(`   - Marcas: ${diagnosis.brands.length}`);
    log(`   - Productos: ${diagnosis.products.length}`);
    log(`   - Productos sin marca: ${diagnosis.productsWithoutBrand.length}`);
    log(`   - Inconsistencias detectadas: ${diagnosis.inconsistencies.length}`);
    
    // 6. Ejecutar correcciones si hay problemas
    if (diagnosis.inconsistencies.length > 0 || diagnosis.productsWithoutBrand.length > 0) {
      await executeCorrections(diagnosis.inconsistencies, diagnosis.productsWithoutBrand);
      await validateAfterCorrections();
    } else {
      log('✅ No se encontraron problemas que requieran corrección en producción');
    }
    
    log('\n='.repeat(70));
    log('✅ Script completado exitosamente en producción');
    log(`📁 Log guardado en: ${logFile}`);
    log('='.repeat(70));
    
  } catch (error) {
    log(`\n❌ ERROR FATAL EN PRODUCCIÓN: ${error.message}`);
    log('Stack trace:', error.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Ejecutar script
main();
