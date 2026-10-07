/**
 * HV.0 (Fase HV) — Auditoría de viabilidad: ¿puede la visión LEER los productos
 * del exhibidor y reconocerlos contra el catálogo?
 *
 * READ-ONLY (no escribe nada). Toma una muestra de fotos reales que YA traen
 * `productosMarcados` declarado (ground truth), corre el tool de visión EXTENDIDO
 * (products_seen[]) y mide, contra lo declarado:
 *   - recall a nivel MARCA (¿la visión nombró la marca que el colaborador marcó?)
 *   - recall a nivel SKU  (¿nombró el producto específico?)
 *   - legibilidad (clear/partial/guessed) y costo por foto (tokens).
 *
 * GATE de decisión (se imprime al final): si marca-level < ~60% en fotos `clear`,
 * el plan HV se recorta a marca-only. Los números mandan, no el entusiasmo.
 *
 * Uso: DATABASE_URL=... ANTHROPIC_API_KEY=... node database/scripts/horus-vision-products-audit.js [--n=40]
 */
require('dotenv').config({ quiet: true });

const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL || {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5433,
    database: process.env.DB_NAME || 'postgres_platform',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  },
  pool: { min: 1, max: 2 },
});

const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '').split('=')[1]) || 40;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.HORUS_CHAT_MODEL || 'claude-haiku-4-5-20251001';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 4_500_000;

// ── Normalización de texto para el matching aproximado (marca / SKU) ──────────
// Los nombres del catálogo son largos ("CUERITO RAYADO 700GR LUPITA") y las
// "marcas" son razones sociales de proveedor ("CUERITOS LUPITA"). Comparamos por
// tokens significativos, no por igualdad exacta.
const STOP = new Set([
  'de', 'la', 'el', 'los', 'las', 'con', 'sin', 'y', 'sa', 'cv', 'srl', 'rl',
  'gr', 'g', 'kg', 'ml', 'lt', 'l', 'pz', 'pza', 'pzas', 'caja', 'bolsa', 'pack',
  's', 'de', 'del',
]);
const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const tokens = (s) =>
  new Set(
    norm(s)
      .split(' ')
      .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)),
  );
/** ¿Alguno de los tokens significativos de `needle` aparece en `hay`? (recall laxo) */
const tokenHit = (needleTokens, hayTokens) => {
  for (const t of needleTokens) if (hayTokens.has(t)) return true;
  return false;
};

async function fetchImage(url) {
  const ctrl = new AbortController();
  const tId = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`fetch imagen ${res.status}`);
    let mediaType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MEDIA.includes(mediaType)) mediaType = 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error('imagen demasiado grande');
    return { base64: buf.toString('base64'), mediaType };
  } finally {
    clearTimeout(tId);
  }
}

