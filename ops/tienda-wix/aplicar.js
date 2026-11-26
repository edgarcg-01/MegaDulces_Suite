// APLICADOR. Lleva la tienda a lo que dice nuestro dato. Corre en ensayo por
// defecto; escribe solo con --aplicar. Incorpora lo aprendido en [CV.29]:
//   - un PATCH con variantsInfo parcial REEMPLAZA: va `options` + la lista COMPLETA
//   - canario reversible antes del lote
//   - foto previa a archivo antes de tocar nada
//   - se verifica RELEYENDO la tienda, no el acuse de la escritura
//
// Uso:  WIXK=<llave> LIVE=<siteId> node aplicar.js [--aplicar] [--limite N] [--tope N]
require('dotenv').config({ quiet: true });
const fs = require('fs');
const { Client } = require('pg');
const D = __dirname + '/';
const { repartir, accionDe } = require(D + 'resolver.js');

// La llave vive en .env (ignorado por git; el repo es PUBLICO), o se pasa por entorno.
const K = process.env.WIXK || process.env.WIX_API_KEY;
const SITE = process.env.LIVE || process.env.WIX_SITE_ID;
const APLICAR = process.argv.includes('--aplicar');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const LIMITE = arg('--limite', Infinity), TOPE = arg('--tope', 50);
/** `--skus 95612,17064`: empuja solo esos. Vacio = toda la tienda, como siempre. */
const SOLO_SKUS = (() => {
  const i = process.argv.indexOf('--skus');
  if (i < 0) return null;
  const lista = String(process.argv[i + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return lista.length ? [...new Set(lista)] : null;
})();
const H = { Authorization: K, 'wix-site-id': SITE, 'Content-Type': 'application/json' };
const r2 = n => Math.round(Number(n) * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!K || !SITE) {
  console.error('Falta WIXK o LIVE en el entorno. La llave NO se escribe en el repo ni en un .env versionado.');
  process.exit(1);
}

const leerProducto = async id => {
  const r = await fetch('https://www.wixapis.com/stores/v3/products/' + id, { headers: H });
  if (!r.ok) throw new Error('GET producto ' + id + ': ' + r.status);
  return (await r.json()).product;
};

async function paginar(url, clave) {
  const out = [];
  let cursor = null;
  do {
    const r = await fetch(url, {
      method: 'POST', headers: H,
      body: JSON.stringify({ search: { cursorPaging: { limit: 100, ...(cursor ? { cursor } : {}) } } }),
    });
    if (!r.ok) throw new Error(url + ': ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    out.push(...(j[clave] || []));
    cursor = j.pagingMetadata && j.pagingMetadata.cursors && j.pagingMetadata.cursors.next;
  } while (cursor);
  return out;
}

async function planear() {
  console.log('1) leyendo la tienda viva...');
  const productos = await paginar('https://www.wixapis.com/stores/v3/products/search', 'products');
  const inv = await paginar('https://www.wixapis.com/stores/v3/inventory-items/search', 'inventoryItems');

  // `--skus`: empujar SOLO lo que cambio. Es la forma que necesita el disparo por
  // evento; releer los 637 productos para mover 3 renglones es el modo caro.
  // El inventario SI se lee entero: es una sola consulta paginada y de ahi sale la
  // presentacion de cada variante. Lo caro es el GET por producto, y eso es lo que
  // se acota. Sin `--skus` se comporta igual que siempre.
  let aLeer = productos;
  if (SOLO_SKUS) {
    const quiero = new Set(SOLO_SKUS);
    const idsConEseSku = new Set(
      inv.filter((x) => x.product && quiero.has(String(x.product.variantSku))).map((x) => x.productId),
    );
    aLeer = productos.filter((p) => idsConEseSku.has(p.id));
    console.log(`   --skus: ${SOLO_SKUS.length} pedidos -> ${aLeer.length} productos de ${productos.length}`);
    const sinUbicar = [...quiero].filter(
      (s) => !inv.some((x) => x.product && String(x.product.variantSku) === s),
    );
    if (sinUbicar.length) console.log('   ⚠️ NO estan publicados en la tienda:', sinUbicar.join(', '));
  }

  // la busqueda no devuelve variantsInfo completo: se relee cada producto
  const full = [];
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < aLeer.length) { const k = i++; full.push(await leerProducto(aLeer[k].id)); }
  }));
  console.log('   productos:', full.length, '| items de inventario:', inv.length);

  console.log('2) mostrador de Kepler y existencia arbitrada...');
  const kp = await (await fetch('http://192.168.0.222:30080/api/kp/precios-todos')).json();
  const porSku = new Map(kp.productos.map(p => [String(p.c), p]));
  const c = new Client({ connectionString: process.env.PROD_DB_URL });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  const si = (await c.query('select system_identifier from pg_control_system()')).rows[0].system_identifier;
  if (String(si) !== '7688376744939610156') { await c.end(); throw new Error('NO es pg-prod: ' + si); }
  const skus = [...new Set(inv.map(x => x.product && x.product.variantSku).filter(Boolean))];
  const ex = new Map((await c.query(
    'select sku, sum(qty_stock_units)::numeric q from analytics.v_erp_stock_on_hand where sku = any($1) group by 1',
    [skus])).rows.map(r => [r.sku, Number(r.q)]));
  await c.end();
  console.log('   mostrador', kp.generado, '| existencia pg-prod', si, '| tope', TOPE);

  const itemPorVar = new Map(inv.map(x => [x.variantId, x]));
  const filas = [];
  for (const p of full) for (const v of (p.variantsInfo && p.variantsInfo.variants) || []) {
    const it = itemPorVar.get(v.id);
    const nom = it && it.product ? it.product.variantName : null;
    const k = v.sku ? porSku.get(String(v.sku)) : null;
    filas.push({
      productoId: p.id, producto: p.name, variantId: v.id, itemId: it && it.id,
      itemRev: it && it.revision, sku: v.sku || null, nom,
      visible: v.visible !== false,
      precioHoy: v.price && v.price.actualPrice && v.price.actualPrice.amount != null ? r2(v.price.actualPrice.amount) : null,
      qtyHoy: it ? Number(it.quantity || 0) : null,
      ...accionDe({ nom, k }),
    });
  }
  const porSkuFilas = new Map();
  for (const f of filas) if (f.accion === 'SINCRONIZAR') {
    if (!porSkuFilas.has(f.sku)) porSkuFilas.set(f.sku, []);
    porSkuFilas.get(f.sku).push(f);
  }
  for (const [sku, rs] of porSkuFilas) {
    const rep = repartir(rs, ex.get(sku) || 0, TOPE);
    for (const f of rs) f.qtyNueva = rep.get(f.variantId);
  }
  // CONTROL duro: ningun SKU puede ofrecer mas de lo que hay
  for (const [sku, rs] of porSkuFilas) {
    const ofrece = rs.reduce((a, f) => a + f.qtyNueva * f.f, 0);
    if (ofrece > (ex.get(sku) || 0) + 0.001) throw new Error('CONTROL ROTO: ' + sku + ' ofreceria ' + ofrece);
  }
  return { full, filas };
}

