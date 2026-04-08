
const knex = require('knex');
const config = require('../database/knexfile.js');
const db = knex(config.development);

async function run() {
  try {
    console.log('🚀 Iniciando CARGA MAESTRA DE DATOS...');
    
    // 1. Limpieza en orden estricto de dependencias
    const tablesToClean = [
      'exhibition_photos',
      'exhibitions',
      'daily_captures',
      'captures',
      'visits',
      'stores',
      'users',
      'roles',
      'products',
      'brands',
      'catalogs',
      'scoring_config'
    ];

    console.log('🧹 Limpiando tablas existentes...');
    for (const table of tablesToClean) {
      try {
        await db(table).del();
        console.log(`  - ${table} limpia.`);
      } catch (e) {
        // Silenciamos errores si la tabla no existe o ya está limpia
      }
    }
    
    // 2. Ejecutar seeds en orden
    console.log('📥 Insertando nuevos datos...');
    
    const seedFiles = [
      '01_roles_iniciales.js',
      '01_admin_users.js',
      '03_planograma.js',
      '04_catalogs.js',
      '05_scoring_config.js'
    ];

    for (const file of seedFiles) {
      const { seed } = require(`../database/seeds/${file}`);
      await seed(db);
      console.log(`  -> ${file} cargado.`);
    }

    console.log('\n✅ ¡ESTRUCTURA DE DATOS ACTUALIZADA!');
    console.log('------------------------------------');
    console.log('   - 13 Marcas y sus productos (Planogramas)');
    console.log('   - 15 Rutas configuradas.');
    console.log('   - Usuarios Admin/Superoot habilitados.');
    console.log('------------------------------------');

  } catch (error) {
    console.error('\n❌ ERROR:', error);
  } finally {
    await db.destroy();
  }
}

run();
