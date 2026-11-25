// VEREDICTO independiente: relee la tienda y la juzga SIN usar resolver.js.
// Reimplementa la regla a mano, que es el punto: dos implementaciones, un resultado.
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const K = process.env.WIXK, SITE = process.env.LIVE;
const H = { Authorization: K, 'wix-site-id': SITE, 'Content-Type': 'application/json' };
const r2 = n => Math.round(Number(n) * 100) / 100;

async function paginar(url, clave) {
  const out = []; let cursor = null;
  do {
    const r = await fetch(url, { method: 'POST', headers: H,
      body: JSON.stringify({ search: { cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) } } }) });
    const j = await r.json();
    out.push(...(j[clave] || []));
    cursor = j.pagingMetadata && j.pagingMetadata.cursors && j.pagingMetadata.cursors.next;
  } while (cursor);
  return out;
}

(async () => {
  const base = await paginar('https://www.wixapis.com/stores/v3/products/search', 'products');
  const inv = await paginar('https://www.wixapis.com/stores/v3/inventory-items/search', 'inventoryItems');
  const full = []; let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < base.length) {
      const k = i++;
      const r = await fetch('https://www.wixapis.com/stores/v3/products/' + base[k].id, { headers: H });
      if (r.ok) full.push((await r.json()).product);
    }
  }));
  const kp = await (await fetch('http://192.168.0.222:30080/api/kp/precios-todos')).json();
  const kepler = new Map(kp.productos.map(p => [String(p.c), p]));
  const c = new Client({ connectionString: process.env.PROD_DB_URL });
  await c.connect(); await c.query('SET default_transaction_read_only = on');
  const skus = [...new Set(inv.map(x => x.product && x.product.variantSku).filter(Boolean))];
  const ex = new Map((await c.query(
    'select sku, sum(qty_stock_units)::numeric q from analytics.v_erp_stock_on_hand where sku = any($1) group by 1',
    [skus])).rows.map(r => [r.sku, Number(r.q)]));
  await c.end();
  console.log('tienda releida:', full.length, 'productos,', inv.length, 'items | mostrador', kp.generado);

  const nombreDe = new Map(inv.map(x => [x.variantId, x.product && x.product.variantName]));
  const qtyDe = new Map(inv.map(x => [x.variantId, Number(x.quantity || 0)]));
  const estDe = new Map(inv.map(x => [x.variantId, x.availabilityStatus]));
  // la regla, reescrita a mano
  const unidad = (nom, k) => {
    const m = { Caja: 'CJA', Paquete: 'PAQ', Pieza: 'PZA', Kilo: 'KG', Bulto: 'BTO' }[nom];
    if (m) return k.u.find(u => u.u === m);
    const cod = k.u.find(u => String(u.u).toUpperCase() === String(nom).trim().toUpperCase());
    if (cod) return cod;
    return k.u.length === 1 ? k.u[0] : null;
  };

  let visibles = 0, precioOk = 0, precioMal = 0, muertosVisibles = 0, piezaVisible = 0, sinJuzgar = 0;
  const ofrecePorSku = new Map();
  const malos = [];
  for (const p of full) for (const v of (p.variantsInfo && p.variantsInfo.variants) || []) {
    const vis = v.visible !== false;
    const nom = nombreDe.get(v.id);
    const k = v.sku ? kepler.get(String(v.sku)) : null;
    if (vis) visibles++;
    if (!k) { if (vis) muertosVisibles++; continue; }
    if (nom === 'Pieza' && !k.u.some(u => u.u === 'PZA')) { if (vis) piezaVisible++; continue; }
    const u = unidad(nom, k);
    if (!u || u.p == null) { sinJuzgar++; continue; }
    if (r2(v.price.actualPrice.amount) === r2(u.p)) precioOk++;
    else { precioMal++; if (malos.length < 6) malos.push(v.sku + ' ' + nom + ' wix=' + r2(v.price.actualPrice.amount) + ' kepler=' + r2(u.p)); }
    const e = ofrecePorSku.get(v.sku) || 0;
    ofrecePorSku.set(v.sku, e + (qtyDe.get(v.id) || 0) * Number(u.f));
  }

  let exceden = 0; const peores = [];
  for (const [sku, ofrece] of ofrecePorSku) {
    const hay = ex.get(sku) || 0;
    if (ofrece > hay + 0.001) { exceden++; peores.push(sku + ': ofrece ' + Math.round(ofrece) + ', hay ' + Math.round(hay)); }
  }
  const est = {}; for (const x of inv) est[x.availabilityStatus] = (est[x.availabilityStatus] || 0) + 1;

  console.log('\n== PRECIO ==');
  console.log('  igual al mostrador :', precioOk);
  console.log('  difiere            :', precioMal, precioMal === 0 ? '' : '  <- revisar');
  malos.forEach(m => console.log('     ', m));
  console.log('  no juzgables (se declaran):', sinJuzgar);
  console.log('\n== LO QUE NO DEBE ESTAR A LA VENTA ==');
  console.log('  SKU muerto, todavia visible :', muertosVisibles, muertosVisibles === 0 ? 'OK' : '<- revisar');
  console.log('  "Pieza" inventada, visible  :', piezaVisible, piezaVisible === 0 ? 'OK' : '<- revisar');
  console.log('\n== CANTIDAD ==');
  console.log('  SKU que ofrecen mas de lo que hay:', exceden, exceden === 0 ? 'OK (eran 146)' : '<- revisar');
  peores.slice(0, 6).forEach(m => console.log('     ', m));
  console.log('\n== ESTADO ==');
  console.log(' ', JSON.stringify(est), '| variantes visibles:', visibles, 'de', inv.length);

  const verde = precioMal === 0 && muertosVisibles === 0 && piezaVisible === 0 && exceden === 0;
  console.log('\n' + (verde ? 'VEREDICTO: EN VERDE' : 'VEREDICTO: HAY QUE REVISAR'));
  if (!verde) process.exitCode = 1;
})().catch(e => { console.error('ERR', e.message); process.exitCode = 1; });
