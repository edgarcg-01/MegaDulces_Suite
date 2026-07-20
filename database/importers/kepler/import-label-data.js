/* eslint-disable no-console */
/**
 * Etiquetera — datos de etiqueta Kepler → commercial.product_label_prices (BULK, source='kepler').
 *
 * Fuente = CONCENTRADA `kp.*` en .245 (todas las sucursales). Reconcilia precios entre sucursales:
 * algunas traen placeholders ($6/$0.01 debajo del costo) → por SKU se toma la sucursal con el
 * precio de pieza (c90) MÁS ALTO (el real; los placeholders son bajos). Ver SKU 20804 (2026-07-20).
 *
 * Fuente (decodificada 2026-07-09; corregida 2026-07-10 — modelo de unidades por ETIQUETA):
 *   kp.kdii             c1=sku, c2=nombre (trae gramaje "…50G/8"), c7=barcode pieza, c11=unidad base.
 *                       UNIDADES = pares (etiqueta, factor): (c80,c81) y (c83,c84), con precios
 *                       c90=pieza, c91=precio de la unidad c80, c92=precio de la unidad c83.
 *                       El factor es PIEZAS por esa unidad. La etiqueta manda (NO la posición):
 *                       PAQ→paquete · CJA→caja · PZA→base(=1) · KG/BTO→granel (se ignoran para
 *                       pack/box). ⚠️ El 75% del catálogo NO tiene paquete: su unidad es CJA
 *                       directo (c80='CJA') → antes se guardaba mal como "pzas por paquete".
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
// Fuente = CONCENTRADA kp.* (todas las sucursales) para poder reconciliar precios entre sucursales.
const SRC = process.env.KEPLER_URL || 'postgresql://postgres:superoot@192.168.0.245:5432/KP_CONCENTRADA';
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

/**
 * Resuelve paquete/caja desde los 2 pares (etiqueta, factor, precio) de kdii.
 * Por ETIQUETA, no por posición: PAQ→paquete, CJA→caja. Solo cuenta factores >1
 * (un PZA×1 o PAQ×1 es la base, no agrupa). KG/BTO/otros no mapean a pack/box.
 */
function resolveUnits(slots) {
  let pack_size = null, pack_price = null, box_size = null, box_price = null;
  for (const s of slots) {
    const f = int(s.factor);
    if (!s.label || !f || f <= 1) continue;
    if (s.label === 'PAQ') { pack_size = f; pack_price = num(s.price); }
    else if (s.label === 'CJA') { box_size = f; box_price = num(s.price); }
  }
  return { pack_size, pack_price, box_size, box_price };
}

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

    // Catálogo: índices por SKU y por BARCODE. El barcode es fallback para productos
    // que llegaron al catálogo SIN sku (ej. OJILOCOS): Kepler los tiene por SKU pero el
    // enlace por sku falla, así que los enganchamos por su código de barras (kdii.c7).
    const prods = (await db.query(
      `SELECT id, btrim(coalesce(sku,'')) AS sku, btrim(coalesce(barcode,'')) AS barcode
         FROM public.products WHERE tenant_id=$1`, [M])).rows;
    const skuToId = new Map();
    const bcToId = new Map();
    for (const p of prods) {
      if (p.sku) skuToId.set(p.sku, p.id);
      if (p.barcode && !bcToId.has(p.barcode)) bcToId.set(p.barcode, p.id);
    }
    console.log(`  catálogo: ${skuToId.size} con sku · ${bcToId.size} con barcode`);

    // Maestro kdii — CONCENTRADA (kp.kdii, todas las sucursales). El precio de venta debe ser
    // catálogo-wide, pero hay sucursales con placeholders ($6/$0.01 debajo del costo). Reconciliamos:
    // por SKU tomamos la sucursal con el precio de pieza (c90) MÁS ALTO (los placeholders son bajos).
    // `DISTINCT ON (sku) … ORDER BY sku, c90 DESC` = una fila por SKU, la de mayor precio real.
    const kdii = (await src.query(`
      SELECT DISTINCT ON (btrim(c1))
             c1 AS sku, c2 AS name, c7 AS barcode, c11 AS unit_base,
             btrim(c80) AS u1, c81 AS f1, c91 AS p1,
             btrim(c83) AS u2, c84 AS f2, c92 AS p2,
             c90 AS piece_price
        FROM kp.kdii
       WHERE btrim(coalesce(c1,''))<>'' AND c90::numeric > 0
       ORDER BY btrim(c1), c90::numeric DESC`)).rows;

    // Tiers de mayoreo — concentrada. Dedup (present,precio); el mejor precio por presentación.
    const kdpv = (await src.query(`
      SELECT DISTINCT c1 AS sku, c2 AS present, c4::numeric AS min_qty, c7::numeric AS price
        FROM kp.kdpv_prod_util WHERE c7 > 0`)).rows;
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
      // Match por SKU; si no, fallback por barcode (productos sin sku en el catálogo).
      let pid = skuToId.get(String(r.sku || '').trim());
      if (!pid) {
        const bc = String(r.barcode || '').trim();
        if (bc) pid = bcToId.get(bc);
      }
      if (!pid) { unmatched++; continue; }
      const w = wholesale.get(r.sku) || {};
      const fmt = barcodeFormat(r.barcode);
      if (!fmt) noBarcode++;
      // Unidades por etiqueta (paquete/caja reales, no por posición).
      const u = resolveUnits([
        { label: r.u1, factor: r.f1, price: r.p1 },
        { label: r.u2, factor: r.f2, price: r.p2 },
      ]);
      staged.push([
        pid,
        parseGramaje(r.name),
        fmt ? String(r.barcode).trim() : null,
        fmt,
        num(r.piece_price),
        w.pieceMinQty || null,
        w.piecePrice != null ? w.piecePrice : null,
        u.pack_size,
        u.pack_price,
        w.packPrice != null ? w.packPrice : null,
        u.box_size,
        u.box_price,
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
