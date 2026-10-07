/* eslint-disable no-console */
/**
 * Combina clientes ↔ tiendas: setea commercial.customers.store_id apuntando a la
 * trade.store que corresponde, por match de NOMBRE normalizado (no hay código
 * común). Para nombres repetidos (homónimos) linkea al PRIMER cliente disponible
 * (decisión del usuario). NO crea clientes para tiendas sin match.
 *
 * Idempotente: salta tiendas YA combinadas (algún customer ya las apunta) y solo
 * setea store_id donde está NULL → re-correr no duplica ni re-linkea.
 *
 * Uso:
 *   local: node database/scripts/link-customers-to-stores.js
 *   prod : TARGET_DB_URL="postgres://..." node database/scripts/link-customers-to-stores.js
 *   --dry para simular.
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const DRY = process.argv.includes('--dry');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const conn = process.env.TARGET_DB_URL
  ? { client: 'pg', connection: { connectionString: process.env.TARGET_DB_URL, ssl: { rejectUnauthorized: false } } }
  : require('../knexfile-newdb.js').development;
const knex = require('knex')(conn);

(async () => {
  const customers = await knex('commercial.customers').where({ tenant_id: T }).whereNull('deleted_at').select('id', 'code', 'name', 'store_id');
  const stores = await knex('stores').where({ tenant_id: T }).whereNull('deleted_at').select('id', 'nombre');

  // tiendas ya combinadas (algún customer las apunta) → no re-tocar
  const alreadyLinkedStore = new Set(customers.filter((c) => c.store_id).map((c) => c.store_id));
  // customers libres por nombre normalizado, ordenados por code (determinístico)
  const byName = new Map();
  for (const c of customers) {
    if (c.store_id) continue; // ya tiene tienda
    const k = norm(c.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  for (const arr of byName.values()) arr.sort((a, b) => String(a.code).localeCompare(String(b.code)));

  const used = new Set();
  const plan = [];
  for (const s of [...stores].sort((a, b) => a.id.localeCompare(b.id))) {
    if (alreadyLinkedStore.has(s.id)) continue;
    const cands = byName.get(norm(s.nombre));
    if (!cands) continue;
    const pick = cands.find((c) => !used.has(c.id));
    if (!pick) continue;
    used.add(pick.id);
    plan.push({ customerId: pick.id, code: pick.code, customerName: pick.name, storeId: s.id, storeName: s.nombre });
  }

  console.log(`tiendas=${stores.length} | ya combinadas=${alreadyLinkedStore.size} | a combinar ahora=${plan.length}  target=${process.env.TARGET_DB_URL ? 'PROD' : 'local'}${DRY ? ' [DRY]' : ''}`);
  console.log('ejemplos:', plan.slice(0, 6).map((p) => `[${p.code}] ${p.customerName} → ${p.storeName}`).join('  ·  '));

  if (DRY) { await knex.destroy(); return; }

  let linked = 0;
  for (const p of plan) {
    const n = await knex('commercial.customers').where({ id: p.customerId }).whereNull('store_id').update({ store_id: p.storeId, updated_at: knex.fn.now() });
    linked += n;
  }
  const total = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('store_id').count('* as n').first();
  console.log(`combinados ahora: ${linked} | total customers con store_id: ${total.n}`);
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
