/**
 * RA-PRO.12 — Normalización de catalog.categories (dedup por NOMBRE IDÉNTICO).
 *
 * El campo `categoria` de Wincaja está sobrecargado (plaza + proveedor + tipo + estatus) y trae
 * categorías con el MISMO nombre bajo códigos distintos (ej. DISPONIBLE ×38, GOMAS ×2, VASOS ×2).
 * Este script fusiona SOLO los nombres idénticos: conserva la categoría con más productos
 * (desempate = código más bajo), repunta los productos de las demás a esa, y soft-borra las
 * fusionadas. NO toca nombres distintos (Guadalajara ≠ Guadalajara 2).
 *
 * Espejo del endpoint POST /commercial/replenishment/categories/auto-dedup (misma lógica).
 *
 * Uso:
 *   node database/scripts/categories-normalize.js            # DRY-RUN (no cambia nada)
 *   node database/scripts/categories-normalize.js --apply    # aplica (transacción)
 *
 * Conecta a DATABASE_URL_NEW (Railway) desde database/importers/wincaja/sync.local.env.
 */
require('../../node_modules/dotenv').config({ path: __dirname + '/../importers/wincaja/sync.local.env', override: true });
const APPLY = process.argv.includes('--apply');
const url = process.env.DATABASE_URL_NEW || '';
if (!/rlwy\.net|railway/.test(url)) { console.error('ABORT: DATABASE_URL_NEW no apunta a Railway.'); process.exit(1); }
const knex = require('../../node_modules/knex')({ client: 'pg', connection: { connectionString: url, ssl: { rejectUnauthorized: false } }, pool: { min: 1, max: 2 } });
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  console.log(`\n=== Normalización de categorías (${APPLY ? 'APPLY' : 'DRY-RUN'}) · tenant ${T} ===\n`);
  // Grupos de nombre idéntico entre categorías activas.
  const rows = (await knex.raw(`
    WITH cats AS (
      SELECT c.id, c.code, c.name,
             (SELECT count(*) FROM catalog.products p WHERE p.tenant_id=c.tenant_id AND p.category_id=c.id AND p.activo)::int AS np
        FROM catalog.categories c WHERE c.tenant_id=? AND c.deleted_at IS NULL),
    dups AS (SELECT name FROM cats GROUP BY name HAVING count(*) > 1)
    SELECT c.name, c.code, c.id, c.np FROM cats c JOIN dups d ON d.name=c.name
    ORDER BY c.name, c.np DESC, c.code`, [T])).rows;

  const byName = new Map();
  for (const r of rows) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
  if (!byName.size) { console.log('No hay categorías de nombre idéntico. Nada que hacer.'); await knex.destroy(); return; }

  const plan = [];
  for (const [name, cs] of byName) {
    const canonical = cs[0];            // más productos (desempate: código más bajo, por el ORDER BY)
    const rest = cs.slice(1);
    plan.push({ name, canonical, rest, prodMoved: rest.reduce((a, c) => a + c.np, 0) });
  }
  let totCats = 0, totProd = 0;
  for (const g of plan) {
    totCats += g.rest.length; totProd += g.prodMoved;
    console.log(`"${g.name}": conservar code ${g.canonical.code} (${g.canonical.np}p) · fusionar ${g.rest.length} [${g.rest.map((c) => c.code + ':' + c.np + 'p').join(', ')}] · ${g.prodMoved} productos se mueven`);
  }
  console.log(`\nTOTAL: ${plan.length} grupos · ${totCats} categorías a fusionar · ${totProd} productos a repuntar.\n`);

  if (!APPLY) { console.log('DRY-RUN. Corre con --apply para ejecutar.'); await knex.destroy(); return; }

  await knex.transaction(async (trx) => {
    let cats = 0, prod = 0;
    for (const g of plan) {
      const restIds = g.rest.map((c) => c.id);
      if (!restIds.length) continue;
      const rp = await trx('catalog.products').where('tenant_id', T).whereIn('category_id', restIds).update({ category_id: g.canonical.id, updated_at: trx.fn.now() });
      await trx('catalog.categories').where('tenant_id', T).whereIn('id', restIds).update({ deleted_at: trx.fn.now() });
      cats += restIds.length; prod += rp;
    }
    console.log(`[APPLY] Fusionadas ${cats} categorías, repuntados ${prod} productos. COMMIT.`);
  });
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
