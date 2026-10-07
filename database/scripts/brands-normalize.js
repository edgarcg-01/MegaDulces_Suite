/**
 * Normalización de marcas: detecta duplicados por LOWER+TRIM+unaccent y los
 * fusiona en una sola marca canónica (UPPERCASE wins). Productos espejados
 * por nombre también se fusionan; referencias en daily_captures.exhibiciones
 * y en commercial.* se remapean.
 *
 * Pasos por grupo:
 *   1. Pick canonical brand = la que tenga nombre todo UPPERCASE
 *      (criterio: matches convención del 95% de las brands reales).
 *   2. Match products non-canonical → canonical por normalized(nombre).
 *   3. Remap JSONB exhibiciones (brandId + productosMarcados).
 *   4. Remap commercial.product_prices (delete conflicts en mismo price_list).
 *   5. Remap commercial.stock (sum quantity + reserved en conflicto).
 *   6. Remap commercial.stock_movements y commercial.order_lines (simple UPDATE).
 *   7. UPDATE brand_id de products sin match (transferencia limpia).
 *   8. DELETE non-canonical products + brand.
 *
 * Uso:
 *   DATABASE_URL='...' node database/brands-normalize.js              # dry-run (default)
 *   DATABASE_URL='...' node database/brands-normalize.js --execute    # aplica cambios
 *
 * Idempotente: en 2do run no hay duplicados → exit clean.
 */
const knex = require('knex');
const { assertEnv, logTarget } = require('./_lib/preflight');

assertEnv(['DATABASE_URL'], { script: __filename });
logTarget('DATABASE_URL');

const fs = require('fs');
const DATABASE_URL = process.env.DATABASE_URL;
const EXECUTE = process.argv.includes('--execute');
// --map <archivo.json>: mapa curado { "MARCA ORIGEN": "MARCA CANÓNICA", ... } para alias
// cortos que la clave (estricta o agresiva) no agrupa (PERFETTI → PERFETTI VAN MELLE).
const MAP_PATH = (() => { const i = process.argv.indexOf('--map'); return i >= 0 ? process.argv[i + 1] : null; })();

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

