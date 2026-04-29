/**
 * Script para diagnosticar productos con marcas incorrectas en producción
 * 
 * Uso: node scripts/diagnose-brand-product-mismatch.js
 * 
 * Este script:
 * 1. Obtiene todas las marcas y sus productos
 * 2. Detecta inconsistencias basadas en patrones de nombres
 * 3. Genera un reporte de productos que podrían estar en marcas incorrectas
 */

const knex = require('knex');

// Cargar configuración de la base de datos desde knexfile
const knexConfig = require('../database/knexfile');

// Usar configuración de producción si existe, sino development
const env = process.env.NODE_ENV || 'development';
const config = knexConfig[env] || knexConfig.development;

const db = knex(config);

async function diagnoseBrandProductMismatch() {
  console.log('========================================');
  console.log('DIAGNÓSTICO DE PRODUCTOS Y MARCAS');
  console.log('========================================\n');

  try {
    // 1. Obtener todas las marcas
    const brands = await db('brands').select('*').orderBy('nombre');
    console.log(`Total de marcas: ${brands.length}\n`);
    
    // 2. Obtener todos los productos con sus marcas
    const products = await db('products')
      .select('products.*', 'brands.nombre as brand_name')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .orderBy('brands.nombre', 'products.nombre');
    
    console.log(`Total de productos: ${products.length}\n`);
    
    // 3. Crear mapa de marcas para referencia rápida
    const brandMap = {};
    brands.forEach(b => {
      brandMap[b.id] = b.nombre;
    });
    
    // 4. Agrupar productos por marca
    const productsByBrand = {};
    products.forEach(p => {
      if (!productsByBrand[p.brand_id]) {
        productsByBrand[p.brand_id] = {
          brand_name: p.brand_name || 'MARCA NO ENCONTRADA',
          products: []
        };
      }
      productsByBrand[p.brand_id].products.push(p);
    });
    
    // 5. Mostrar resumen por marca
    console.log('========================================');
    console.log('RESUMEN POR MARCA');
    console.log('========================================\n');
    
    Object.entries(productsByBrand).forEach(([brandId, data]) => {
      console.log(`📦 ${data.brand_name} (${data.products.length} productos)`);
      data.products.forEach(p => {
        console.log(`   - ${p.nombre} (ID: ${p.id})`);
      });
      console.log('');
    });
    
    // 6. Detectar productos sin marca asignada
    console.log('\n========================================');
    console.log('PRODUCTOS SIN MARCA ASIGNADA');
    console.log('========================================\n');
    
    const productsWithoutBrand = products.filter(p => !p.brand_id || !brandMap[p.brand_id]);
    if (productsWithoutBrand.length === 0) {
      console.log('✅ Todos los productos tienen una marca asignada válida.\n');
    } else {
      console.log(`⚠️  ${productsWithoutBrand.length} productos sin marca asignada:\n`);
      productsWithoutBrand.forEach(p => {
        console.log(`   - ${p.nombre} (ID: ${p.id}, brand_id: ${p.brand_id || 'NULL'})`);
      });
      console.log('');
    }
    
    // 7. Detectar inconsistencias basadas en patrones de nombres
    console.log('\n========================================');
    console.log('ANÁLISIS DE INCONSISTENCIAS (Patrones)');
    console.log('========================================\n');
    
    const potentialMismatches = [];
    
    // Patrones comunes de productos que deberían pertenecer a ciertas marcas
    const brandPatterns = {
      'LA ROSA': ['mazapan', 'nugs', 'suizo', 'japones', 'gummy', 'paleta', 'bombon', 'ranita', 'suave', 'pulparindo', 'confichoky'],
      'HERSHEY': ['pelon', 'kisses', 'crayon', 'pelonetes', 'hershey'],
      'ARCOR': ['nikolo', 'bon o bon', 'butter toffe', 'poosh'],
      'WINIS': ['winis', 'maxi tubo', 'frutaffy', 'acidup', 'cuadreta', 'tubito'],
      'CANELS': ['canels', 'goma tueni', 'cherry sours', 'icee', 'chicloso', 'paleton'],
      'MONTES': ['damy', 'ricos besos', 'chicloso surtido'],
      'AP': ['michamoy'],
      'DELICIATE': ['ate', 'manguito', 'gummy tiras'],
      'LAS DELICIAS': ['wafer', 'astridix', 'choco galletin', 'crunch', 'frutal', 'trueno', 'huevito', 'brocheta'],
      'INTERCANDY': ['gelatina', 'rainbow', 'baileys', 'truffles', 'malvavisco'],
      'KALU': ['volmond', 'fruit 3d', 'pelafrut', 'jelly pop'],
      'FRUTI FRESK': ['cometinix', 'freskiice', 'freskysoda', 'agua calid']
    };
    
    products.forEach(product => {
      const productName = product.nombre.toLowerCase();
      const currentBrand = product.brand_name || '';
      const currentBrandLower = currentBrand.toLowerCase();
      
      // Verificar si el producto debería estar en otra marca según el patrón
      for (const [brandName, patterns] of Object.entries(brandPatterns)) {
        const brandNameLower = brandName.toLowerCase();
        
        // Si el producto coincide con el patrón de una marca diferente a la actual
        if (patterns.some(pattern => productName.includes(pattern.toLowerCase()))) {
          if (brandNameLower !== currentBrandLower) {
            potentialMismatches.push({
              product: product.nombre,
              productId: product.id,
              currentBrand: currentBrand || 'SIN MARCA',
              currentBrandId: product.brand_id,
              suggestedBrand: brandName,
              pattern: patterns.find(p => productName.includes(p.toLowerCase()))
            });
          }
          break; // Solo sugerir la primera coincidencia
        }
      }
    });
    
    if (potentialMismatches.length === 0) {
      console.log('✅ No se detectaron inconsistencias basadas en patrones de nombres.\n');
    } else {
      console.log(`⚠️  Se encontraron ${potentialMismatches.length} posibles inconsistencias:\n`);
      potentialMismatches.forEach((m, i) => {
        console.log(`${i + 1}. Producto: ${m.product}`);
        console.log(`   ID: ${m.productId}`);
        console.log(`   Marca actual: ${m.currentBrand} (${m.currentBrandId})`);
        console.log(`   Marca sugerida: ${m.suggestedBrand} (patrón: "${m.pattern}")`);
        console.log('');
      });
    }
    
    // 8. Generar SQL de corrección (opcional)
    if (potentialMismatches.length > 0) {
      console.log('\n========================================');
      console.log('SQL DE CORRECCIÓN SUGERIDO');
      console.log('========================================\n');
      console.log('-- Revisa cuidadosamente antes de ejecutar en producción:\n');
      
      // Obtener IDs de marcas para el SQL
      for (const mismatch of potentialMismatches) {
        const suggestedBrand = brands.find(b => b.nombre === mismatch.suggestedBrand);
        if (suggestedBrand) {
          console.log(`-- ${mismatch.product}: de "${mismatch.currentBrand}" a "${mismatch.suggestedBrand}"`);
          console.log(`UPDATE products SET brand_id = '${suggestedBrand.id}' WHERE id = '${mismatch.productId}';`);
          console.log('');
        }
      }
    }
    
    console.log('\n========================================');
    console.log('DIAGNÓSTICO COMPLETADO');
    console.log('========================================');
    
  } catch (error) {
    console.error('❌ Error durante el diagnóstico:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
}

// Ejecutar diagnóstico
diagnoseBrandProductMismatch();
