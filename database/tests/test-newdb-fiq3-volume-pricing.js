/* eslint-disable no-console */
/**
 * FIQ.3 (tiers de volumen) — Smoke de resolvePriceForQty. Verifica, contra DATA
 * REAL, que el precio/pza elegido = el MEJOR (menor) tier con min_qty <= qty, y que
 * comprar más (caja) nunca sale más caro por pieza que comprar suelto. DB-direct.
 *
 * Replica EXACTAMENTE la selección de tier que hace CommercialPricingService.
 * resolvePriceForQty (lowest price where min_qty <= qty), y la compara contra un
 * cómputo JS independiente sobre los tiers reales del producto.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

// Réplica JS de resolvePriceForQty: mejor precio con min_qty <= qty (null si por debajo del mínimo).
function jsResolve(tiers, qty) {
  const applicable = tiers.filter((t) => Number(t.min_qty) <= qty);
  if (!applicable.length) return null;
  return applicable.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a));
}

(async () => {
  try {
    // Producto con >=3 tiers distintos (varios min_qty) y factor > 1.
    const pr = await knex.raw(`
      SELECT p.id, p.nombre, COALESCE(p.factor_sale,1) factor
      FROM catalog.products p
      WHERE p.tenant_id=? AND p.deleted_at IS NULL AND COALESCE(p.factor_sale,1)>1
        AND (SELECT count(DISTINCT min_qty) FROM commercial.product_prices pp
             WHERE pp.product_id=p.id AND pp.tenant_id=? AND pp.deleted_at IS NULL) >= 2
      LIMIT 1`, [T, T]);
    const p = pr.rows[0];
    ok(!!p, 'hay producto multi-tier con factor>1 para probar');
    if (!p) throw new Error('no multi-tier product');
    const factor = Number(p.factor);
    console.log(`  producto: ${p.nombre} (factor ${factor})`);

    const tiers = await knex('commercial.product_prices')
      .where({ tenant_id: T, product_id: p.id }).whereNull('deleted_at')
      .select('price', 'min_qty').orderBy('min_qty', 'asc');
    const minPurchase = Number(tiers[0].min_qty);
    console.log('  tiers:', tiers.map((t) => `${t.min_qty}pz→$${Number(t.price).toFixed(2)}`).join('  '));

    // Query REAL (lo que hace resolvePriceForQty) vs cómputo JS, en varias cantidades.
    const qtys = [1, minPurchase, minPurchase + 1, factor, factor * 5, 9999];
    for (const q of qtys) {
      const sqlRow = await knex('commercial.product_prices')
        .where({ tenant_id: T, product_id: p.id }).whereNull('deleted_at')
        .where('min_qty', '<=', q).orderBy('price', 'asc').first('price');
      const js = jsResolve(tiers, q);
      const sqlPrice = sqlRow ? Number(sqlRow.price) : null;
      const jsPrice = js ? Number(js.price) : null;
      ok(sqlPrice === jsPrice, `qty ${q}: tier SQL=$${sqlPrice} == JS=$${jsPrice}`);
    }

    // Invariante de negocio: comprar la CAJA (factor) nunca sale más caro por pieza
    // que comprar el mínimo suelto (el precio por volumen es <=).
    const pPiece = jsResolve(tiers, minPurchase);
    const pBox = jsResolve(tiers, factor);
    if (pPiece && pBox) {
      ok(Number(pBox.price) <= Number(pPiece.price), `caja ($${Number(pBox.price).toFixed(2)}/pz) <= suelto ($${Number(pPiece.price).toFixed(2)}/pz)`);
    }
    // Por debajo del mínimo de compra → sin tier (el pedido debe rechazar/bumpear).
    if (minPurchase > 1) {
      const below = await knex('commercial.product_prices')
        .where({ tenant_id: T, product_id: p.id }).whereNull('deleted_at')
        .where('min_qty', '<=', minPurchase - 1).orderBy('price', 'asc').first('price');
      ok(!below, `qty ${minPurchase - 1} (< mínimo ${minPurchase}) → sin tier aplicable`);
    }

    console.log(`\nFIQ.3 volume-pricing: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
