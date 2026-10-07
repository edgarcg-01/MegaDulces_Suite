/* eslint-disable no-console */
/**
 * Setea la price list default del tenant (mega_dulces) — para que el catálogo
 * del vendedor/portal resuelva a la lista COMPLETA (P1 = precio_sucursal, 6,351
 * precios, mantenida por el importer nightly) en vez del stub legacy BASE-MXN (810).
 *
 * No copia datos: solo mueve el flag is_default. Reversible (correr con el código
 * anterior, p.ej. BASE-MXN). Idempotente.
 *
 * Uso:
 *   node database/scripts/set-vendor-default-pricelist.js            # P1 (default)
 *   node database/scripts/set-vendor-default-pricelist.js BASE-MXN   # revertir
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW, pool: { min: 0, max: 2 } });
const T = '00000000-0000-0000-0000-00000000d01c';
const CODE = (process.argv[2] || 'P1').toUpperCase();

(async () => {
  try {
    await knex.transaction(async (trx) => {
      const target = await trx('commercial.price_lists')
        .where({ tenant_id: T, code: CODE }).whereNull('deleted_at').first('id', 'code', 'is_default');
      if (!target) throw new Error(`Price list ${CODE} no existe en el tenant`);

      const prev = await trx('commercial.price_lists')
        .where({ tenant_id: T, is_default: true }).whereNull('deleted_at').select('code');
      console.log('Default actual:', prev.map((p) => p.code).join(', ') || '(ninguno)');

      // Mismo patrón que CommercialPricingService.clearDefaultPriceList: limpiar y setear uno.
      await trx('commercial.price_lists').where({ tenant_id: T, is_default: true })
        .update({ is_default: false, updated_at: trx.fn.now() });
      await trx('commercial.price_lists').where({ tenant_id: T, id: target.id })
        .update({ is_default: true, active: true, updated_at: trx.fn.now() });

      const n = await trx('commercial.product_prices')
        .where({ tenant_id: T, price_list_id: target.id }).whereNull('deleted_at').where('price', '>', 0)
        .count('* as c').first();
      console.log(`Nuevo default: ${CODE} (${n.c} precios > 0)`);
    });
    console.log('OK. Reversible: node set-vendor-default-pricelist.js BASE-MXN');
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  } finally {
    await knex.destroy();
  }
})();