/** Tool de visión EXTENDIDO (HV.1 preview): + products_seen[]. Extracción CIEGA. */
async function callVision(base64, mediaType) {
  const ctrl = new AbortController();
  const tId = setTimeout(() => ctrl.abort(), 40_000);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1200,
        tool_choice: { type: 'tool', name: 'read_exhibition_products' },
        tools: [
          {
            name: 'read_exhibition_products',
            description:
              'Lee los productos VISIBLES en la foto de una exhibición de dulces mexicana. ' +
              'Reportá SOLO lo que realmente se ve; no inventes ni completes de memoria.',
            input_schema: {
              type: 'object',
              properties: {
                is_shelf: { type: 'boolean', description: '¿Es una exhibición/anaquel de productos?' },
                photo_quality: { type: 'string', enum: ['good', 'blurry', 'dark', 'unusable'] },
                products_seen: {
                  type: 'array',
                  description: 'Un item por producto/marca DISTINTO que se lee en la foto.',
                  items: {
                    type: 'object',
                    properties: {
                      brand_text: { type: 'string', description: 'Marca leída del empaque (ej: "Lupita", "Sabritas"). Vacío si no se lee.' },
                      product_text: { type: 'string', description: 'Nombre/tipo de producto leído (ej: "cuerito rayado", "papas adobadas").' },
                      size_text: { type: 'string', description: 'Tamaño si es legible (ej: "700g"). Vacío si no.' },
                      facings_bucket: { type: 'string', enum: ['1', '2-4', '5+'], description: 'Cuántas caras/piezas del mismo producto se ven.' },
                      legibility: { type: 'string', enum: ['clear', 'partial', 'guessed'], description: 'clear=texto nítido, partial=parte legible, guessed=inferido por forma/color.' },
                    },
                    required: ['legibility'],
                  },
                },
              },
              required: ['is_shelf', 'photo_quality', 'products_seen'],
            },
          },
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
              {
                type: 'text',
                text:
                  'Sos un auditor de trade marketing. Listá los productos de dulces que se VEN en esta ' +
                  'exhibición, leyendo marcas y nombres de los empaques. Solo lo que realmente se ve.',
              },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${b.slice(0, 160)}`);
    }
    const json = await res.json();
    const tool = json.content?.find((c) => c.type === 'tool_use' && c.name === 'read_exhibition_products');
    return { input: tool?.input || null, usage: json.usage || null };
  } finally {
    clearTimeout(tId);
  }
}

async function main() {
  if (!API_KEY) {
    console.error('Falta ANTHROPIC_API_KEY. Abortando.');
    process.exit(1);
  }
  console.log(`HV.0 — auditoría de visión a nivel producto (muestra ${N} fotos)\n`);

  // Muestra: exhibiciones PROPIAS con foto + productos declarados (ground truth).
  const rows = await knex.raw(
    `SELECT dc.id AS capture_id, e->>'fotoUrl' AS foto_url, e->'productosMarcados' AS declared
       FROM daily_captures dc, jsonb_array_elements(dc.exhibiciones) e
      WHERE dc.hora_inicio >= now() - interval '60 days'
        AND e->>'fotoUrl' IS NOT NULL
        AND (e->>'perteneceMegaDulces')::boolean IS TRUE
        AND jsonb_typeof(e->'productosMarcados') = 'array'
        AND jsonb_array_length(e->'productosMarcados') > 0
      ORDER BY dc.hora_inicio DESC
      LIMIT ?`,
    [N * 3], // traemos de más y filtramos por diversidad simple (1 por captura)
  );

  // 1 exhibición por captura para diversidad de tiendas/momentos.
  const seen = new Set();
  const sample = [];
  for (const r of rows.rows) {
    if (seen.has(r.capture_id)) continue;
    seen.add(r.capture_id);
    sample.push(r);
    if (sample.length >= N) break;
  }
  console.log(`Muestra efectiva: ${sample.length} fotos\n`);

  // Resuelve TODOS los product_ids declarados → nombre + marca (una query).
  const allIds = [...new Set(sample.flatMap((r) => (Array.isArray(r.declared) ? r.declared : [])))];
  const prod = await knex('catalog.products as p')
    .leftJoin('catalog.brands as b', 'b.id', 'p.brand_id')
    .whereIn('p.id', allIds)
    .select('p.id', 'p.nombre', 'b.nombre as brand', 'b.display_name as brand_display');
  const pmap = new Map(prod.map((p) => [p.id, p]));

  const agg = {
    photos: 0,
    photos_shelf: 0,
    quality: {},
    seen_total: 0,
    legibility: { clear: 0, partial: 0, guessed: 0 },
    brand_hits: 0,
    brand_declared: 0,
    sku_hits: 0,
    sku_declared: 0,
    tokens_in: 0,
    tokens_out: 0,
    errors: 0,
  };

  for (let i = 0; i < sample.length; i++) {
    const s = sample[i];
    process.stdout.write(`  [${i + 1}/${sample.length}] `);
    try {
      const img = await fetchImage(s.foto_url);
      const { input, usage } = await callVision(img.base64, img.mediaType);
      if (!input) {
        agg.errors++;
        console.log('sin tool_use');
        continue;
      }
      agg.photos++;
      if (usage) {
        agg.tokens_in += usage.input_tokens || 0;
        agg.tokens_out += usage.output_tokens || 0;
      }
      agg.quality[input.photo_quality] = (agg.quality[input.photo_quality] || 0) + 1;
      if (input.is_shelf) agg.photos_shelf++;

      const seenList = Array.isArray(input.products_seen) ? input.products_seen : [];
      agg.seen_total += seenList.length;
      for (const p of seenList) agg.legibility[p.legibility] = (agg.legibility[p.legibility] || 0) + 1;

      // Índice de tokens de lo VISTO (marca + producto juntos).
      const seenTokens = seenList.map((p) => tokens(`${p.brand_text || ''} ${p.product_text || ''}`));
      const seenBrandTokens = seenList.map((p) => tokens(p.brand_text || ''));

      // Contra CADA producto declarado: ¿lo vio la visión?
      const declared = (Array.isArray(s.declared) ? s.declared : [])
        .map((id) => pmap.get(id))
        .filter(Boolean);

      let bH = 0, sH = 0;
      for (const d of declared) {
        const brandTok = tokens(d.brand_display || d.brand || '');
        const skuTok = tokens(d.nombre || '');
        const brandHit = seenBrandTokens.some((st) => tokenHit(brandTok, st)) ||
          seenTokens.some((st) => tokenHit(brandTok, st));
        const skuHit = seenTokens.some((st) => tokenHit(skuTok, st));
        if (brandTok.size && brandHit) bH++;
        if (skuTok.size && skuHit) sH++;
      }
      agg.brand_declared += declared.filter((d) => tokens(d.brand_display || d.brand || '').size).length;
      agg.sku_declared += declared.filter((d) => tokens(d.nombre || '').size).length;
      agg.brand_hits += bH;
      agg.sku_hits += sH;

      console.log(
        `shelf=${input.is_shelf ? 'sí' : 'no'} q=${input.photo_quality} vistos=${seenList.length} ` +
        `decl=${declared.length} marca✓${bH} sku✓${sH}`,
      );
    } catch (e) {
      agg.errors++;
      console.log(`ERROR ${e.message}`);
    }
  }

  const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
  const brandRecall = agg.brand_declared ? agg.brand_hits / agg.brand_declared : 0;
  const skuRecall = agg.sku_declared ? agg.sku_hits / agg.sku_declared : 0;

  console.log('\n══════════ RESULTADO HV.0 ══════════');
  console.log(`Fotos procesadas:        ${agg.photos} (errores: ${agg.errors})`);
  console.log(`Reconocidas como anaquel:${agg.photos_shelf} (${pct(agg.photos_shelf, agg.photos)})`);
  console.log(`Calidad de foto:         ${JSON.stringify(agg.quality)}`);
  console.log(`Productos vistos (total):${agg.seen_total}  (~${(agg.seen_total / (agg.photos || 1)).toFixed(1)}/foto)`);
  console.log(`Legibilidad:             ${JSON.stringify(agg.legibility)}`);
  console.log(`  → clear ${pct(agg.legibility.clear, agg.seen_total)} · partial ${pct(agg.legibility.partial, agg.seen_total)} · guessed ${pct(agg.legibility.guessed, agg.seen_total)}`);
  console.log('');
  console.log(`RECALL MARCA (declarado visto): ${agg.brand_hits}/${agg.brand_declared} = ${pct(agg.brand_hits, agg.brand_declared)}`);
  console.log(`RECALL SKU   (declarado visto): ${agg.sku_hits}/${agg.sku_declared} = ${pct(agg.sku_hits, agg.sku_declared)}`);
  console.log('');
  const perPhoto = agg.photos ? (agg.tokens_in + agg.tokens_out) / agg.photos : 0;
  console.log(`Tokens: in=${agg.tokens_in} out=${agg.tokens_out}  (~${perPhoto.toFixed(0)}/foto)`);
  console.log('');
  console.log('── GATE DE DECISIÓN ──');
  if (brandRecall >= 0.6) {
    console.log(`✅ Marca-level ${pct(agg.brand_hits, agg.brand_declared)} ≥ 60% → HV sigue con matching a catálogo.`);
    console.log(
      skuRecall >= 0.4
        ? `✅ SKU-level ${pct(agg.sku_hits, agg.sku_declared)} ≥ 40% → apuntar a SKU con verificación humana.`
        : `⚠️  SKU-level ${pct(agg.sku_hits, agg.sku_declared)} < 40% → arrancar MARCA-only; SKU solo con alias aprendidos.`,
    );
  } else {
    console.log(`⛔ Marca-level ${pct(agg.brand_hits, agg.brand_declared)} < 60% → recortar HV: texto crudo p/ mapa comercial, sin matching duro. Revisar prompt/calidad de foto antes de insistir.`);
  }
  console.log('\nNOTA: recall laxo por tokens (el ground truth `productosMarcados` es autodeclarado y');
  console.log('puede estar incompleto; un "miss" puede ser producto no declarado que SÍ está en la foto).');

  await knex.destroy();
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
