/* eslint-disable no-console */
/**
 * Cómputo de la etiqueta de anaquel — ÚNICA fuente de verdad, compartida por:
 *   - database/importers/kepler/import-label-data.js  (backstop nocturno, full-catálogo)
 *   - services/feeds-ingest/apply-handlers.js          (hop-2 al-momento, scoped a SKUs)
 *
 * Vive DENTRO de services/feeds-ingest/ porque el Dockerfile solo copia esta carpeta (self-contained).
 * El importer lo requiere por ruta relativa. Regla: lo derivado del ODS se refresca AL LLEGAR el cambio
 * (feedback_ods_derived_realtime_no_batch_lag) — el nightly queda solo como reconciliador.
 *
 * Decode Kepler (verificado): kdii c1=sku, c2=nombre(+gramaje), c7=barcode pieza, c95=barcode alt,
 * c11=unidad base, (c80,c81,c91)/(c83,c84,c92)=pares (etiqueta,factor,precio), c90=precio pieza.
 * kdpv_prod_util c1=sku, c2=presentación, c4=min_qty, c7=precio (tiers de mayoreo).
 */

const OK_SCHEMA = new Set(['kepler_ods', 'kp']); // whitelist anti-inyección (schema va inline)

// ---- helpers puros (1:1 con import-label-data.js) ----
function parseGramaje(name) {
  if (!name) return null;
  const m = String(name).match(/(\d+(?:[.,]\d+)?)\s*(kilogramos?|kgs?|kilos?|gramos?|grs?|mililitros?|mls?|litros?|lts?|oz|kg|gr|ml|lt|k|g|l)(?![a-z0-9])/i);
  if (!m) return null;
  const numv = m[1].replace(',', '.');
  const raw = m[2].toLowerCase();
  let u;
  if (raw === 'oz') u = 'oz';
  else if (raw[0] === 'k') u = 'kg';
  else if (raw.startsWith('ml') || raw.startsWith('mili')) u = 'ml';
  else if (raw[0] === 'g') u = 'g';
  else u = 'l';
  return `${numv} ${u}`;
}
function barcodeFormat(code) {
  const c = String(code || '').trim();
  if (/^\d{13}$/.test(c)) return 'EAN13';
  if (/^\d{12}$/.test(c)) return 'UPC';
  if (/^\d{8}$/.test(c)) return 'EAN8';
  return null;
}
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
function basePresentKey(unitBase) {
  const ub = String(unitBase || '').trim().toUpperCase();
  if (ub === 'KG') return 'KG';
  if (/^\d+$/.test(ub)) return ub;
  if (ub === 'PAQ') return 'PAQ';
  if (ub === 'CJA') return 'CJA';
  return 'PZA';
}
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

// ---- SQL (schema whitelisted inline; SKUs opcionales por $1) ----
/**
 * `[NORM.3]` Una fila por **(sku, sucursal)** — antes era una sola por SKU, con el precio elegido
 * por `mode()` sobre las plazas.
 *
 * Por qué se retiró la moda: el precio de Kepler **es** por plaza, y colapsarlo publicaba el de
 * otra tienda. Medido en prod el 2026-09-11: **1,039 de 9,365 SKUs (11.1 %)** tienen precio de
 * pieza distinto entre plazas retail (brecha mediana 3.1 %, p90 37.3 %), y **1,729 de los 69,711
 * pares sku×plaza (2.5 %)** publicaban un precio que no era el de su plaza. El mostrador y la
 * etiqueta del anaquel de esa tienda mostraban el número de otra.
 *
 * `kdii` trae exactamente una fila por (sku, sucursal) — verificado en prod: 76,586 pares, cero
 * duplicados — así que acá no hace falta ningún desempate.
 */
function kdiiSql(schema, hasSkus) {
  const ff = hasSkus ? 'AND btrim(k.c1) = ANY($1)' : '';
  return `
    SELECT btrim(k.sucursal::text) AS sucursal,
           k.c1 AS sku, k.c2 AS name, k.c7 AS barcode, k.c95 AS barcode_alt, k.c11 AS unit_base,
           btrim(k.c80) AS u1, k.c81 AS f1, k.c91 AS p1,
           btrim(k.c83) AS u2, k.c84 AS f2, k.c92 AS p2,
           k.c90::numeric AS piece_price
      FROM ${schema}.kdii k
     WHERE btrim(coalesce(k.c1,''))<>'' AND k.c90::numeric > 0.05 ${ff}
     ORDER BY btrim(k.c1), btrim(k.sucursal::text)`;
}
/**
 * `[NORM.3]` Los escalones de mayoreo también salen de la plaza: `kdpv_prod_util` tiene `sucursal`
 * y la usa. Medido: la cobertura es pareja (~41,600 filas y ~9,300 SKUs en cada una de las 8), y
 * sólo **485 pares (sku, plaza)** no tienen escalón propio teniéndolo en otra — ésos se quedan sin
 * mayoreo a propósito: Kepler dice que en esa tienda no existe.
 */
