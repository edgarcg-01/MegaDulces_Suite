/**
 * Carga / sincroniza el corpus del RAG en la DB vector dedicada — Fase K v2.
 *
 * Lee productos ACTIVOS de la fuente (`public.products` + brands), embebe los
 * nuevos/renombrados via Voyage (input_type='document'), upsert en
 * `product_embeddings` de la DB vector, y borra los que dejaron de estar
 * activos. Idempotente: re-correr solo embebe lo que cambió. Drena TODO
 * (loopea hasta que no queda stale) — sirve como carga inicial de los 7,569.
 *
 * Env:
 *   VECTOR_DATABASE_URL      (destino, requerido)
 *   PRODUCT_SOURCE_URL       (fuente; default = DATABASE_URL)
 *   VOYAGE_API_KEY           (requerido)
 *   VOYAGE_EMBED_MODEL       (default 'voyage-3')
 *
 * Uso:
 *   VECTOR_DATABASE_URL='postgres://...' PRODUCT_SOURCE_URL='postgres://...' \
 *   node database/scripts/load-vector-db.js
 */
const path = require('path');
const knex = require(path.join(__dirname, '..', '..', 'node_modules', 'knex'));

const VECTOR_URL = process.env.VECTOR_DATABASE_URL;
const SOURCE_URL = process.env.PRODUCT_SOURCE_URL || process.env.DATABASE_URL;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const VOYAGE_MODEL = process.env.VOYAGE_EMBED_MODEL || 'voyage-3';
const EMBED_CHUNK = 100; // < 128 límite Voyage

if (!VECTOR_URL) { console.error('ERROR: falta VECTOR_DATABASE_URL'); process.exit(1); }
if (!SOURCE_URL) { console.error('ERROR: falta PRODUCT_SOURCE_URL (o DATABASE_URL)'); process.exit(1); }
if (!VOYAGE_KEY) { console.error('ERROR: falta VOYAGE_API_KEY'); process.exit(1); }

const ssl = (u) => (/rlwy|railway|proxy|amazonaws|render|supabase/i.test(u) ? { rejectUnauthorized: false } : false);
const src = knex({ client: 'pg', connection: { connectionString: SOURCE_URL, ssl: ssl(SOURCE_URL) }, pool: { min: 0, max: 3 } });
const vec = knex({ client: 'pg', connection: { connectionString: VECTOR_URL, ssl: ssl(VECTOR_URL) }, pool: { min: 0, max: 3 } });

const sourceText = (brand, name) =>
  [brand, name].filter((s) => s && String(s).trim()).map((s) => String(s).trim()).join(' — ');

async function voyageEmbed(texts, attempt = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${VOYAGE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: 'document' }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const w = 1000 * 2 ** attempt;
        console.log(`  Voyage ${res.status}, retry en ${w}ms`);
        await new Promise((r) => setTimeout(r, w));
        return voyageEmbed(texts, attempt + 1);
      }
      throw new Error(`Voyage ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  } catch (e) {
    clearTimeout(t);
    if (attempt < 4) {
      const w = 1000 * 2 ** attempt;
      console.log(`  Voyage error (${e.message}), retry en ${w}ms`);
      await new Promise((r) => setTimeout(r, w));
      return voyageEmbed(texts, attempt + 1);
    }
    throw e;
  }
}

(async () => {
  try {
    // 1) Activos de la fuente.
    const active = await src('products as p')
      .leftJoin('brands as b', 'b.id', 'p.brand_id')
      .where('p.activo', true)
      .select('p.id', 'p.tenant_id', 'p.brand_id', 'p.nombre as product_name', 'b.nombre as brand_name');
    const activeIds = new Set(active.map((p) => p.id));
    console.log(`Fuente: ${active.length} productos activos.`);

    // 2) Estado del vector store.
    const existingRows = await vec('product_embeddings').select('product_id', 'source_text');
    const existing = new Map(existingRows.map((r) => [r.product_id, r.source_text]));
    console.log(`Vector store: ${existingRows.length} filas actuales.`);

    // 3) Borrar inactivos (con guarda anti-wipe: >30% del store ⇒ fuente sospechosa).
    const toDelete = existingRows.map((r) => r.product_id).filter((id) => !activeIds.has(id));
    let deleted = 0;
    const wipeRatio = existingRows.length > 0 ? toDelete.length / existingRows.length : 0;
    if (toDelete.length > 0 && wipeRatio > 0.3) {
      console.warn(
        `⚠ delete eliminaría ${toDelete.length}/${existingRows.length} (${Math.round(wipeRatio * 100)}%) — fuente parece incompleta, SALTANDO borrado. Revisar PRODUCT_SOURCE_URL.`,
      );
    } else {
      for (let i = 0; i < toDelete.length; i += 500) {
        deleted += await vec('product_embeddings').whereIn('product_id', toDelete.slice(i, i + 500)).del();
      }
      if (deleted) console.log(`Borrados ${deleted} inactivos del store.`);
    }

    // 4) Stale = nuevos o renombrados.
    const stale = active.filter((p) => existing.get(p.id) !== sourceText(p.brand_name, p.product_name));
    console.log(`A embeber (nuevos/renombrados): ${stale.length}.\n`);

    let processed = 0, failed = 0;
    for (let i = 0; i < stale.length; i += EMBED_CHUNK) {
      const chunk = stale.slice(i, i + EMBED_CHUNK);
      const texts = chunk.map((p) => sourceText(p.brand_name, p.product_name));
      let vectors;
      try {
        vectors = await voyageEmbed(texts);
      } catch (e) {
        failed += chunk.length;
        console.warn(`  chunk ${i}-${i + chunk.length} falló: ${e.message}`);
        continue;
      }
      await vec.transaction(async (trx) => {
        for (let j = 0; j < chunk.length; j++) {
          const p = chunk[j];
          await trx.raw(
            `INSERT INTO product_embeddings
               (product_id, tenant_id, brand_id, brand_name, product_name, source_text, embedding, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?::vector, now())
             ON CONFLICT (product_id) DO UPDATE SET
               tenant_id=EXCLUDED.tenant_id, brand_id=EXCLUDED.brand_id,
               brand_name=EXCLUDED.brand_name, product_name=EXCLUDED.product_name,
               source_text=EXCLUDED.source_text, embedding=EXCLUDED.embedding, updated_at=now()`,
            [p.id, p.tenant_id, p.brand_id, p.brand_name, p.product_name, texts[j], `[${vectors[j].join(',')}]`],
          );
          processed++;
        }
      });
      console.log(`  progreso: ${Math.min(i + EMBED_CHUNK, stale.length)}/${stale.length} (${processed} ok)`);
    }

    const total = await vec('product_embeddings').count('* as n').first();
    console.log(`\n✓ Embebidos ${processed}, fallidos ${failed}, borrados ${deleted}. Total en store: ${total.n}.`);
    if (failed) console.log('Re-corré el script para reintentar los fallidos (idempotente).');
  } catch (e) {
    console.error('\n✗ Error:', e.message);
    if (e.stack) console.error(e.stack);
    process.exitCode = 1;
  } finally {
    await src.destroy();
    await vec.destroy();
  }
})();
