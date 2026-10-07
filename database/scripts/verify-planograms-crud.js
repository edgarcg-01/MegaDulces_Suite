/**
 * Verificación CRUD del módulo planograms tras agregar tenant_id explícito.
 * Ejerce las MISMAS queries que PlanogramsService (vía vistas public.brands/
 * public.products que delegan a catalog.*) dentro de UNA transacción que se
 * hace ROLLBACK al final — no persiste nada.
 *
 * Conecta como `postgres` (mismo user que KNEX_CONNECTION) → RLS bypassed →
 * el filtro tenant_id explícito es lo único que aísla. Eso es justo lo que
 * estamos validando.
 *
 * Uso (desde database/):  node scripts/verify-planograms-crud.js
 */
const knexLib = require('knex');
const cfg = require('../knexfile-newdb.js').development;
const knex = knexLib(cfg);

const T = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const OTHER = '00000000-0000-0000-0000-0000000000ff'; // tenant inexistente (aislamiento)
const stamp = Date.now();
const BRAND = `__VERIFY_BRAND_${stamp}`;
const PROD = `__VERIFY_PROD_${stamp}`;

let pass = 0;
let fail = 0;
function check(label, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label} ${extra}`);
  }
}

(async () => {
  console.log('Verificando CRUD planograms (transacción rollback)…\n');
  try {
    await knex.transaction(async (trx) => {
      // ── createBrand: INSERT con tenant_id explícito + returning ──
      const [brand] = await trx('brands')
        .insert({ tenant_id: T, activo: true, nombre: BRAND, orden: 999 })
        .returning('*');
      check('createBrand INSERT devuelve fila', !!brand && brand.id);
      check('createBrand persiste tenant_id correcto', brand.tenant_id === T, `(got ${brand.tenant_id})`);

      // ── addProduct: lookup brand scoped + INSERT producto ──
      const brandLookup = await trx('brands').where({ id: brand.id, tenant_id: T }).first();
      check('addProduct lookup de marca (scoped) encuentra la marca', !!brandLookup);

      const [product] = await trx('products')
        .insert({ tenant_id: T, activo: true, nombre: PROD, brand_id: brand.id, orden: 1 })
        .returning('*');
      check('addProduct INSERT devuelve fila', !!product && product.id);
      check('addProduct persiste tenant_id', product.tenant_id === T, `(got ${product.tenant_id})`);

      // ── getProduct: SELECT scoped ──
      const got = await trx('products').where({ id: product.id, tenant_id: T }).first();
      check('getProduct (scoped) encuentra el producto', !!got);
      const gotOther = await trx('products').where({ id: product.id, tenant_id: OTHER }).first();
      check('getProduct con OTRO tenant NO lo encuentra (aislamiento)', !gotOther);

      // ── getAll: SELECT scoped + orden ──
      const brands = await trx('brands')
        .where('tenant_id', T)
        .orderBy('orden', 'asc')
        .orderBy('nombre', 'asc');
      check('getAll lista marcas del tenant', brands.some((b) => b.id === brand.id));
      const brandsOther = await trx('brands').where('tenant_id', OTHER);
      check('getAll con OTRO tenant no incluye nuestra marca', !brandsOther.some((b) => b.id === brand.id));

      // ── updateBrand: UPDATE scoped + returning ──
      const [ub] = await trx('brands')
        .where({ id: brand.id, tenant_id: T })
        .update({ nombre: BRAND + '_UPD' })
        .returning('*');
      check('updateBrand UPDATE (scoped) devuelve fila', !!ub && ub.nombre === BRAND + '_UPD');

      const ubOther = await trx('brands')
        .where({ id: brand.id, tenant_id: OTHER })
        .update({ nombre: 'NO_DEBE_PASAR' })
        .returning('*');
      check('updateBrand con OTRO tenant NO actualiza (aislamiento)', Array.isArray(ubOther) && ubOther.length === 0);

      // ── reactivateBrand: UPDATE activo (columna REAL en brands) ──
      const [rb] = await trx('brands')
        .where({ id: brand.id, tenant_id: T })
        .update({ activo: false })
        .returning('*');
      check('updateBrand activo=false escribe (activo NO es GENERATED en brands)', rb.activo === false);

      // ── updateProduct: UPDATE scoped + returning ──
      const [up] = await trx('products')
        .where({ id: product.id, tenant_id: T })
        .update({ nombre: PROD + '_UPD' })
        .returning('*');
      check('updateProduct UPDATE (scoped) devuelve fila', !!up && up.nombre === PROD + '_UPD');

      // ── isProductReferenced: query daily_captures scoped ──
      const ref = await trx('daily_captures')
        .where('tenant_id', T)
        .whereRaw('exhibiciones @> ?::jsonb', [JSON.stringify([{ productosMarcados: [product.id] }])])
        .select('id')
        .first();
      check('isProductReferenced ejecuta sin error (producto nuevo = no referenciado)', !ref);

      // ── deleteProduct: DELETE scoped ──
      const delP = await trx('products').where({ id: product.id, tenant_id: T }).del();
      check('deleteProduct DELETE (scoped) borra 1 fila', delP === 1, `(got ${delP})`);

      // ── deleteBrand: DELETE scoped ──
      const delB = await trx('brands').where({ id: brand.id, tenant_id: T }).del();
      check('deleteBrand DELETE (scoped) borra 1 fila', delB === 1, `(got ${delB})`);

      // ── getVersion: MAX(updated_at) scoped ──
      const maxRow = await trx('brands').where('tenant_id', T).max('updated_at as m').first();
      check('getVersion MAX(updated_at) scoped ejecuta', maxRow !== undefined);

      throw new Error('__ROLLBACK__'); // no persistir
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') {
      console.error('\n✗ ERROR inesperado:', e.message);
      fail++;
    }
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} pasaron, ${fail} fallaron.`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})();
