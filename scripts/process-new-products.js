const fs = require('fs');
const knex = require('knex');
const config = require('../database/knexfile.js').development;
const db = knex(config);

async function processNewProducts() {
  console.log('🔍 Procesando nuevos productos del archivo kjb_clean.md...');
  
  try {
    // Leer el archivo
    const content = fs.readFileSync('kjb_clean.md', 'utf8');
    const lines = content.split('\n');
    
    // Extraer marcas y productos
    const brandProducts = {};
    let currentBrand = null;
    
    // Lista de marcas válidas conocidas para evitar falsos positivos del OCR
    const knownValidBrands = [
      'Mars', 'Mondelez', 'Ricolino', 'Ferrero', 'De la Rosa', 'Bolsas de los Altos',
      'Delicias', 'Canel\'s', 'Hershey', 'AP', 'Bimbo', 'Barcel', 'Pepsico',
      'Reyma', 'Tinajita', 'Hubin', 'Cabaduas', 'Gonac', 'Nutresa', 'Totis',
      'Frutifresk', 'Arcor', 'Winis', 'Qualamex', 'Aproza', 'Montes', 'Nestlé',
      'Lussel', 'La Posse', 'Jovy', 'Pin Pon', 'Intercandy', 'Dart', 'Jaguar',
      'Alteno', 'Providencia', 'Bokados', 'Perfetti', 'Chupachups', 'Volt',
      'Chompys', 'Anahuac', 'Abarrotes', 'Puro Relajo', 'Pigui', 'Cool Toons',
      'Cimarron', 'Kalu', 'Jumex', 'Gomez', 'Gaby', 'Ajemex', 'Bondy', 'Boing',
      'Super', 'Palmer', 'Dulandy', 'Quala', 'Sonrics', 'Gamesa', 'Marinela',
      'Columbia', 'La Rosa', 'HERSHEY', 'ARCOR', 'WINIS', 'CANELS', 'MONTES',
      'DELICIATE', 'INTERCANDY', 'KALU', 'FRUTI FRESK', 'BOLSAS DE LOS ALTOS',
      'LAS DELICIAS', 'AP', 'NUTRESA', 'KLASSCO', 'QUALAMEX', 'TOTIS',
      'SONRICS', 'GAMESA', 'MARINELA', 'COLONBINA', 'LAPOSSE', 'JOVY',
      'PIN PON', 'DART', 'JAGUAR', 'JHONNY', 'PROVIDENCIA', 'PERFETI',
      'CHUPA CHUPS', 'LUSS', 'ANAHUAC', 'PAF', 'PIGUI', 'COOL TOONS',
      'CIMARRON', 'KALU', 'JUMEX', 'GOMEZ', 'GABY', 'BONDY', 'BOING',
      'DULANDY', 'QUALA', 'TOTIS', 'NUTRESA', 'CABADAS', 'GONAC',
      'HUBIN', 'NUTRESA', 'TOTIS', 'FRUTI FRESK', 'ARCOR', 'WINIS'
    ];
    
    lines.forEach(line => {
      line = line.trim();
      
      // Detectar marcas (solo las que están en la lista de marcas válidas)
      if (line && knownValidBrands.includes(line) && 
          !line.includes('Artículo / Nombre') && !line.includes('/') && 
          !line.match(/^\d+$/) && !line.includes('Nota:') &&
          !line.includes('detectado por OCR')) {
        
        // Es una marca válida
        currentBrand = line;
        if (!brandProducts[currentBrand]) {
          brandProducts[currentBrand] = [];
        }
      } 
      // Detectar productos (líneas que contienen "/" o son nombres de productos)
      else if (line && line !== 'Artículo / Nombre' && 
               (line.includes('/') || line.length > 5) && 
               currentBrand && !line.includes('Nota:') &&
               !line.includes('detectado por OCR')) {
        
        // Es un producto
        const productName = line.split('/')[0].trim();
        if (productName && productName.length > 2) {
          brandProducts[currentBrand].push(productName);
        }
      }
    });
    
    console.log('📊 Marcas y productos encontrados:');
    Object.entries(brandProducts).forEach(([brand, products]) => {
      console.log(`   ${brand}: ${products.length} productos`);
    });
    
    // Obtener marcas existentes en BD
    const existingBrands = await db('brands').select('*');
    const existingBrandNames = existingBrands.map(b => b.nombre);
    
    console.log('\n📋 Marcas existentes en BD:');
    console.log('   ', existingBrandNames.join(', '));
    
    // Identificar marcas nuevas
    const newBrands = Object.keys(brandProducts).filter(brand => 
      !existingBrandNames.includes(brand)
    );
    
    console.log('\n🆕 Marcas nuevas para agregar:');
    console.log('   ', newBrands.join(', '));
    
    // Obtener productos existentes
    const existingProducts = await db('products').select('*');
    const existingProductNames = existingProducts.map(p => p.nombre);
    
    // Identificar productos nuevos y existentes
    const newProducts = [];
    const existingProductsInFile = [];
    
    Object.entries(brandProducts).forEach(([brand, products]) => {
      products.forEach(product => {
        if (existingProductNames.includes(product)) {
          existingProductsInFile.push({ product, brand });
        } else {
          newProducts.push({ product, brand });
        }
      });
    });
    
    console.log(`\n📈 Resumen:`);
    console.log(`   - Productos nuevos: ${newProducts.length}`);
    console.log(`   - Productos ya existentes: ${existingProductsInFile.length}`);
    console.log(`   - Marcas nuevas: ${newBrands.length}`);
    
    // Mostrar productos existentes que podrían necesitar corrección de marca
    const brandCorrections = [];
    existingProductsInFile.forEach(({ product, brand }) => {
      const existingProduct = existingProducts.find(p => p.nombre === product);
      const existingBrand = existingBrands.find(b => b.id === existingProduct.brand_id);
      
      if (existingBrand && existingBrand.nombre !== brand) {
        brandCorrections.push({
          product,
          currentBrand: existingBrand.nombre,
          suggestedBrand: brand
        });
      }
    });
    
    if (brandCorrections.length > 0) {
      console.log(`\n⚠️  Productos existentes que podrían necesitar corrección de marca:`);
      brandCorrections.forEach(({ product, currentBrand, suggestedBrand }) => {
        console.log(`   - ${product}: ${currentBrand} → ${suggestedBrand}`);
      });
    }
    
    // Generar datos para migración (sin IDs, dejar que PostgreSQL los genere)
    const migrationData = {
      newBrands: newBrands.map((name, index) => ({
        nombre: name,
        activo: true,
        orden: existingBrands.length + index + 1
      })),
      newProducts: newProducts.map((item, index) => ({
        nombre: item.product,
        brand_name: item.brand,
        activo: true,
        orden: 0,
        puntuacion: 5
      })),
      brandCorrections
    };
    
    // Guardar datos para migración
    fs.writeFileSync(
      'migration-data.json',
      JSON.stringify(migrationData, null, 2)
    );
    
    console.log(`\n✅ Datos guardados en migration-data.json`);
    console.log(`   - ${migrationData.newBrands.length} marcas nuevas`);
    console.log(`   - ${migrationData.newProducts.length} productos nuevos`);
    console.log(`   - ${migrationData.brandCorrections.length} correcciones de marca`);
    
  } catch (error) {
    console.error('❌ Error procesando productos:', error.message);
  } finally {
    await db.destroy();
  }
}

processNewProducts();
