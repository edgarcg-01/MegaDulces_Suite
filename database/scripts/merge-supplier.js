/* eslint-disable no-console */
/**
 * Merge de proveedores duplicados en catalog.suppliers (repoint de FKs + soft-delete del dup).
 * El importer import-kepler-suppliers respeta el guard `deleted_at IS NULL` → NO vuelve a re-enganchar
 * al fusionado (no se recrea el dup). Transaccional, reversible (soft-delete). Dry-run por default.
 *
 * Uso (desde database/):
 *   DATABASE_URL_NEW=<prod> node scripts/merge-supplier.js --dup 285 --canon CD015          # dry-run
 *   DATABASE_URL_NEW=<prod> node scripts/merge-supplier.js --dup 285 --canon CD015 --apply
 *
 * FKs a catalog.suppliers.id que se repuntan: catalog.products, commercial.purchase_requisitions,
 * commercial.purchase_orders, commercial.replenishment_channel, finance.payment_program.
 * replenishment_channel tiene UNIQUE (tenant,warehouse,supplier) → se borran los canales del dup
 * donde el canónico YA cubre ese warehouse (redundantes).
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const { Client } = require('pg');

const M = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const DUP = arg('dup'); const CANON = arg('canon'); const APPLY = process.argv.includes('--apply');

(async () => {
  if (!DUP || !CANON) { console.error('Falta --dup CODE --canon CODE'); process.exit(1); }
  const db = new Client({ connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW || '') ? false : { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`select set_config('app.tenant_id',$1,false)`, [M]);

  const one = async (code) => (await db.query(`SELECT id, name, (SELECT count(*) FROM catalog.products p WHERE p.tenant_id=$1 AND p.supplier_id=s.id AND p.deleted_at IS NULL) prods FROM catalog.suppliers s WHERE s.tenant_id=$1 AND s.code=$2 AND s.deleted_at IS NULL`, [M, code])).rows[0];
  const d = await one(DUP); const c = await one(CANON);
  if (!d) { console.error(`dup code ${DUP} no encontrado (o ya fusionado)`); process.exit(1); }
  if (!c) { console.error(`canon code ${CANON} no encontrado`); process.exit(1); }
  console.log(`\n=== MERGE ${DUP} "${d.name}" (${d.prods} prods) → ${CANON} "${c.name}" (${c.prods} prods) [${APPLY ? 'APPLY' : 'DRY-RUN'}] ===`);

  const tables = [
    ['catalog.products', 'supplier_id'],
    ['commercial.purchase_requisitions', 'supplier_id'],
    ['commercial.purchase_orders', 'supplier_id'],
    ['finance.payment_program', 'supplier_id'],
  ];
  const counts = {};
  for (const [t, col] of tables) {
    try { counts[t] = Number((await db.query(`SELECT count(*) n FROM ${t} WHERE tenant_id=$1 AND ${col}=$2`, [M, d.id])).rows[0].n); }
    catch (e) { counts[t] = `ERR ${e.message}`; }
  }
  const chDup = Number((await db.query(`SELECT count(*) n FROM commercial.replenishment_channel WHERE tenant_id=$1 AND supplier_id=$2`, [M, d.id])).rows[0].n);
  console.log('  a repuntar:', JSON.stringify(counts), '· replenishment_channel dup:', chDup);

  if (!APPLY) { console.log('\n[DRY-RUN] usar --apply para ejecutar.'); await db.end(); return; }

  await db.query('BEGIN');
  try {
    // replenishment_channel: borra canales del dup donde el canónico ya cubre ese warehouse; repunta el resto
    await db.query(`DELETE FROM commercial.replenishment_channel dd WHERE dd.tenant_id=$1 AND dd.supplier_id=$2 AND EXISTS (SELECT 1 FROM commercial.replenishment_channel cc WHERE cc.tenant_id=$1 AND cc.supplier_id=$3 AND cc.warehouse_id=dd.warehouse_id)`, [M, d.id, c.id]);
    await db.query(`UPDATE commercial.replenishment_channel SET supplier_id=$3 WHERE tenant_id=$1 AND supplier_id=$2`, [M, d.id, c.id]);
    for (const [t, col] of tables) {
      const stamp = (t === 'catalog.products') ? ', updated_at=now()' : '';
      await db.query(`UPDATE ${t} SET ${col}=$3${stamp} WHERE tenant_id=$1 AND ${col}=$2`, [M, d.id, c.id]);
    }
    const sd = (await db.query(`UPDATE catalog.suppliers SET deleted_at=now(), updated_at=now() WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL`, [M, d.id])).rowCount;
    await db.query('COMMIT');
    console.log(`\n[APPLY] MERGE OK. Repunteos: ${JSON.stringify(counts)} · dup soft-deleted: ${sd}`);
  } catch (e) { await db.query('ROLLBACK'); console.error('\nROLLBACK:', e.message); process.exitCode = 1; }
  await db.end();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
