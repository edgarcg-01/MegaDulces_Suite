/**
 * Normalización de productos: fusiona pares duplicados dentro de la misma marca
 * donde uno tiene sufijo " / N" (packing) y el otro no.
 *
 * Regla canónica: la versión SIN " / N" gana (nombres más limpios).
 * Las que tienen " / N" se eliminan; sus refs (captures, prices, stock, orders)
 * se remapean a la canónica.
 *
 * Strip pattern: ` / <resto>` con WHITESPACE alrededor del slash. Eso evita
 * falsos positivos en nombres como "SALSA VALENTINA PONI E/N" donde el slash
 * sin espacios es parte del SKU.
 *
 * Cross-brand mappings (hardcoded, detectados por fuzzy scan):
 *   - "BIMBO PASTELITO HERSHEYS 250GR" → BIMBO BARCEL (no MARS)
 *   - "BIMBO CANELITAS SOBRE 360G"    → BIMBO BARCEL (no MARS)
 *   - "GALL WAFER CHOCOLATE 156GR / 12 TINAJITA" → TINAJITA (no DELICIAS)
 *   - "GLOBO METAL DORADO #9"         → GLOBO PAYASO (no WINIS)
 *
 * Uso:
 *   DATABASE_URL='...' node database/products-normalize.js              # dry-run
 *   DATABASE_URL='...' node database/products-normalize.js --execute    # aplica
 */
const knex = require('knex');
const { assertEnv, logTarget } = require('./_lib/preflight');

assertEnv(['DATABASE_URL'], { script: __filename });
logTarget('DATABASE_URL');

const DATABASE_URL = process.env.DATABASE_URL;
const EXECUTE = process.argv.includes('--execute');

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

function stripSuffix(s) {
  if (!s) return '';
  // Strip último " / X" con whitespace alrededor del slash. Greedy: cubre
  // "GR / 12 TINAJITA" → strip todo el final.
  return s.replace(/\s+\/\s+.+$/u, '').trim();
}

