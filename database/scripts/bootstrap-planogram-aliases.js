/**
 * Bootstrap de `trade.planogram_sku_aliases`: mapea productos del set activo
 * ERP (inventory.products_active) a productos del planograma (852) SOLO cuando son
 * el MISMO PRODUCTO — nombre completo normalizado idéntico (conservando tamaños y
 * números: #5, 60gr, ½L), quitando únicamente el prefijo "IND " y el conteo de
 * empaque final "/6". Ej: "IND TIC TAC MENTA" == "TIC TAC MENTA". NO usa fuzzy/
 * contención (eso generaba falsos como "GUMMY RANITA POP'S" → "GUMMY POP").
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

// Nombre completo normalizado, CONSERVANDO números y tamaños (#5, 60gr, 5l, ½).
// Solo quita el prefijo "IND " y el conteo de empaque final "/6". Igualdad
// exacta de este string = "producto completamente igual".
function norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/^\s*\*+\s*/, '') // marcadores "***"
    .replace(/^\s*ind\s+/i, '') // prefijo IND
    .replace(/½/g, '12frac')
    .replace(/¼/g, '14frac')
    .replace(/¾/g, '34frac')
    .replace(/\s*\/\s*\d+\s*$/, '') // conteo de empaque final "/6"
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
    .map((r) => ({ sku: r.sku, product_id: r.product_id, key: norm(r.nombre), nombre: r.nombre }))
    .filter((p) => p.key.length > 0);
  const canonicalSkus = new Set(plano.map((p) => p.sku));
  console.log(`planograma: ${plano.length} productos.`);

  // Activos con nombre limpio (preferir catálogo).
  const actRows = await knex.raw(
    `SELECT ia.sku, COALESCE(cp.nombre, ia.nombre) AS name FROM inventory.products_active ia
     LEFT JOIN catalog.products cp ON cp.sku = ia.sku AND cp.tenant_id = ? AND cp.deleted_at IS NULL`,
    [T],
  );

  // Índice del planograma por nombre normalizado. Si dos productos del planograma
  // normalizan igual, es ambiguo → se descarta esa clave (no adivinamos).
  const planoByKey = new Map();
  const ambiguous = new Set();
  for (const p of plano) {
    if (planoByKey.has(p.key) && planoByKey.get(p.key).product_id !== p.product_id) ambiguous.add(p.key);
    else planoByKey.set(p.key, p);
  }
  for (const k of ambiguous) planoByKey.delete(k);

  const aliases = [];
  for (const r of actRows.rows) {
    if (!r.sku || canonicalSkus.has(r.sku)) continue; // canónico ya cubierto
    const key = norm(r.name);
    if (!key) continue;
    // SOLO producto completamente igual: nombre normalizado idéntico al del planograma.
    const p = planoByKey.get(key);
    if (p) aliases.push({ erp_sku: r.sku, product_id: p.product_id, conf: 1 });
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
