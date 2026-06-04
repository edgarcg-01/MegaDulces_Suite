/**
 * Bootstrap de `trade.planogram_sku_aliases`: agrupa productos del set activo
 * ERP (inventory.products_active) a productos del planograma (852) por
 * CONTENCIÓN de tokens de nombre — el nombre activo contiene todos los tokens
 * del nombre del planograma (ej. "CANELS 4S SURTIDO DISPLAY 60P" ⊇ "CANELS 4S").
 * Inserta alias source='bootstrap' (revisables/curables). NO toca los canónicos.
 *
 * Determinístico, conservador (contención total), sin Voyage. Idempotente.
 * Uso (desde database/):  node scripts/bootstrap-planogram-aliases.js [--apply]
 *   sin --apply = dry-run (solo reporta cuántos mapearía).
 */
const knexLib = require('knex');
const k = require('../knexfile-newdb.js').development;
const knex = knexLib(k);
const T = '00000000-0000-0000-0000-00000000d01c';
const APPLY = process.argv.includes('--apply');

const STOP = new Set(['de', 'la', 'el', 'con', 'sin', 'gr', 'ml', 'kg', 'pz', 'pza', 'c', 's']);
function tokens(name) {
  return new Set(
    String(name || '')
      .toLowerCase()
      .replace(/^\s*ind\s+/i, '')
      .split(/[^a-z0-9]+/i)
      .filter((t) => t.length >= 2 && !STOP.has(t)),
  );
}

(async () => {
  // Planograma: producto canónico (catalog) + tokens.
  const planoRows = await knex.raw(
    `SELECT ps.sku, ps.product_id, cp.nombre FROM trade.planogram_skus ps
     JOIN catalog.products cp ON cp.id = ps.product_id
     WHERE ps.tenant_id = ? AND ps.deleted_at IS NULL`,
    [T],
  );
  const plano = planoRows.rows
    .map((r) => ({ sku: r.sku, product_id: r.product_id, toks: tokens(r.nombre), nombre: r.nombre }))
    .filter((p) => p.toks.size > 0);
  const canonicalSkus = new Set(plano.map((p) => p.sku));
  console.log(`planograma: ${plano.length} productos.`);

  // Activos con nombre limpio (preferir catálogo).
  const actRows = await knex.raw(
    `SELECT ia.sku, COALESCE(cp.nombre, ia.nombre) AS name FROM inventory.products_active ia
     LEFT JOIN catalog.products cp ON cp.sku = ia.sku AND cp.tenant_id = ? AND cp.deleted_at IS NULL`,
    [T],
  );

  const aliases = [];
  for (const r of actRows.rows) {
    if (!r.sku || canonicalSkus.has(r.sku)) continue; // canónico ya cubierto
    const at = tokens(r.name);
    if (at.size === 0) continue;
    // Mejor planograma cuyo set de tokens esté TODO contenido en el activo.
    let best = null;
    for (const p of plano) {
      let allIn = true;
      for (const t of p.toks) if (!at.has(t)) { allIn = false; break; }
      if (!allIn) continue;
      if (!best || p.toks.size > best.toks.size) best = p; // el más específico
    }
    if (best && best.toks.size >= 2) {
      aliases.push({ erp_sku: r.sku, product_id: best.product_id, conf: best.toks.size / at.size });
    }
  }
  console.log(`alias bootstrap candidatos: ${aliases.length}`);
  console.log('ejemplos:', aliases.slice(0, 8).map((a) => a.erp_sku + '→' + a.product_id.slice(0, 8)).join(', '));

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
      confidence: Number(a.conf.toFixed(3)),
    });
    ins++;
  }
  const tot = await knex('trade.planogram_sku_aliases').where({ tenant_id: T }).whereNull('deleted_at').count('* as n').first();
  console.log(`\ninsertados ${ins} bootstrap. total alias vivos: ${tot.n}.`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