function kdpvSql(schema, hasSkus) {
  return `SELECT DISTINCT btrim(sucursal::text) AS sucursal,
                 c1 AS sku, c2 AS present, c4::numeric AS min_qty, c7::numeric AS price
            FROM ${schema}.kdpv_prod_util WHERE c7 > 0 ${hasSkus ? 'AND c1 = ANY($1)' : ''}`;
}

/** Ensambla el objeto etiqueta de una fila kdii + el mapa de tiers de su SKU. */
function assembleLabel(r, tiers) {
  const bp = basePresentKey(r.unit_base);
  const soldByKg = bp === 'KG';
  const grouped = bp === 'PAQ' || bp === 'CJA';
  const baseTier = tiers.get(bp) || null;
  const paqTier = tiers.get('PAQ') || null;
  const w = grouped
    ? { packPrice: baseTier ? baseTier.price : null, packMinQty: baseTier ? baseTier.minQty : null, piecePrice: null, pieceMinQty: null }
    : {
        piecePrice: baseTier ? baseTier.price : null, pieceMinQty: baseTier ? baseTier.minQty : null,
        packPrice: bp === 'PZA' && paqTier ? paqTier.price : null,
        packMinQty: bp === 'PZA' && paqTier ? paqTier.minQty : null,
      };
  const bcReal = barcodeFormat(r.barcode) ? String(r.barcode).trim() : r.barcode_alt;
  const fmt = barcodeFormat(bcReal);
  const u = resolveUnits([
    { label: r.u1, factor: r.f1, price: r.p1 },
    { label: r.u2, factor: r.f2, price: r.p2 },
  ]);
  return {
    sku: String(r.sku || '').trim(),
    sucursal: String(r.sucursal || '').trim(),               // `[NORM.3]` la plaza es parte de la llave
    name: r.name,
    barcode_raw: r.barcode,                                  // c7 crudo (para el fallback sku→pid del importer)
    content: parseGramaje(r.name),
    barcode: fmt ? String(bcReal).trim() : null,             // EAN validado (o null)
    barcode_format: fmt,
    piece_price: num(r.piece_price),
    wholesale_piece_min_qty: w.pieceMinQty || null,
    wholesale_piece_price: w.piecePrice != null ? w.piecePrice : null,
    pack_size: u.pack_size,
    pack_price: u.pack_price,
    wholesale_pack_price: w.packPrice != null ? w.packPrice : null,
    wholesale_pack_min_qty: w.packMinQty || null,
    box_size: u.box_size,
    box_price: u.box_price,
    unit_base: (r.unit_base || '').trim().toUpperCase() || null,
    sold_by_kg: soldByKg,
  };
}

/** Lee kdii+kdpv (scoped a `skus` si se pasa) y devuelve los objetos etiqueta por SKU. */
async function computeLabels(readClient, { schema, skus } = {}) {
  if (!OK_SCHEMA.has(schema)) throw new Error(`label-compute: schema inválido '${schema}'`);
  const hasSkus = Array.isArray(skus) && skus.length > 0;
  const params = hasSkus ? [skus] : [];
  const kdii = (await readClient.query(kdiiSql(schema, hasSkus), params)).rows;
  const kdpv = (await readClient.query(kdpvSql(schema, hasSkus), params)).rows;
  // `[NORM.3]` La llave del mapa es (sku, PLAZA). Antes era sólo el sku, así que un escalón de
  // cualquier tienda se aplicaba a todas.
  // Separador EXPLÍCITO y visible: sin él, sku '1' + plaza '23' colisiona con sku '12' + plaza '3'.
  const llave = (sku, suc) => `${String(sku || '').trim()}|${String(suc || '').trim()}`;
  const wholesale = new Map(); // (sku,plaza) -> Map(presentacion -> {price, minQty}); solo tiers con umbral real, el mas barato
  for (const r of kdpv) {
    const present = String(r.present || '').trim().toUpperCase();
    const p = Number(r.price);
    if (!present || !Number.isFinite(p) || p <= 0) continue;
    const mq = int(r.min_qty);
    if (!mq || mq <= 1) continue;
    const k = llave(r.sku, r.sucursal);
    let m = wholesale.get(k);
    if (!m) { m = new Map(); wholesale.set(k, m); }
    const cur = m.get(present);
    // más barato por presentación; DESEMPATE DETERMINISTA por menor minQty (si no, el DISTINCT sin
    // orden elegiría distinto cada corrida → el hop-2 churn-free reescribiría en cada tick de kdii).
    if (!cur || p < cur.price || (p === cur.price && mq < cur.minQty)) m.set(present, { price: p, minQty: mq });
  }
  return kdii.map((r) => assembleLabel(r, wholesale.get(llave(r.sku, r.sucursal)) || new Map()));
}

