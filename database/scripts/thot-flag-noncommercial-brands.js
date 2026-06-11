/* eslint-disable no-console */
/**
 * Marca como NO comerciales las marcas que son artefactos (no producto vendible):
 * bundles promocionales "= GRATIS" y descartes. Estaban `is_commercial=true` por
 * error y contaminaban el catálogo del vendedor y las señales de Thot (afinidad/zona).
 *
 * Conservador: SOLO promo/descarte. Empaque/desechables (DART, envases) se dejan
 * — un distribuidor sí puede venderlos a la tienda (decisión aparte).
 *
 * Idempotente, reversible (poner is_commercial=true). Afecta take-order (commercial_only)
 * y el feature store de Thot. Correr donde aplique (Docker y prod).
 *
 * Uso: node database/scripts/thot-flag-noncommercial-brands.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
const T = '00000000-0000-0000-0000-00000000d01c';

const NON_COMMERCIAL = [
  // promo / meta (artefactos, no producto vendible)
  'PROMOCIONES', 'PROMOCIONES ESPECIALES', 'OFERTAS',
  'PRODUCTOS A ELIMINAR', 'PRODUCTOS VARIOS', 'PRODUCTOS CON BAJA ROTACION',
  // servicios / insumos internos (no se le impulsan al tendero)
  'D. IMAGEN PRINTS SA DE CV', // etiquetas / impresión
  'DEPOSITO RECARGA S.A. DE C.V.', // tiempo aire / recargas
  // NOTA: empaque/desechables (DART, ENVASES, BOLSAS) quedan FUERA a propósito —
  // un distribuidor sí puede vendérselos a la tienda (decisión del negocio).
];

(async () => {
  try {
    const before = await knex('catalog.brands')
      .where({ tenant_id: T }).whereIn('nombre', NON_COMMERCIAL)
      .select('nombre', 'is_commercial');
    console.log('Marcas objetivo:', before.map((b) => `${b.nombre}(${b.is_commercial})`).join(', ') || '(ninguna)');

    const n = await knex('catalog.brands')
      .where({ tenant_id: T }).whereIn('nombre', NON_COMMERCIAL).whereNot('is_commercial', false)
      .update({ is_commercial: false, updated_at: knex.fn.now() });
    console.log(`Marcas → is_commercial=false: ${n}`);

    const prods = await knex('catalog.products as p')
      .join('catalog.brands as b', function () {
        this.on('b.id', '=', 'p.brand_id').andOn('b.tenant_id', '=', 'p.tenant_id');
      })
      .where('p.tenant_id', T).whereNull('p.deleted_at').whereIn('b.nombre', NON_COMMERCIAL)
      .count('p.id as c').first();
    console.log(`Productos que salen del catálogo comercial: ${prods.c}`);
    console.log('OK. Reversible: update catalog.brands set is_commercial=true where nombre in (...).');
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
