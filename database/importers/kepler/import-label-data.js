/* eslint-disable no-console */
/**
 * Etiquetera — datos de etiqueta Kepler → commercial.product_label_prices (BULK, source='kepler').
 *
 * Fuente (decodificada 2026-07-09, verificada vs SKU 20186):
 *   md.kdii             c1=código/sku, c2=nombre (trae gramaje "…50G/8"), c7=barcode pieza,
 *                       c81=pzas por paquete, c84=pzas por caja,
 *                       c90=precio pieza, c91=precio paquete, c92=precio caja.
 *   md.kdpv_prod_util   c2=presentación (PZA/PAQ/CJA), c4=min_qty (umbral mayoreo),
 *                       c7=precio. PZA con min_qty>1 = mayoreo por pieza; PAQ = mayoreo por paquete.
 *
 * Los precios de venta son de catálogo (iguales en toda la cadena) → una sola fuente Kepler
 * (KEPLER_URL), no per-sucursal como el stock/reorden. Prod: apuntar KEPLER_URL a la maestra.
 * NUNCA pisa filas source='manual'.
 *
 *   node database/importers/kepler/import-label-data.js          # dry-run
 *   node database/importers/kepler/import-label-data.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const SRC = process.env.KEPLER_URL || 'postgresql://postgres:superoot@localhost:5433/md_03';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

/**
 * Extrae gramaje del nombre Kepler. Cubre convenciones vistas en el catálogo:
 *   "50G/8"→"50 g", "5K"→"5 kg" (K sola = kilo), "5KGS"→"5 kg", "2OZ"→"2 oz",
 *   "500ML"→"500 ml", "1LT"→"1 l", "5 LITROS"→"5 l", "1LITRO"→"1 l". Alternativas
 *   largas ANTES que las de 1 letra para que "LITROS"/"KILOGRAMOS" ganen sobre `l`/`k`
 *   (esas se bloqueaban con el lookahead al chocar con la 2ª letra de la palabra).
 *   Lookahead (?![a-z0-9]) evita cazar la 1ª letra de otra palabra ("1 LUCAS"). sin match → null.
 */
function parseGramaje(name) {
  if (!name) return null;
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*(kilogramos?|kgs?|kilos?|gramos?|grs?|mililitros?|mls?|litros?|lts?|oz|kg|gr|ml|lt|k|g|l)(?![a-z0-9])/i);
  if (!m) return null;
  const num = m[1].replace(',', '.');
  const raw = m[2].toLowerCase();
  let u;
  if (raw === 'oz') u = 'oz';
  else if (raw[0] === 'k') u = 'kg';
  else if (raw.startsWith('ml') || raw.startsWith('mili')) u = 'ml';
  else if (raw[0] === 'g') u = 'g';
  else u = 'l';
  return `${num} ${u}`;
}