function normalize(s) {
  if (!s) return '';
  return s.toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['`´¨]/g, '').replace(/\s+/g, ' ').trim();
}

// Clave AGRESIVA para agrupar MARCAS (no productos): además del normalize, quita toda
// puntuación y los sufijos de razón social al final (SA, SA DE CV, S DE RL DE CV, S.A.,
// etc. — quedan como tokens sueltos tras quitar puntuación). Exact-match tras esto → NO
// mezcla empresas distintas que comparten palabras (SARAMEL ≠ GONAC ≠ ELORO), a diferencia
// del similarity fuzzy. Solo se usa con --aggressive, y SOLO para agrupar marcas; el match
// de productos por nombre sigue con normalize() estricto.
const LEGAL_TOKENS = new Set(['sa', 's', 'a', 'de', 'cv', 'c', 'v', 'rl', 'r', 'l', 'sc', 'sapi', 'p', 'i', 'sab', 'sofom', 'enr', 'sad', 'dc', 'mx', 'mexico']);
function brandKey(s) {
  let x = (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  x = x.replace(/[.,*'`´¨\-\/&()]/g, ' ').replace(/\s+/g, ' ').trim();
  const w = x.split(' ').filter(Boolean);
  while (w.length > 1 && LEGAL_TOKENS.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}
const AGGRESSIVE = process.argv.includes('--aggressive');
const groupKey = (s) => (AGGRESSIVE ? brandKey(s) : normalize(s));

function pickCanonicalBrand(arr) {
  // Prefer all-uppercase (convención del resto del catálogo).
  // Si hay varios uppercase o ninguno, prefer el que tenga más productos activos,
  // luego el más viejo.
  const upper = arr.filter(b => b.nombre === b.nombre.toUpperCase());
  if (upper.length === 1) return upper[0];
  const pool = upper.length ? upper : arr;
  return [...pool].sort((a, b) => {
    if ((b.productCount ?? 0) !== (a.productCount ?? 0)) return (b.productCount ?? 0) - (a.productCount ?? 0);
    return new Date(a.created_at) - new Date(b.created_at);
  })[0];
}

async function buildPlan() {
  const brands = await db('brands').select('*').orderBy('nombre');
  const productCountsRaw = await db.raw(`
    SELECT brand_id, COUNT(*) AS active
    FROM products
    WHERE deleted_at IS NULL
    GROUP BY brand_id
  `);
  const productCounts = new Map(productCountsRaw.rows.map(r => [r.brand_id, Number(r.active)]));
  for (const b of brands) b.productCount = productCounts.get(b.id) || 0;

  const groups = new Map();
  for (const b of brands) {
    const key = `${b.tenant_id || 'legacy'}::${groupKey(b.nombre)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const plan = [];
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const canonical = pickCanonicalBrand(arr);
    const nonCanonical = arr.filter(b => b.id !== canonical.id);
    plan.push({ key, canonical, nonCanonical });
  }
  return plan;
}

// Plan desde un mapa curado { "ORIGEN": "CANÓNICA" }. Resuelve por nombre exacto (trim)
// entre marcas activas. Agrupa varias fuentes bajo la misma canónica. Reporta las que no
// resuelven (no falla). Reusa toda la maquinaria de merge/soft-delete de abajo.
async function buildPlanFromMap(mapPath) {
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  const brands = await db('brands').whereNull('deleted_at').select('*');
  const byName = new Map(brands.map(b => [b.nombre.trim(), b]));
  const pc = await db.raw(`SELECT brand_id, COUNT(*) AS active FROM products WHERE deleted_at IS NULL GROUP BY brand_id`);
  const counts = new Map(pc.rows.map(r => [r.brand_id, Number(r.active)]));
  for (const b of brands) b.productCount = counts.get(b.id) || 0;
  const byCanon = new Map();
  const misses = [];
  for (const [src, can] of Object.entries(raw)) {
    const sb = byName.get(src.trim()), cb = byName.get(can.trim());
    if (!sb) { misses.push(`origen no encontrada: "${src}"`); continue; }
    if (!cb) { misses.push(`canónica no encontrada: "${can}"`); continue; }
    if (sb.id === cb.id) { misses.push(`origen==canónica: "${src}"`); continue; }
    if (!byCanon.has(cb.id)) byCanon.set(cb.id, { key: `map::${cb.nombre}`, canonical: cb, nonCanonical: [] });
    byCanon.get(cb.id).nonCanonical.push(sb);
  }
  if (misses.length) { console.log('⚠️  pares no resueltos (se omiten):'); misses.forEach(m => console.log('   ' + m)); }
  return [...byCanon.values()];
}

async function buildProductMaps(canonicalBrandId, nonCanonicalBrandId) {
  const [canonProds, nonCanonProds] = await Promise.all([
    db('products').where({ brand_id: canonicalBrandId }).whereNull('deleted_at').select('id', 'nombre', 'tenant_id'),
    db('products').where({ brand_id: nonCanonicalBrandId }).whereNull('deleted_at').select('id', 'nombre', 'tenant_id'),
  ]);
  const canonByNorm = new Map(canonProds.map(p => [normalize(p.nombre), p]));

  const productMap = new Map();   // non-canon product id → canon product id (merge + delete)
  const productMove = [];          // non-canon product ids sin match (solo UPDATE brand_id)
  for (const p of nonCanonProds) {
    const match = canonByNorm.get(normalize(p.nombre));
    if (match) productMap.set(p.id, match.id);
    else productMove.push(p.id);
  }
  return { productMap, productMove, nonCanonProds, canonProds };
}

(async () => {
  try {
    console.log(`▶ Mode: ${EXECUTE ? '🔥 EXECUTE' : '🧪 DRY-RUN (no changes)'}`);
    console.log('▶ Building plan...\n');

    const plan = MAP_PATH ? await buildPlanFromMap(MAP_PATH) : await buildPlan();
    if (!plan.length) {
      console.log('✓ No hay duplicados. Nothing to do.');
      return;
    }

    // Resolver mappings de productos por grupo
    for (const g of plan) {
      g.merges = [];
      for (const nc of g.nonCanonical) {
        const m = await buildProductMaps(g.canonical.id, nc.id);
        g.merges.push({ nonCanonicalBrand: nc, ...m });
      }
    }

    // Imprimir plan
    let totalBrandsToDelete = 0;
    let totalProductsToDelete = 0;
    let totalProductsToMove = 0;
    for (let i = 0; i < plan.length; i++) {
      const g = plan[i];
      console.log(`#${i + 1} canonical "${g.canonical.nombre}" id=${g.canonical.id.slice(0,8)}…`);
      for (const m of g.merges) {
        totalBrandsToDelete++;
        totalProductsToDelete += m.productMap.size;
        totalProductsToMove += m.productMove.length;
        console.log(`   - merge "${m.nonCanonicalBrand.nombre}" id=${m.nonCanonicalBrand.id.slice(0,8)}…`);
        console.log(`        prods a fusionar: ${m.productMap.size}`);
        console.log(`        prods a transferir (sin match): ${m.productMove.length}`);
      }
    }
    console.log(`\nTotals: ${totalBrandsToDelete} marca(s) a DELETE, ${totalProductsToDelete} producto(s) a fusionar+DELETE, ${totalProductsToMove} producto(s) a transferir.`);

    if (!EXECUTE) {
      console.log('\n(dry-run) Re-run with --execute para aplicar.');
      return;
    }

    // ───────────────────────────────────────────────────────────────────────
    // BACKUP (fuera de la trx — CREATE TABLE no es transaction-safe para huge tables)
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n▶ Backup brands + products + commercial.product_prices...');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await db.raw(`CREATE TABLE IF NOT EXISTS brands_dedup_backup_${stamp} AS SELECT * FROM brands WHERE id = ANY(?)`,
      [plan.flatMap(g => [g.canonical.id, ...g.nonCanonical.map(b => b.id)])]);
    await db.raw(`CREATE TABLE IF NOT EXISTS products_dedup_backup_${stamp} AS SELECT * FROM products WHERE brand_id = ANY(?)`,
      [plan.flatMap(g => [g.canonical.id, ...g.nonCanonical.map(b => b.id)])]);
    console.log('  ✓ backup OK');

    // ───────────────────────────────────────────────────────────────────────
    // MERGE en una sola transacción atómica
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n▶ Aplicando merges en transacción...');
    await db.transaction(async trx => {
      // Aggregate mappings across all groups
      const brandMap = new Map();     // non-canon brand id → canon brand id
      const productMap = new Map();   // non-canon product id → canon product id
      const productMove = new Map();  // non-canon product id → canon brand id (transfer)
      const allProductDeletes = [];

      for (const g of plan) {
        for (const m of g.merges) {
          brandMap.set(m.nonCanonicalBrand.id, g.canonical.id);
          for (const [non, canon] of m.productMap) {
            productMap.set(non, canon);
            allProductDeletes.push(non);
          }
          for (const pid of m.productMove) productMove.set(pid, g.canonical.id);
        }
      }

      // 1. Remap JSONB exhibiciones en daily_captures
      console.log('  (1/8) remap daily_captures.exhibiciones JSONB...');
      const captures = await trx('daily_captures').select('id', 'exhibiciones');
      let capsTouched = 0, brandRefsRemapped = 0, prodRefsRemapped = 0;
      for (const cap of captures) {
        const exh = typeof cap.exhibiciones === 'string' ? JSON.parse(cap.exhibiciones) : cap.exhibiciones;
        if (!Array.isArray(exh)) continue;
        let changed = false;
        const updated = exh.map(e => {
          const newE = { ...e };
          if (e.brandId && brandMap.has(e.brandId)) {
            newE.brandId = brandMap.get(e.brandId);
            brandRefsRemapped++;
            changed = true;
          }
          if (Array.isArray(e.productosMarcados)) {
            const remapped = e.productosMarcados.map(pid => {
              if (productMap.has(pid)) { prodRefsRemapped++; return productMap.get(pid); }
              return pid;
            });
            const uniq = [...new Set(remapped)];
            if (uniq.length !== e.productosMarcados.length || uniq.some((p, i) => p !== e.productosMarcados[i])) {
              newE.productosMarcados = uniq;
              changed = true;
            }
          }
          return newE;
        });
        if (changed) {
          capsTouched++;
          await trx('daily_captures').where({ id: cap.id }).update({ exhibiciones: JSON.stringify(updated) });
        }
      }
      console.log(`    → ${capsTouched} captures touched, ${brandRefsRemapped} brand refs + ${prodRefsRemapped} product refs remapped`);

      // 2. commercial.product_prices: borrar conflictos, luego UPDATE
      console.log('  (2/8) commercial.product_prices...');
      let pricesDeleted = 0, pricesUpdated = 0;
      for (const [nonId, canonId] of productMap) {
        const delRes = await trx.raw(`
          DELETE FROM commercial.product_prices pp
          WHERE pp.product_id = ?
            AND EXISTS (
              SELECT 1 FROM commercial.product_prices pp2
              WHERE pp2.product_id = ?
                AND pp2.price_list_id = pp.price_list_id
                AND pp2.tenant_id = pp.tenant_id
            )
        `, [nonId, canonId]);
        pricesDeleted += delRes.rowCount || 0;
        const updRes = await trx('commercial.product_prices').where({ product_id: nonId }).update({ product_id: canonId });
        pricesUpdated += updRes;
      }
      console.log(`    → ${pricesDeleted} dup prices deleted, ${pricesUpdated} prices reassigned`);

      // 3. commercial.stock: sumar quantity en conflictos y eliminar dup, luego UPDATE
      console.log('  (3/8) commercial.stock (sum quantities en conflicto)...');
      let stockMerged = 0, stockMoved = 0;
      for (const [nonId, canonId] of productMap) {
        // Sumar quantity + reserved donde canónico y dup compartan warehouse
        await trx.raw(`
          UPDATE commercial.stock s_can
             SET quantity = s_can.quantity + s_dup.quantity,
                 reserved_quantity = s_can.reserved_quantity + s_dup.reserved_quantity,
                 updated_at = NOW()
          FROM commercial.stock s_dup
          WHERE s_can.product_id = ?
            AND s_dup.product_id = ?
            AND s_can.warehouse_id = s_dup.warehouse_id
            AND s_can.tenant_id = s_dup.tenant_id
        `, [canonId, nonId]);
        const delRes = await trx.raw(`
          DELETE FROM commercial.stock
          WHERE product_id = ?
            AND EXISTS (
              SELECT 1 FROM commercial.stock s2
              WHERE s2.product_id = ?
                AND s2.warehouse_id = commercial.stock.warehouse_id
                AND s2.tenant_id = commercial.stock.tenant_id
            )
        `, [nonId, canonId]);
        stockMerged += delRes.rowCount || 0;
        const updRes = await trx('commercial.stock').where({ product_id: nonId }).update({ product_id: canonId });
        stockMoved += updRes;
      }
      console.log(`    → ${stockMerged} stock rows merged (summed), ${stockMoved} stock rows transferred`);

      // 4. commercial.stock_movements: simple UPDATE (sin UNIQUE en product_id)
      console.log('  (4/8) commercial.stock_movements...');
      let movsUpdated = 0;
      for (const [nonId, canonId] of productMap) {
        movsUpdated += await trx('commercial.stock_movements').where({ product_id: nonId }).update({ product_id: canonId });
      }
      console.log(`    → ${movsUpdated} stock movements reassigned`);

      // 5. commercial.order_lines: simple UPDATE
      console.log('  (5/8) commercial.order_lines...');
      let linesUpdated = 0;
      for (const [nonId, canonId] of productMap) {
        linesUpdated += await trx('commercial.order_lines').where({ product_id: nonId }).update({ product_id: canonId });
      }
      console.log(`    → ${linesUpdated} order_lines reassigned`);

      // 5b. Tablas RESTRICT agregadas DESPUÉS de escribir este script (FEFO + compras):
      // stock_lots/stock_lot_movements → reassign (unique es (tenant,id), sin conflicto por
      // producto+lote); abc_classification → DELETE (derivada, se recomputa nightly);
      // goods_receipt/purchase_order/purchase_requisition_lines → reassign. Sin esto el
      // DELETE del producto duplicado (paso 7) choca con la FK RESTRICT.
      console.log('  (5b/8) stock_lots / abc / líneas de compra (RESTRICT nuevas)...');
      let lotsR = 0, lotDup = 0, lotMovR = 0, abcD = 0, buyR = 0;
      for (const [nonId, canonId] of productMap) {
        // stock_lots: unique natural (tenant,warehouse,product,lot_code,expiry). Sumar qty
        // donde el canónico ya tiene ese lote, borrar el dup, y reasignar el resto.
        await trx.raw(`
          UPDATE commercial.stock_lots l_can
             SET quantity = l_can.quantity + l_dup.quantity
          FROM commercial.stock_lots l_dup
          WHERE l_can.product_id = ? AND l_dup.product_id = ?
            AND l_can.tenant_id = l_dup.tenant_id AND l_can.warehouse_id = l_dup.warehouse_id
            AND l_can.lot_code IS NOT DISTINCT FROM l_dup.lot_code
            AND l_can.expiry_date IS NOT DISTINCT FROM l_dup.expiry_date`, [canonId, nonId]);
        const dl = await trx.raw(`
          DELETE FROM commercial.stock_lots ld
          WHERE ld.product_id = ? AND EXISTS (
            SELECT 1 FROM commercial.stock_lots lc WHERE lc.product_id = ?
              AND lc.tenant_id = ld.tenant_id AND lc.warehouse_id = ld.warehouse_id
              AND lc.lot_code IS NOT DISTINCT FROM ld.lot_code
              AND lc.expiry_date IS NOT DISTINCT FROM ld.expiry_date)`, [nonId, canonId]);
        lotDup += dl.rowCount || 0;
        lotsR += await trx('commercial.stock_lots').where({ product_id: nonId }).update({ product_id: canonId });
        lotMovR += await trx('commercial.stock_lot_movements').where({ product_id: nonId }).update({ product_id: canonId });
        abcD += await trx('commercial.abc_classification').where({ product_id: nonId }).del();
        buyR += await trx('commercial.goods_receipt_lines').where({ product_id: nonId }).update({ product_id: canonId });
        buyR += await trx('commercial.purchase_order_lines').where({ product_id: nonId }).update({ product_id: canonId });
        buyR += await trx('commercial.purchase_requisition_lines').where({ product_id: nonId }).update({ product_id: canonId });
      }
      console.log(`    → ${lotsR} lots reassigned (${lotDup} dup summed+deleted), ${lotMovR} lot-movs, ${abcD} abc deleted, ${buyR} purchase lines`);

      // 6. Productos sin match: solo UPDATE brand_id (los movemos a la canónica)
      console.log('  (6/8) products sin match — UPDATE brand_id...');
      let movedProds = 0;
      for (const [pid, canonBrandId] of productMove) {
        movedProds += await trx('products').where({ id: pid }).update({ brand_id: canonBrandId, updated_at: trx.fn.now() });
      }
      console.log(`    → ${movedProds} products transferidos a brand canónica`);

      // 7. DELETE productos duplicados
      console.log('  (7/8) DELETE productos duplicados...');
      let prodsDeleted = 0;
      if (allProductDeletes.length) {
        prodsDeleted = await trx('products').whereIn('id', allProductDeletes).del();
      }
      console.log(`    → ${prodsDeleted} products deleted`);

      // 8. Eliminar brands no canónicas. En modo agresivo → SOFT-delete (set deleted_at):
      // brands→products es ON DELETE CASCADE, y quedan productos SOFT-DELETED (tombstones)
      // bajo estas brands que un HARD-delete cascade-borraría → violaría las FK RESTRICT de
      // product_prices/stock. El soft-delete las oculta de la UP (filtro deleted_at IS NULL)
      // sin tocar los tombstones, y es reversible. Estricto conserva el hard-delete.
      const SOFT = AGGRESSIVE || !!MAP_PATH;
      console.log(`  (8/8) ${SOFT ? 'SOFT-DELETE' : 'DELETE'} brands no canónicas...`);
      const brandIdsToDelete = [...brandMap.keys()];
      let brandsDeleted = 0;
      if (brandIdsToDelete.length) {
        brandsDeleted = SOFT
          ? await trx('brands').whereIn('id', brandIdsToDelete).whereNull('deleted_at').update({ deleted_at: trx.fn.now() })
          : await trx('brands').whereIn('id', brandIdsToDelete).del();
      }
      console.log(`    → ${brandsDeleted} brands ${SOFT ? 'soft-deleted' : 'deleted'}`);
    });

    console.log('\n✓ Normalización completa. Verifica con: node database/brands-explore.js');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
