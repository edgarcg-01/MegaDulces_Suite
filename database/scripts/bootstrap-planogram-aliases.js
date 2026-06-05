/**
 * Bootstrap de `trade.planogram_sku_aliases`: mapea códigos del set activo ERP
 * (inventory.products_active) a productos del planograma (852) cuando son EL MISMO
 * PRODUCTO, incluyendo variantes/formatos.
 *
 * Regla = FRASE CONTIGUA (no bolsa de tokens): el nombre del planograma debe
 * aparecer como secuencia contigua de tokens (en orden) dentro del nombre del
 * activo. El orden + contigüidad es lo que distingue una variante real de un
 * falso amigo que solo comparte marca/token:
 *   ✅ "KINDER HUEVO DINO 8P"      ⊇ "kinder huevo" contiguo  → KINDER HUEVO
 *   ✅ "GOMA GUMMY POP /25"        ⊇ "gummy pop"   contiguo  → GUMMY POP
 *   ✅ "CANELS 4S TUTTI-FRUTTI"    ⊇ "canels 4s"   contiguo  → CANELS 4S
 *   ❌ "GUMMY RANITA POP'S NEON"   → gummy y pop NO contiguos (ranita en medio)
 *   ❌ "CHOC HUEVO MASHA Y EL OSO KINDER" → "kinder huevo" no aparece contiguo
 * Conserva tamaños/números (#9, 60gr, ½L) y elige el planograma MÁS específico
 * (frase más larga). Excluye no-productos (JUNK) y promos/bundles (PROMO).
 * Inserta alias source='bootstrap' (revisables/curables). NO toca los canónicos.
 *
 * Determinístico, sin Voyage. Idempotente.
 * Uso (desde database/):  node scripts/bootstrap-planogram-aliases.js [--apply]
 *   sin --apply = dry-run (solo reporta cuántos mapearía).
 */
const knexLib = require('knex');
const k = require('../knexfile-newdb.js').development;
const knex = knexLib(k);
const T = '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');

// No-productos del ERP (servicios/financieros) y promos/bundles (mismas reglas
// que EmbeddingSyncService para mantener un solo criterio de basura).
const JUNK =
  /descuento|comision|administrativo|tiempo aire|\bflete\b|servicio|redondeo|bonific|anticipo|\babono\b|no usar|cancelad/i;
const PROMO = /=\s*gratis|\bgratis\b|\bexh\b|^\s*\d+\s*(cj|cjs|reja|exh|caja|bls|pz|pza|disp)\b/i;

// Tokens ORDENADOS, conservando números y tamaños. Quita prefijo IND/*** y el
// conteo de empaque final "/6" (presentación, no identidad del producto).
function toks(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^[\s*]+/, '')
    .replace(/^ind\s+/, '')
    .replace(/½/g, '12frac')
    .replace(/¼/g, '14frac')
    .replace(/¾/g, '34frac')
    .replace(/\s*\/\s*\d+\s*$/, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 1);
}

// Posición donde `needle` (tokens del planograma) aparece como subsecuencia
// CONTIGUA dentro de `hay` (tokens del activo); -1 si no está.
function findPhrase(needle, hay) {
  if (needle.length > hay.length) return -1;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++)
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

(async () => {
  const planoRows = await knex.raw(
    `SELECT ps.sku, ps.product_id, cp.nombre FROM trade.planogram_skus ps
     JOIN catalog.products cp ON cp.id = ps.product_id
     WHERE ps.tenant_id = ? AND ps.deleted_at IS NULL`,
    [T],
  );
  // >=2 tokens: un planograma de 1 token genérico generaría matches débiles.
  const plano = planoRows.rows
    .map((r) => ({ product_id: r.product_id, t: toks(r.nombre), nombre: r.nombre }))
    .filter((p) => p.t.length >= 2);
  const canonicalSkus = new Set(planoRows.rows.map((r) => r.sku));
  console.log(`planograma: ${plano.length} productos (>=2 tokens).`);

  // in_cat: si el sku está en el catálogo curado, NO aplicar el filtro PROMO
  // (un sku curado es producto legítimo aunque su nombre ERP parezca promo).
  const actRows = await knex.raw(
    `SELECT ia.sku, COALESCE(cp.nombre, ia.nombre) AS name, cp.sku AS in_cat
       FROM inventory.products_active ia
       LEFT JOIN catalog.products cp ON cp.sku = ia.sku AND cp.tenant_id = ? AND cp.deleted_at IS NULL`,
    [T],
  );

  const aliases = [];
  for (const r of actRows.rows) {
    if (!r.sku || canonicalSkus.has(r.sku)) continue; // canónico ya cubierto
    if (JUNK.test(r.name)) continue;
    if (!r.in_cat && PROMO.test(r.name)) continue;
    const at = toks(r.name);
    if (at.length < 2) continue;
    // Planograma más específico (frase más larga) que sea contiguo en el activo.
    let best = null;
    for (const p of plano) {
      if (findPhrase(p.t, at) >= 0 && (!best || p.t.length > best.t.length)) best = p;
    }
    if (best) aliases.push({ erp_sku: r.sku, product_id: best.product_id });
  }
  console.log(`alias bootstrap candidatos: ${aliases.length}`);

  if (!APPLY) {
    console.log('\n(dry-run) usar --apply para insertar.');
    await knex.destroy();
    return;
  }

  let ins = 0;
  for (const a of aliases) {
    const ex = await knex('trade.planogram_sku_aliases')
      .where({ tenant_id: T, erp_sku: a.erp_sku })
      .whereNull('deleted_at')
      .first();
    if (ex) continue; // no pisar canónico/manual
    await knex('trade.planogram_sku_aliases').insert({
      tenant_id: T,
      erp_sku: a.erp_sku,
      product_id: a.product_id,
      source: 'bootstrap',
    });
    ins++;
  }
  const tot = await knex('trade.planogram_sku_aliases').where({ tenant_id: T }).whereNull('deleted_at').count('* as n').first();
  console.log(`\ninsertados ${ins} bootstrap. total alias vivos: ${tot.n}.`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