(async () => {
  const { full, filas } = await planear();
  const sello = new Date().toISOString().replace(/[:.]/g, '-');
  // ⛔ FUERA del repo: la foto previa lleva el catalogo entero con sus precios y
  // el repo es PUBLICO. SALIDA lo puede mover; nunca por default a este directorio.
  const SAL = process.env.SALIDA || require('path').join(require('os').tmpdir(), 'tienda-wix');
  fs.mkdirSync(SAL, { recursive: true });
  fs.writeFileSync(require('path').join(SAL, 'respaldo-' + sello + '.json'), JSON.stringify(full));
  fs.writeFileSync(require('path').join(SAL, 'plan-' + sello + '.json'), JSON.stringify(filas, null, 1));
  console.log('3) foto previa y plan guardados en', SAL, '| sello', sello);

  const qty = filas.filter(f => f.accion === 'SINCRONIZAR' && f.qtyHoy !== f.qtyNueva);
  const precio = filas.filter(f => f.accion === 'SINCRONIZAR' && f.precioHoy !== r2(f.precio));
  const retirar = filas.filter(f => f.accion === 'RETIRAR' && f.visible);
  const ocultar = filas.filter(f => f.accion === 'OCULTAR' && f.visible);
  const declarar = filas.filter(f => f.accion === 'DECLARAR');
  console.log('\n4) plan: cantidad', qty.length, '| precio', precio.length,
    '| retirar', retirar.length, '| ocultar', ocultar.length, '| SIN RESOLVER', declarar.length);
  declarar.forEach(f => console.log('     NO MEDIDO:', f.sku, '|', f.nom, '|', f.motivo));

  if (!APLICAR) { console.log('\n(ensayo en seco: no se escribio nada. --aplicar para ejecutar)'); return; }

  // --- CANARIO: un renglon, verificado releyendo, antes de cualquier lote ---
  console.log('\n5) canario de inventario...');
  const can = qty[0];
  if (can) {
    const r = await fetch('https://www.wixapis.com/stores/v3/bulk/inventory-items/update', {
      method: 'POST', headers: H,
      body: JSON.stringify({ inventoryItems: [{ inventoryItem: { id: can.itemId, revision: String(can.itemRev), trackQuantity: true, quantity: can.qtyNueva } }] }),
    });
    if (!r.ok) throw new Error('canario: ' + r.status + ' ' + (await r.text()).slice(0, 300));
    await sleep(1500); // el search tarda en indexar
    const v = await (await fetch('https://www.wixapis.com/stores/v3/inventory-items/search', {
      method: 'POST', headers: H,
      body: JSON.stringify({ search: { filter: { variantId: can.variantId }, cursorPaging: { limit: 5 } } }),
    })).json();
    const leido = (v.inventoryItems || [])[0];
    const bien = Number(leido && leido.quantity) === can.qtyNueva;
    console.log('   ', can.sku, can.nom, can.qtyHoy, '->', leido && leido.quantity, bien ? 'OK' : 'NO COINCIDE');
    if (!bien) throw new Error('el canario no cuadra: me detengo sin tocar el lote');
  }

  // --- INVENTARIO, en lotes de 50 ---
  // el canario ya se escribio y su revision cambio: no vuelve a ir en el lote
  const pendientes = can ? qty.slice(1) : qty;
  console.log('\n6) inventario:', pendientes.length, 'renglones (el canario ya quedo)');
  let hechas = 0, fall = 0;
  const tope = Math.min(pendientes.length, LIMITE);
  for (let i = 0; i < tope; i += 50) {
    const lote = pendientes.slice(i, Math.min(i + 50, tope));
    const r = await fetch('https://www.wixapis.com/stores/v3/bulk/inventory-items/update', {
      method: 'POST', headers: H,
      body: JSON.stringify({ inventoryItems: lote.map(f => ({ inventoryItem: { id: f.itemId, revision: String(f.itemRev), trackQuantity: true, quantity: f.qtyNueva } })) }),
    });
    const j = await r.json();
    const malas = (j.results || []).filter(x => x.itemMetadata && x.itemMetadata.error).length;
    hechas += lote.length - malas; fall += malas;
    console.log('   lote', Math.floor(i / 50) + 1, 'http', r.status, '| fallidas', malas);
    await sleep(250);
  }
  console.log('   inventario escrito:', hechas, '| fallidas:', fall);

  // --- PRECIO + VISIBILIDAD, producto por producto ---
  // variantsInfo parcial REEMPLAZA: siempre options + la lista COMPLETA de variantes.
  const porProd = new Map();
  for (const f of [...precio, ...retirar, ...ocultar]) {
    if (!porProd.has(f.productoId)) porProd.set(f.productoId, []);
    porProd.get(f.productoId).push(f);
  }
  console.log('\n7) precio y visibilidad:', porProd.size, 'productos');
  let okP = 0, malP = 0, n = 0;
  for (const [pid, cambios] of porProd) {
    if (++n > LIMITE) break;
    const vivo = await leerProducto(pid);
    const porVar = new Map(cambios.map(f => [f.variantId, f]));
    // Se PARTE de la variante viva y solo se pisa lo que cambia. Reconstruirla de
    // cero pierde campos que el servidor exige ([CV.29] destruyo un producto asi,
    // y `physicalProperties.pricePerUnit` hace fallar el PATCH con 428).
    const variants = vivo.variantsInfo.variants.map(v => {
      const f = porVar.get(v.id);
      const o = { ...v };
      delete o.inventoryStatus; // lo calcula el servidor; no se manda
      o.price = { actualPrice: { amount: String(v.price.actualPrice.amount) } };
      if (f && f.accion === 'SINCRONIZAR') o.price = { actualPrice: { amount: String(r2(f.precio)) } };
      if (f && (f.accion === 'RETIRAR' || f.accion === 'OCULTAR')) o.visible = false;
      return o;
    });
    const r = await fetch('https://www.wixapis.com/stores/v3/products/' + pid, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ product: { revision: String(vivo.revision), options: vivo.options, variantsInfo: { variants } } }),
    });
    if (!r.ok) { malP++; console.log('   FALLA', String(vivo.name).slice(0, 40), r.status, (await r.text()).slice(0, 160)); continue; }
    // verificar RELEYENDO, no el acuse de la escritura
    const fin = await leerProducto(pid);
    const mismaEstructura = fin.variantsInfo.variants.length === vivo.variantsInfo.variants.length;
    const bien = mismaEstructura && cambios.every(f => {
      const v = fin.variantsInfo.variants.find(x => x.id === f.variantId);
      if (!v) return false;
      if (f.accion === 'SINCRONIZAR') return r2(v.price.actualPrice.amount) === r2(f.precio);
      return v.visible === false;
    });
    if (bien) okP++; else { malP++; console.log('   NO VERIFICA', String(fin.name).slice(0, 40)); }
    await sleep(120);
  }
  console.log('   productos verificados releyendo:', okP, '| con problema:', malP);
  console.log('\nLISTO. La verificacion que vale es la global: node verificar_final.js');
})().catch(e => { console.error('ERR', e.message); process.exitCode = 1; });
