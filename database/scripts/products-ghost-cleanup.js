/* eslint-disable no-console */
/**
 * Limpieza de productos FANTASMA: entradas en catalog.products SIN SKU creadas por el
 * seed/testdata/capturas de mayo-2026 (previo al import real de Kepler de junio), que
 * quedaron como duplicados huérfanos e inflan /comercial/salidas en todos los almacenes.
 *
 * SOLO toca productos que son INERTES: sin SKU + sin stock (qty/reserved = 0) + sin venta
 * (inventory_health.avg_daily_units = 0/ausente) + NO referenciados en order_lines,
 * stock_lots, stock_movements, purchase_*_lines, goods_receipt_lines, reorder_policy ni
 * en daily_captures (JSONB). Idempotente. Soft-delete (deleted_at=NOW → activo GENERATED
 * se apaga solo; NUNCA escribimos activo). Reversible.
 *
 * TIER1 = fantasma puro (ni precio). TIER2 = solo con precio colgado (borra el precio huérfano primero).
 *
 *   DATABASE_URL=… node database/scripts/products-ghost-cleanup.js              # dry-run
 *   DATABASE_URL=… node database/scripts/products-ghost-cleanup.js --execute    # tier1+tier2
 *   DATABASE_URL=… node database/scripts/products-ghost-cleanup.js --tier1 --execute
 */
const knex = require('knex');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const EXECUTE = process.argv.includes('--execute');
const TIER1_ONLY = process.argv.includes('--tier1');
const M = '00000000-0000-0000-0000-00000000d01c';
const db = knex({ client: 'pg', connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }, pool: { min: 1, max: 4 } });

const distinctIds = async (table, col, ids, extraWhere) => {
  try {
    let q = db(table).whereIn(col, ids).distinct(col);
    if (extraWhere) q = q.andWhereRaw(extraWhere);
    return new Set((await q).map((r) => r[col]));
  } catch (e) { console.log(`  (aviso: ${table} → ${e.message})`); return new Set(); }
};

(async () => {
  console.log(`▶ ${EXECUTE ? '🔥 EXECUTE' : '🧪 DRY-RUN'} · ${TIER1_ONLY ? 'TIER1' : 'TIER1+TIER2'} · ${DATABASE_URL.split('@')[1]}`);
  const noSku = await db('catalog.products').where({ tenant_id: M }).whereNull('deleted_at').where('activo', true)
    .andWhereRaw(`(sku IS NULL OR btrim(sku)='')`).select('id', 'nombre', 'brand_id');
  const ids = noSku.map((p) => p.id);
  console.log('Productos activos SIN SKU:', ids.length);
  if (!ids.length) { await db.destroy(); return; }

  // sets de referencia (cualquiera de estos = NO borrar)
  const stock = await distinctIds('commercial.stock', 'product_id', ids, 'coalesce(quantity,0) <> 0 OR coalesce(reserved_quantity,0) <> 0');
  const sales = await distinctIds('analytics.inventory_health', 'product_id', ids, 'coalesce(avg_daily_units,0) > 0');
  const orders = await distinctIds('commercial.order_lines', 'product_id', ids);
  const lots = await distinctIds('commercial.stock_lots', 'product_id', ids);
  const moves = await distinctIds('commercial.stock_movements', 'product_id', ids);
  const poL = await distinctIds('commercial.purchase_order_lines', 'product_id', ids);
  const reqL = await distinctIds('commercial.purchase_requisition_lines', 'product_id', ids);
  const grL = await distinctIds('commercial.goods_receipt_lines', 'product_id', ids);
  const rp = await distinctIds('commercial.reorder_policy', 'product_id', ids);
  const prices = await distinctIds('commercial.product_prices', 'product_id', ids);

  // referencias en daily_captures (JSONB) — extrae TODOS los UUID que aparezcan y cruza
  let capRefs = new Set();
  try {
    const rows = await db('public.daily_captures').where({ tenant_id: M }).whereNotNull('exhibiciones').select(db.raw('exhibiciones::text AS t'));
    const rx = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const idset = new Set(ids);
    for (const r of rows) { const m = r.t && r.t.match(rx); if (m) for (const u of m) if (idset.has(u)) capRefs.add(u); }
  } catch (e) { console.log('  (aviso daily_captures:', e.message, ')'); }

  const blocked = (id) => stock.has(id) || sales.has(id) || orders.has(id) || lots.has(id) || moves.has(id) || poL.has(id) || reqL.has(id) || grL.has(id) || rp.has(id) || capRefs.has(id);
  const tier1 = [], tier2 = [], kept = [];
  for (const p of noSku) {
    if (blocked(p.id)) { kept.push(p); continue; }
    if (prices.has(p.id)) tier2.push(p); else tier1.push(p);
  }
  console.log('\nAuditoría de referencias (bloquean borrado):');
  console.log(`  stock≠0:${stock.size}  venta:${sales.size}  order_lines:${orders.size}  lots:${lots.size}  movements:${moves.size}  PO:${poL.size}  req:${reqL.size}  recepción:${grL.size}  reorder:${rp.size}  capturas:${capRefs.size}`);
  console.log(`\n✅ TIER1 fantasma puro (borrable):        ${tier1.length}`);
  console.log(`✅ TIER2 solo precio colgado (borrable):  ${tier2.length}  (+ borra ${tier2.length} filas price)`);
  console.log(`✋ CONSERVADOS (referenciados):           ${kept.length}`);
  console.log('\nMuestra a borrar:');
  [...tier1, ...tier2].slice(0, 15).forEach((p) => console.log(`   "${p.nombre}"`));

  const toDelete = TIER1_ONLY ? tier1 : [...tier1, ...tier2];
  const priceDelIds = TIER1_ONLY ? [] : tier2.map((p) => p.id);
  if (!EXECUTE) { console.log(`\n(dry-run) borraría ${toDelete.length} productos${priceDelIds.length ? ` + ${priceDelIds.length} precios` : ''}. --execute para aplicar.`); await db.destroy(); return; }

  await db.transaction(async (trx) => {
    let delPrices = 0, softDel = 0;
    for (let i = 0; i < priceDelIds.length; i += 500) delPrices += await trx('commercial.product_prices').whereIn('product_id', priceDelIds.slice(i, i + 500)).del();
    const delIds = toDelete.map((p) => p.id);
    for (let i = 0; i < delIds.length; i += 500) softDel += await trx('catalog.products').whereIn('id', delIds.slice(i, i + 500)).whereNull('deleted_at').update({ deleted_at: trx.fn.now(), deleted_by: 'ghost-cleanup', updated_at: trx.fn.now() });
    console.log(`\n✓ ${softDel} productos soft-deleted · ${delPrices} precios huérfanos borrados`);
  });
  await db.destroy();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
