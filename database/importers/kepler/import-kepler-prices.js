/* eslint-disable no-console */
/**
 * Importer Kepler → commercial.product_prices (precios de venta reales).
 *
 * Fuente: md.kdpv_prod_util (c1=SKU, c2=presentación, c3=tier, c4=min_qty,
 * c6=margen, c7=precio de venta). 9,036 SKUs reales.
 *
 * Mapeo (decidido con Edgar 2026-06-15): el gradiente de precio por cliente son
 * los TIERS de volumen (no la presentación). Por cada SKU se toma su presentación
 * principal (preferencia PZA > PAQ > CJA > KG > BTO > primera disponible) y sus
 * tiers ordenados de menor cantidad (más caro) a mayor (más barato) se mapean:
 *   tier 0 → P1 (público) … tier n → P4 (mayorista). Listas faltantes se rellenan
 *   con el mejor precio disponible (P4 = el más barato del SKU).
 *
 * Join a catálogo: kdpv_prod_util.c1 == public.products.sku.
 * Upsert por (price_list, product). tax_rate default 0.16 (IVA) — AJUSTAR si el
 * precio de Kepler ya incluye impuestos.
 *
 *   node database/importers/kepler/import-kepler-prices.js          # dry-run
 *   node database/importers/kepler/import-kepler-prices.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const APPLY = process.argv.includes('--apply');

const PRESENT_PREF = ['PZA', 'PAQ', 'CJA', 'KG', 'BTO'];
const LIST_ORDER = ['P1', 'P2', 'P3', 'P4']; // P1 = más caro (público) … P4 = más barato
const TAX_RATE = 0.16;

(async () => {
  const db = new Client({ connectionString: DST });
  const src = new Client({ connectionString: SRC });
  await db.connect();
  await src.connect();

  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    console.log(`\n=== Import precios Kepler → product_prices (${APPLY ? 'APPLY' : 'DRY-RUN → rollback'}) ===\n`);

    // Listas destino
    const { rows: lists } = await db.query(
      `SELECT id, code FROM commercial.price_lists WHERE tenant_id=$1 AND code = ANY($2)`, [M, LIST_ORDER]);
    const listId = Object.fromEntries(lists.map((l) => [l.code, l.id]));
    for (const code of LIST_ORDER) if (!listId[code]) throw new Error(`Falta lista de precio ${code}`);

    // Catálogo: sku → product_id
    const { rows: prods } = await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1`, [M]);
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));

    // Precios Kepler
    const { rows: kp } = await src.query(
      `SELECT c1 AS sku, c2 AS present, c3::int AS tier, c4::numeric AS min_qty, c7::numeric AS price
         FROM md.kdpv_prod_util WHERE c7 > 0 ORDER BY c1, c2, c3`);

    // Agrupar por SKU → presentación → tiers
    const bySku = new Map();
    for (const r of kp) {
      if (!bySku.has(r.sku)) bySku.set(r.sku, new Map());
      const pres = bySku.get(r.sku);
      if (!pres.has(r.present)) pres.set(r.present, []);
      pres.get(r.present).push(r);
    }

    let matched = 0, unmatched = 0, upserts = 0;
    const sample = [];
    for (const [sku, pres] of bySku) {
      const productId = skuToId.get(sku);
      if (!productId) { unmatched++; continue; }
      matched++;

      // Presentación principal
      let chosen = PRESENT_PREF.find((p) => pres.has(p)) || [...pres.keys()][0];
      const tiers = pres.get(chosen).sort((a, b) => Number(a.min_qty) - Number(b.min_qty)); // caro→barato

      // Mapear tiers a P1..P4 (rellenar con el último tier disponible)
      const priceFor = (i) => tiers[Math.min(i, tiers.length - 1)];
      for (let i = 0; i < LIST_ORDER.length; i++) {
        const t = priceFor(i);
        await db.query(
          `INSERT INTO commercial.product_prices (tenant_id, price_list_id, product_id, price, tax_rate, min_qty)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, price_list_id, product_id)
           DO UPDATE SET price=EXCLUDED.price, tax_rate=EXCLUDED.tax_rate, min_qty=EXCLUDED.min_qty, updated_at=now()`,
          [M, listId[LIST_ORDER[i]], productId, Number(t.price), TAX_RATE, Number(t.min_qty) || 1]);
        upserts++;
      }
      if (sample.length < 10) sample.push({ sku, present: chosen, p: LIST_ORDER.map((_, i) => priceFor(i).price) });
    }

    console.log(`SKUs Kepler con precio: ${bySku.size} · match catálogo: ${matched} · sin match: ${unmatched}`);
    console.log(`Upserts product_prices (P1-P4): ${upserts}\n`);
    console.log('Muestra (SKU · presentación · P1/P2/P3/P4):');
    sample.forEach((s) => console.log(`  ${s.sku.padEnd(7)} ${s.present.padEnd(4)} ${s.p.join(' / ')}`));

    if (APPLY) {
      await db.query('COMMIT');
      console.log('\n[APPLY] COMMIT — precios reales importados.');
    } else {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — nada cambió. Corré con --apply para confirmar.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
    await src.end();
  }
})();
