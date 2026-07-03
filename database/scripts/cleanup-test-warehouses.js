/* eslint-disable no-console */
/**
 * Limpieza one-off: soft-delete de warehouses efímeros creados por smoke tests
 * que quedaron ACTIVOS (la mayoría ya se auto-borran en teardown) y purga de las
 * filas huérfanas que dejaron en analytics.inventory_health.
 *
 * Contexto: analytics de stock (dead-stock, low-stock, inventory-health) ahora
 * filtran `deleted_at IS NULL`. Esto elimina el residuo activo + limpia la MV.
 *
 * NO hard-delete: estos warehouses tienen FKs reales (orders/movements/lots).
 * Solo soft-delete (deleted_at=now()), 100% reversible.
 *
 *   node database/scripts/cleanup-test-warehouses.js           # dry-run
 *   node database/scripts/cleanup-test-warehouses.js --apply   # commit
 */
const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
// Prefijos de code usados SOLO por tests (conteo, cíclico, equipos, caducidad).
const TEST_WH_RX = '^(INV|INVCNT|INVCYC|TEAMWH|EXPALERT|SOLDEXP)-';

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Cleanup warehouses de test (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const { rows: victims } = await db.query(
      `SELECT id, code, name FROM commercial.warehouses
        WHERE tenant_id=$1 AND code ~ $2 AND deleted_at IS NULL
        ORDER BY code`, [M, TEST_WH_RX]);
    console.log(`Warehouses de test aún activos: ${victims.length}`);
    console.table(victims.map((v) => ({ code: v.code, name: v.name })));

    const [{ n: healthJunk }] = (await db.query(
      `SELECT COUNT(*)::int n FROM analytics.inventory_health h
        WHERE h.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM commercial.warehouses w
           WHERE w.id=h.warehouse_id AND (w.deleted_at IS NOT NULL OR w.code ~ $2))`, [M, TEST_WH_RX])).rows;
    console.log(`Filas huérfanas en analytics.inventory_health a purgar: ${healthJunk}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió. Corré con --apply para commitear.'); return; }

    await db.query('BEGIN');
    const upd = await db.query(
      `UPDATE commercial.warehouses SET deleted_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND code ~ $2 AND deleted_at IS NULL`, [M, TEST_WH_RX]);
    const del = await db.query(
      `DELETE FROM analytics.inventory_health h
        WHERE h.tenant_id=$1 AND EXISTS (
          SELECT 1 FROM commercial.warehouses w
           WHERE w.id=h.warehouse_id AND (w.deleted_at IS NOT NULL OR w.code ~ $2))`, [M, TEST_WH_RX]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${upd.rowCount} warehouses soft-deleted, ${del.rowCount} filas inventory_health purgadas.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