/** Simbología válida según longitud (igual que Kepler). Basura (5 díg, letras) → null. */
function barcodeFormat(code) {
  const c = String(code || '').trim();
  if (/^\d{13}$/.test(c)) return 'EAN13';
  if (/^\d{12}$/.test(c)) return 'UPC';
  if (/^\d{8}$/.test(c)) return 'EAN8';
  return null;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

(async () => {
  const db = new Client({ connectionString: DST });
  const src = new Client({ connectionString: SRC });
  await db.connect();
  try {
    await src.connect();
  } catch (e) {
    console.error(`ERROR: sin conexión a Kepler (${SRC}): ${e.message}`);
    await db.end();
    process.exitCode = 1;
    return;
  }

  try {
    console.log(`\n=== Etiquetas Kepler → commercial.product_label_prices (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===`);
    console.log(`  fuente: ${SRC.replace(/:[^:@/]+@/, ':***@')}\n`);

    // Catálogo: sku → product_id
    const prods = (await db.query(
      `SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo con sku: ${skuToId.size}`);

    // Maestro kdii (precios base + factores + barcode + nombre)
    const kdii = (await src.query(`
      SELECT c1 AS sku, c2 AS name, c7 AS barcode, c11 AS unit_base,
             c81 AS pack_size, c84 AS box_size,
             c90 AS piece_price, c91 AS pack_price, c92 AS box_price
        FROM md.kdii WHERE btrim(coalesce(c1,''))<>''`)).rows;

    // Tiers de mayoreo kdpv_prod_util
    const kdpv = (await src.query(`
      SELECT c1 AS sku, c2 AS present, c4::numeric AS min_qty, c7::numeric AS price
        FROM md.kdpv_prod_util WHERE c7 > 0`)).rows;
    const wholesale = new Map(); // sku → { pieceMinQty, piecePrice, packPrice }
    for (const r of kdpv) {
      const w = wholesale.get(r.sku) || {};
      const p = Number(r.price);
      if (r.present === 'PZA' && Number(r.min_qty) > 1) {
        // mayoreo por pieza: el tier más profundo (mejor precio)
        if (w.piecePrice == null || p < w.piecePrice) { w.piecePrice = p; w.pieceMinQty = int(r.min_qty); }
      } else if (r.present === 'PAQ') {
        // mayoreo por paquete: mejor precio
        if (w.packPrice == null || p < w.packPrice) w.packPrice = p;
      }
      wholesale.set(r.sku, w);
    }

    // Armar filas
    let matched = 0, unmatched = 0, noBarcode = 0;
    const staged = [];
    for (const r of kdii) {
      const pid = skuToId.get(r.sku);
      if (!pid) { unmatched++; continue; }
      const w = wholesale.get(r.sku) || {};
      const fmt = barcodeFormat(r.barcode);
      if (!fmt) noBarcode++;
      staged.push([
        pid,
        parseGramaje(r.name),
        fmt ? String(r.barcode).trim() : null,
        fmt,
        num(r.piece_price),
        w.pieceMinQty || null,
        w.piecePrice != null ? w.piecePrice : null,
        int(r.pack_size),
        num(r.pack_price),
        w.packPrice != null ? w.packPrice : null,
        int(r.box_size),
        num(r.box_price),
        (r.unit_base || '').trim().toUpperCase() || null,
      ]);
      matched++;
    }
    console.log(`  kdii filas: ${kdii.length} · match catálogo: ${matched} · sin match: ${unmatched} · sin barcode válido: ${noBarcode}`);
    const sample = staged.slice(0, 6).map((s) => ({ gramaje: s[1], barcode: s[2], fmt: s[3], pza: s[4], may_pza: s[6], paq: s[8], box: s[10] }));
    console.table(sample);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_label (
      product_id uuid, content text, barcode text, barcode_format text,
      piece_price numeric, wholesale_piece_min_qty int, wholesale_piece_price numeric,
      pack_size int, pack_price numeric, wholesale_pack_price numeric,
      box_size int, box_price numeric, unit_base text) ON COMMIT DROP`);
    for (let i = 0; i < staged.length; i += BATCH) {
      const chunk = staged.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((row, ri) => {
        const b = ri * 13;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13})`);
        params.push(...row);
      });
      await db.query(`INSERT INTO stg_label VALUES ${vals.join(',')}`, params);
    }
    const up = await db.query(`
      INSERT INTO commercial.product_label_prices
        (id, tenant_id, product_id, content, barcode, barcode_format, piece_price,
         wholesale_piece_min_qty, wholesale_piece_price, pack_size, pack_price,
         wholesale_pack_price, box_size, box_price, unit_base, source, computed_at, updated_at)
      SELECT gen_random_uuid(), $1, s.product_id, s.content, s.barcode, s.barcode_format, s.piece_price,
             s.wholesale_piece_min_qty, s.wholesale_piece_price, s.pack_size, s.pack_price,
             s.wholesale_pack_price, s.box_size, s.box_price, s.unit_base, 'kepler', now(), now()
      FROM stg_label s
      ON CONFLICT (tenant_id, product_id) DO UPDATE SET
        content=EXCLUDED.content, barcode=EXCLUDED.barcode, barcode_format=EXCLUDED.barcode_format,
        piece_price=EXCLUDED.piece_price, wholesale_piece_min_qty=EXCLUDED.wholesale_piece_min_qty,
        wholesale_piece_price=EXCLUDED.wholesale_piece_price, pack_size=EXCLUDED.pack_size,
        pack_price=EXCLUDED.pack_price, wholesale_pack_price=EXCLUDED.wholesale_pack_price,
        box_size=EXCLUDED.box_size, box_price=EXCLUDED.box_price, unit_base=EXCLUDED.unit_base,
        source='kepler', computed_at=now(), updated_at=now()
      WHERE commercial.product_label_prices.source <> 'manual'`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas de etiqueta upserted.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
    await src.end();
  }
})();
