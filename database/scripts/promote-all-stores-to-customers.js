/* eslint-disable no-console */
/**
 * Promueve TODAS las tiendas activas (trade) a clientes comerciales
 * (commercial.customers), una a una, replicando la lógica idempotente de
 * CommercialCustomersService.createFromStore (J.6.2):
 *
 *   - code default: STR-{primeros 8 hex del UUID del store, upper}
 *   - name: store.nombre
 *   - default_price_list_id: la lista marcada is_default=true del tenant
 *   - credit_limit 0, payment_terms_days 0 (cash-only beta)
 *
 * Idempotente: salta las tiendas que YA tienen un customer apuntándolas
 * (store_id) → re-correr no duplica. NO toca customers existentes.
 *
 * Requiere que exista una price_list default (is_default=true, active) en el
 * tenant; si no, aborta sin escribir nada.
 *
 * Uso:
 *   DRY (default):  node database/scripts/promote-all-stores-to-customers.js
 *   APLICAR:        node database/scripts/promote-all-stores-to-customers.js --apply
 *   prod:           TARGET_DB_URL="postgres://..." node ... --apply
 */
const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const APPLY = process.argv.includes('--apply');

const conn = process.env.TARGET_DB_URL
  ? { client: 'pg', connection: { connectionString: process.env.TARGET_DB_URL, ssl: { rejectUnauthorized: false } } }
  : require('../knexfile-newdb.js').development;
const knex = require('knex')(conn);

const codeForStore = (storeId) => `STR-${storeId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

(async () => {
  const target = process.env.TARGET_DB_URL ? 'PROD' : 'local';

  // 1. price_list default del tenant — sin esto no se puede promover (igual que createFromStore).
  const defaultPl = await knex('commercial.price_lists')
    .where({ tenant_id: T, is_default: true, active: true })
    .whereNull('deleted_at')
    .first('id', 'code');
  if (!defaultPl) {
    console.error(`✗ No hay price_list default (is_default=true, active) en el tenant ${T}.`);
    console.error('  Crear una en /comercial/pricing antes de promover. Abortado (sin escribir).');
    await knex.destroy();
    process.exit(1);
  }

  // 2. Tiendas activas + customers existentes con store_id (para saltar las ya promovidas).
  const stores = await knex('stores')
    .where({ tenant_id: T, activo: true })
    .whereNull('deleted_at')
    .select('id', 'nombre');
  const linkedStoreIds = new Set(
    (await knex('commercial.customers')
      .where({ tenant_id: T })
      .whereNull('deleted_at')
      .whereNotNull('store_id')
      .select('store_id')
    ).map((r) => r.store_id),
  );
  // codes ya tomados (cualquier customer, incl. soft-deleted: el code es único por tenant).
  const takenCodes = new Set(
    (await knex('commercial.customers').where({ tenant_id: T }).select('code')).map((r) => r.code),
  );

  const plan = [];
  const skippedCodeClash = [];
  for (const s of stores) {
    if (linkedStoreIds.has(s.id)) continue; // ya tiene customer
    const code = codeForStore(s.id);
    if (takenCodes.has(code)) { skippedCodeClash.push({ ...s, code }); continue; }
    plan.push({ storeId: s.id, storeName: s.nombre, code });
  }

  console.log(`tenant=${T} target=${target}${APPLY ? '' : ' [DRY — usar --apply para escribir]'}`);
  console.log(`price_list default: ${defaultPl.code}`);
  console.log(`tiendas activas=${stores.length} | ya son cliente=${linkedStoreIds.size} | a crear ahora=${plan.length} | code colisiona=${skippedCodeClash.length}`);
  console.log('ejemplos:', plan.slice(0, 8).map((p) => `[${p.code}] ${p.storeName}`).join('  ·  ') || '(ninguna)');
  if (skippedCodeClash.length) {
    console.log('⚠ saltadas por colisión de code (revisar a mano):', skippedCodeClash.slice(0, 8).map((p) => `[${p.code}] ${p.storeName}`).join('  ·  '));
  }

  if (!APPLY) { await knex.destroy(); return; }

  let created = 0;
  const errors = [];
  for (const p of plan) {
    try {
      await knex('commercial.customers').insert({
        tenant_id: T,
        code: p.code,
        name: (p.storeName || `Tienda ${p.code}`).trim(),
        store_id: p.storeId,
        default_price_list_id: defaultPl.id,
        credit_limit: 0,
        payment_terms_days: 0, // cash-only beta
        active: true,
        notes: `Customer auto-generado desde store "${p.storeName || p.storeId}" via promote-all-stores-to-customers.`,
      });
      created++;
    } catch (e) {
      errors.push({ store: p.storeName, code: p.code, err: e.message });
    }
  }

  const total = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('store_id').count('* as n').first();
  console.log(`\ncreados ahora: ${created} | total customers con store_id: ${total.n}`);
  if (errors.length) {
    console.log(`✗ ${errors.length} errores:`);
    for (const e of errors.slice(0, 12)) console.log(`  [${e.code}] ${e.store}: ${e.err}`);
  }
  await knex.destroy();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
