/* eslint-disable no-console */
/**
 * Consolidación de PROVEEDORES duplicados (catalog.suppliers), espejo de
 * brands-normalize.js pero más simple: los FK a suppliers son ON DELETE SET NULL
 * (sin cascade/restrict), no hay merge de productos por nombre, y el remap es un
 * UPDATE directo de supplier_id (columna sin unique).
 *
 * Agrupa por clave AGRESIVA (quita puntuación + sufijos de razón social y compara
 * por núcleo EXACTO → NO mezcla empresas que comparten palabras). O por --map curado.
 * Canónico = el que tenga más productos (desempate: con lead_time/min_boxes, uppercase,
 * más viejo). Copia lead_time_days/min_order_boxes del no-canónico si el canónico no los
 * tiene (no perder captura manual). Remapea products/purchase_orders/purchase_requisitions
 * y SOFT-DELETE del no-canónico (reversible).
 *
 *   DATABASE_URL=… node database/scripts/suppliers-normalize.js --aggressive           # dry-run
 *   DATABASE_URL=… node database/scripts/suppliers-normalize.js --aggressive --execute
 *   DATABASE_URL=… node database/scripts/suppliers-normalize.js --map <json> --execute
 */
const knex = require('knex');
const fs = require('fs');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const EXECUTE = process.argv.includes('--execute');
const AGGRESSIVE = process.argv.includes('--aggressive');
const MAP_PATH = (() => { const i = process.argv.indexOf('--map'); return i >= 0 ? process.argv[i + 1] : null; })();
const M = '00000000-0000-0000-0000-00000000d01c';
const db = knex({ client: 'pg', connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }, pool: { min: 1, max: 4 } });

const LEGAL = new Set(['sa', 's', 'a', 'de', 'cv', 'c', 'v', 'rl', 'r', 'l', 'sc', 'sapi', 'p', 'i', 'sab', 'sofom', 'enr', 'sad', 'dc', 'mx', 'mexico']);
const strict = (s) => (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['`´¨]/g, '').replace(/\s+/g, ' ').trim();
function bkey(s) {
  let x = (s || '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[.,*'`´¨\-\/&()]/g, ' ').replace(/\s+/g, ' ').trim();
  const w = x.split(' ').filter(Boolean);
  while (w.length > 1 && LEGAL.has(w[w.length - 1])) w.pop();
  return w.join(' ');
}
const key = (s) => (AGGRESSIVE ? bkey(s) : strict(s));

function pickCanonical(arr) {
  return [...arr].sort((a, b) => {
    if ((b.pc || 0) !== (a.pc || 0)) return (b.pc || 0) - (a.pc || 0);           // más productos
    const ap = (a.lead_time_days != null || a.min_order_boxes != null) ? 1 : 0;
    const bp = (b.lead_time_days != null || b.min_order_boxes != null) ? 1 : 0;
    if (bp !== ap) return bp - ap;                                                // con params de compra
    const au = a.name === (a.name || '').toUpperCase() ? 1 : 0, bu = b.name === (b.name || '').toUpperCase() ? 1 : 0;
    if (bu !== au) return bu - au;                                                // uppercase
    return new Date(a.created_at) - new Date(b.created_at);                       // más viejo
  })[0];
}

(async () => {
  console.log(`▶ ${EXECUTE ? '🔥 EXECUTE' : '🧪 DRY-RUN'} · ${MAP_PATH ? 'MAP' : AGGRESSIVE ? 'AGGRESSIVE' : 'STRICT'} · target ${DATABASE_URL.split('@')[1]}`);
  const sups = await db('catalog.suppliers').where({ tenant_id: M }).whereNull('deleted_at').select('*');
  const pc = await db.raw(`SELECT supplier_id, count(*) n FROM catalog.products WHERE tenant_id=? AND deleted_at IS NULL GROUP BY 1`, [M]);
  const cnt = new Map(pc.rows.map((r) => [r.supplier_id, +r.n]));
  for (const s of sups) s.pc = cnt.get(s.id) || 0;

  let plan = [];
  if (MAP_PATH) {
    const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    const byName = new Map(sups.map((s) => [s.name.trim(), s]));
    const byCanon = new Map(); const miss = [];
    for (const [src, can] of Object.entries(raw)) {
      const ss = byName.get(src.trim()), cs = byName.get(can.trim());
      if (!ss) { miss.push(`origen: "${src}"`); continue; }
      if (!cs) { miss.push(`canónica: "${can}"`); continue; }
      if (ss.id === cs.id) continue;
      if (!byCanon.has(cs.id)) byCanon.set(cs.id, { canonical: cs, non: [] });
      byCanon.get(cs.id).non.push(ss);
    }
    if (miss.length) { console.log('⚠️ no resueltos:'); miss.forEach((m) => console.log('   ' + m)); }
    plan = [...byCanon.values()];
  } else {
    const g = new Map();
    for (const s of sups) { const k = key(s.name); if (!k) continue; (g.get(k) || g.set(k, []).get(k)).push(s); }
    for (const arr of g.values()) {
      if (arr.length < 2) continue;
      const canonical = pickCanonical(arr);
      plan.push({ canonical, non: arr.filter((x) => x.id !== canonical.id) });
    }
  }
  if (!plan.length) { console.log('✓ Sin duplicados.'); await db.destroy(); return; }

  let sumDel = 0, sumProd = 0;
  for (const g of plan) {
    console.log(`◆ "${g.canonical.name}" (${g.canonical.pc}p)`);
    for (const n of g.non) { console.log(`    ← "${n.name}" (${n.pc}p)`); sumDel++; sumProd += n.pc; }
  }
  console.log(`\nTotal: ${plan.length} grupos · ${sumDel} proveedores a soft-delete · ${sumProd} productos a reasignar`);
  if (!EXECUTE) { console.log('\n(dry-run) --execute para aplicar.'); await db.destroy(); return; }

  await db.transaction(async (trx) => {
    let prods = 0, pos = 0, reqs = 0, params = 0, del = 0;
    for (const g of plan) {
      const canonId = g.canonical.id;
      for (const n of g.non) {
        // copiar params de compra al canónico si le faltan (lead/min + RA-PRO.10 cadencia/colchón/min$)
        const patch = {};
        for (const col of ['lead_time_days', 'min_order_boxes', 'cadence_days_override', 'colchon_days', 'min_order_amount']) {
          if (g.canonical[col] == null && n[col] != null) patch[col] = n[col];
        }
        if (Object.keys(patch).length) {
          await trx('catalog.suppliers').where({ id: canonId }).update(patch); params++;
          for (const col of Object.keys(patch)) g.canonical[col] = g.canonical[col] ?? patch[col];
        }
        prods += await trx('catalog.products').where({ tenant_id: M, supplier_id: n.id }).update({ supplier_id: canonId });
        pos += await trx('commercial.purchase_orders').where({ tenant_id: M, supplier_id: n.id }).update({ supplier_id: canonId });
        reqs += await trx('commercial.purchase_requisitions').where({ tenant_id: M, supplier_id: n.id }).update({ supplier_id: canonId });
        del += await trx('catalog.suppliers').where({ id: n.id }).whereNull('deleted_at').update({ deleted_at: trx.fn.now() });
      }
    }
    console.log(`✓ ${prods} productos, ${pos} OC, ${reqs} requisiciones reasignadas · ${params} params copiados · ${del} proveedores soft-deleted`);
  });
  await db.destroy();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