function normalize(s) {
  if (!s) return '';
  return s.toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['`´¨]/g, '').replace(/\s+/g, ' ').trim();
}

const CROSS_BRAND_RULES = [
  { product_norm: 'bimbo pastelito hersheys 250gr', winning_brand_name: 'BIMBO BARCEL' },
  { product_norm: 'bimbo canelitas sobre 360g',     winning_brand_name: 'BIMBO BARCEL' },
  { product_norm: 'gall wafer chocolate 156gr',     winning_brand_name: 'TINAJITA' },
  { product_norm: 'globo metal dorado #9',          winning_brand_name: 'GLOBO PAYASO' },
];

async function buildWithinBrandPlan() {
  const products = await db('products')
    .leftJoin('brands', 'products.brand_id', 'brands.id')
    .whereNull('products.deleted_at')
    .select('products.id', 'products.brand_id', 'products.nombre', 'products.tenant_id', 'brands.nombre as brand_nombre');

  // Group por (tenant, brand, normalize(stripSuffix(name)))
  const groups = new Map();
  for (const p of products) {
    const stripped = normalize(stripSuffix(p.nombre));
    const key = `${p.tenant_id}::${p.brand_id}::${stripped}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const dupGroups = [];
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const withSuffix = arr.filter(p => /\s+\/\s+/.test(p.nombre));
    const withoutSuffix = arr.filter(p => !/\s+\/\s+/.test(p.nombre));
    if (!withSuffix.length || !withoutSuffix.length) continue;
    // Canónica: la versión bare (sin sufijo " / N").
    // Si hay varios bare (raro), pick el primero.
    const canonical = withoutSuffix[0];
    // A eliminar: todos los con sufijo + cualquier bare extra.
    const merges = [...withSuffix, ...withoutSuffix.filter(p => p.id !== canonical.id)];
    dupGroups.push({ canonical, merges, brand: canonical.brand_nombre });
  }
  return dupGroups;
}

async function buildCrossBrandPlan() {
  const products = await db('products')
    .leftJoin('brands', 'products.brand_id', 'brands.id')
    .whereNull('products.deleted_at')
    .select('products.id', 'products.brand_id', 'products.nombre', 'products.tenant_id', 'brands.nombre as brand_nombre');

  const brands = await db('brands').select('id', 'nombre', 'tenant_id');
  const brandByName = new Map(brands.map(b => [normalize(b.nombre), b]));

  const plan = [];
  for (const rule of CROSS_BRAND_RULES) {
    const winningBrand = brandByName.get(normalize(rule.winning_brand_name));
    if (!winningBrand) {
      console.warn(`(cross-brand) brand "${rule.winning_brand_name}" no encontrada — skip`);
      continue;
    }
    const matching = products.filter(p => normalize(stripSuffix(p.nombre)) === rule.product_norm);
    if (matching.length < 2) continue;
    // Canónica: bare (sin "/ N"); si no hay bare, prefer winning brand.
    const bareCandidates = matching.filter(p => !/\s+\/\s+/.test(p.nombre));
    let canonical = bareCandidates[0];
    if (!canonical) {
      // No hay bare → pick el que esté en winning brand
      canonical = matching.find(p => p.brand_id === winningBrand.id) || matching[0];
    }
    // Si canonical no está en winning brand, hay que reasignarla
    const needsBrandUpdate = canonical.brand_id !== winningBrand.id ? winningBrand.id : null;
    const merges = matching.filter(p => p.id !== canonical.id);
    plan.push({ canonical, merges, brand: winningBrand.nombre, crossBrand: true, needsBrandUpdate });
  }
  return plan;
}

(async () => {
  try {
    console.log(`▶ Mode: ${EXECUTE ? '🔥 EXECUTE' : '🧪 DRY-RUN'}`);
    console.log('▶ Building plan...\n');

    const withinPlan = await buildWithinBrandPlan();
    const crossPlan = await buildCrossBrandPlan();
    const plan = [...withinPlan, ...crossPlan];

    if (!plan.length) {
      console.log('✓ No hay duplicados. Nothing to do.');
      return;
    }

    // Reporte agrupado por brand
    const byBrand = new Map();
    for (const item of plan) {
      const b = item.brand;
      if (!byBrand.has(b)) byBrand.set(b, []);
      byBrand.get(b).push(item);
    }

    let totalDeletes = 0;
    let totalBrandMoves = 0;
    console.log('▶ PLAN DE MERGE\n');
    for (const [brand, items] of [...byBrand.entries()].sort()) {
      console.log(`── ${brand}  (${items.length} pares) ──`);
      for (const it of items) {
        const x = it.crossBrand ? '✱ ' : '';
        const moveNote = it.needsBrandUpdate ? `  [MOVER a ${it.brand}]` : '';
        if (it.needsBrandUpdate) totalBrandMoves++;
        console.log(`  ${x}KEEP: "${it.canonical.nombre}"  (${it.canonical.id.slice(0,8)}…)${moveNote}`);
        for (const m of it.merges) {
          console.log(`     DEL: "${m.nombre}"  (${m.id.slice(0,8)}…)`);
          totalDeletes++;
        }
      }
      console.log('');
    }
    console.log(`Totals: ${plan.length} grupos, ${totalDeletes} producto(s) a DELETE, ${totalBrandMoves} con cambio de brand_id.`);

    if (!EXECUTE) {
      console.log('\n(dry-run) Re-run con --execute para aplicar.');
      return;
    }

    // ───────────────────────────────────────────────────────────────────────
    // BACKUP
    // ───────────────────────────────────────────────────────────────────────
    const allMergeIds = plan.flatMap(it => it.merges.map(m => m.id));
    const allCanonicalIds = plan.map(it => it.canonical.id);
    const allIds = [...new Set([...allMergeIds, ...allCanonicalIds])];

    console.log('\n▶ Backup products...');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await db.raw(`CREATE TABLE IF NOT EXISTS products_normalize_backup_${stamp} AS SELECT * FROM products WHERE id = ANY(?)`, [allIds]);
    console.log(`  ✓ backup OK (${allIds.length} rows)`);

    // ───────────────────────────────────────────────────────────────────────
    // MERGE en transacción
    // ───────────────────────────────────────────────────────────────────────
    console.log('\n▶ Aplicando merges en transacción...');
    await db.transaction(async trx => {
      // Build productMap: dup_id → canonical_id
      const productMap = new Map();
      for (const it of plan) {
        for (const m of it.merges) productMap.set(m.id, it.canonical.id);
      }

      // 1. daily_captures.exhibiciones (productosMarcados[])
      console.log('  (1/6) remap daily_captures.exhibiciones JSONB...');
      const captures = await trx('daily_captures').select('id', 'exhibiciones');
      let capsTouched = 0, prodRefsRemapped = 0;
      for (const cap of captures) {
        const exh = typeof cap.exhibiciones === 'string' ? JSON.parse(cap.exhibiciones) : cap.exhibiciones;
        if (!Array.isArray(exh)) continue;
        let changed = false;
        const updated = exh.map(e => {
          const newE = { ...e };
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
      console.log(`    → ${capsTouched} captures touched, ${prodRefsRemapped} product refs remapped`);

      // 2. commercial.product_prices: delete conflicts, UPDATE rest
      console.log('  (2/6) commercial.product_prices...');
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

      // 3. commercial.stock: sum conflicts, UPDATE rest
      console.log('  (3/6) commercial.stock (sum quantities)...');
      let stockMerged = 0, stockMoved = 0;
      for (const [nonId, canonId] of productMap) {
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
      console.log(`    → ${stockMerged} stock rows merged, ${stockMoved} stock rows transferred`);

      // 4. commercial.stock_movements
      console.log('  (4/6) commercial.stock_movements...');
      let movsUpdated = 0;
      for (const [nonId, canonId] of productMap) {
        movsUpdated += await trx('commercial.stock_movements').where({ product_id: nonId }).update({ product_id: canonId });
      }
      console.log(`    → ${movsUpdated} movements reassigned`);

      // 5. commercial.order_lines
      console.log('  (5/6) commercial.order_lines...');
      let linesUpdated = 0;
      for (const [nonId, canonId] of productMap) {
        linesUpdated += await trx('commercial.order_lines').where({ product_id: nonId }).update({ product_id: canonId });
      }
      console.log(`    → ${linesUpdated} order_lines reassigned`);

      // 6. UPDATE brand_id de canónicas cross-brand que cambian de marca
      console.log('  (6/7) UPDATE brand_id de canonicals cross-brand...');
      let brandUpdated = 0;
      for (const it of plan) {
        if (it.needsBrandUpdate) {
          brandUpdated += await trx('products')
            .where({ id: it.canonical.id })
            .update({ brand_id: it.needsBrandUpdate, updated_at: trx.fn.now() });
        }
      }
      console.log(`    → ${brandUpdated} canonicals reasignados a brand correcta`);

      // 7. DELETE productos duplicados
      console.log('  (7/7) DELETE productos duplicados...');
      const allDelIds = [...productMap.keys()];
      const prodsDeleted = await trx('products').whereIn('id', allDelIds).del();
      console.log(`    → ${prodsDeleted} products deleted`);
    });

    console.log('\n✓ Normalización completa.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