// ---- staged + upsert (compartidos: mismo orden de columnas y mismo SQL) ----
/** `[NORM.3]` Las columnas que forman la identidad de la fila. La plaza entró acá, no en los datos. */
const KEY_COLS = ['product_id', 'sucursal'];
const LABEL_STAGE_COLS = [
  ...KEY_COLS, 'content', 'barcode', 'barcode_format', 'piece_price',
  'wholesale_piece_min_qty', 'wholesale_piece_price', 'pack_size', 'pack_price',
  'wholesale_pack_price', 'box_size', 'box_price', 'unit_base', 'wholesale_pack_min_qty', 'sold_by_kg',
];
function toStageTuple(lab, productId) {
  return [
    productId, lab.sucursal, lab.content, lab.barcode, lab.barcode_format, lab.piece_price,
    lab.wholesale_piece_min_qty, lab.wholesale_piece_price, lab.pack_size, lab.pack_price,
    lab.wholesale_pack_price, lab.box_size, lab.box_price, lab.unit_base, lab.wholesale_pack_min_qty, lab.sold_by_kg,
  ];
}

// columnas de DATOS (las que no son llave) para el guard churn-free y el SET. Se deriva de
// KEY_COLS en vez de `slice(1)` para que agregar una columna de llave no meta la plaza en el SET
// —escribir la llave en el UPDATE es cómo se corrompe una fila sin que nadie lo note—.
const DATA_COLS = LABEL_STAGE_COLS.filter((c) => !KEY_COLS.includes(c));

/**
 * UPSERT churn-free a commercial.product_label_prices. El caller ya hizo BEGIN + SET LOCAL app.tenant_id.
 * NUNCA pisa source='manual'. Solo reescribe si algún dato cambió (IS DISTINCT FROM) → sin churn aunque
 * kdii tickee seguido. Devuelve filas cambiadas.
 *
 * `changedOut` (opcional) — array donde se empujan los `product_id` que REALMENTE cambiaron, para que
 * el caller pueda avisarle a las pantallas cuáles refrescar (`[TDA.1]`).
 *
 * Es un parámetro de salida y no un cambio del retorno a propósito: los dos llamadores
 * (`apply-handlers.normalizeLabelsFromOds` y `database/importers/kepler/import-label-data.js`) usan el
 * retorno como NÚMERO, y el segundo es un importer que corre on-prem desde el working tree — o sea que
 * cambiarle el tipo de retorno es un cambio en producción en el momento de guardar el archivo. Un
 * cuarto argumento que nadie pasa no le mueve nada a los llamadores viejos.
 *
 * `RETURNING product_id` es gratis acá: el UPSERT ya tiene el `WHERE ... IS DISTINCT FROM`, así que
 * devuelve exactamente las filas que se escribieron, no las que se intentaron.
 */
async function upsertLabels(client, tenantId, tuples, BATCH = 1000, changedOut = null) {
  if (!tuples.length) return 0;
  await client.query(`CREATE TEMP TABLE stg_label (
    product_id uuid, sucursal text, content text, barcode text, barcode_format text,
    piece_price numeric, wholesale_piece_min_qty int, wholesale_piece_price numeric,
    pack_size int, pack_price numeric, wholesale_pack_price numeric,
    box_size int, box_price numeric, unit_base text, wholesale_pack_min_qty int, sold_by_kg boolean) ON COMMIT DROP`);
  // El ancho sale de LABEL_STAGE_COLS, no de un 15 escrito a mano: agregar una columna y olvidar
  // el número es cómo se desalinean los parámetros sin que falle nada visible.
  const W = LABEL_STAGE_COLS.length;
  for (let i = 0; i < tuples.length; i += BATCH) {
    const chunk = tuples.slice(i, i + BATCH);
    const vals = [], params = [];
    chunk.forEach((row, ri) => {
      const b = ri * W;
      vals.push(`(${Array.from({ length: W }, (_, j) => `$${b + j + 1}`).join(',')})`);
      params.push(...row);
    });
    await client.query(`INSERT INTO stg_label VALUES ${vals.join(',')}`, params);
  }
  const setList = DATA_COLS.map((c) => `${c}=EXCLUDED.${c}`).join(', ');
  const tTuple = DATA_COLS.map((c) => `commercial.product_label_prices.${c}`).join(', ');
  const eTuple = DATA_COLS.map((c) => `EXCLUDED.${c}`).join(', ');
  const cols = LABEL_STAGE_COLS.join(', ');
  const up = await client.query(`
    INSERT INTO commercial.product_label_prices
      (id, tenant_id, ${cols}, source, computed_at, updated_at)
    SELECT gen_random_uuid(), $1, ${LABEL_STAGE_COLS.map((c) => 's.' + c).join(', ')}, 'kepler', now(), now()
    FROM stg_label s
    ON CONFLICT (tenant_id, product_id, sucursal) DO UPDATE SET
      ${setList}, source='kepler', computed_at=now(), updated_at=now()
    WHERE commercial.product_label_prices.source <> 'manual'
      AND (${tTuple}) IS DISTINCT FROM (${eTuple})
    RETURNING product_id`, [tenantId]);
  if (Array.isArray(changedOut)) for (const r of up.rows) changedOut.push(r.product_id);
  return up.rowCount;
}

module.exports = {
  parseGramaje, barcodeFormat, basePresentKey, resolveUnits, num, int,
  computeLabels, LABEL_STAGE_COLS, KEY_COLS, toStageTuple, upsertLabels,
};
