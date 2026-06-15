/* eslint-disable no-console */
/**
 * Limpieza de datos inventados (testdata/seed/smoke) — deja solo data real.
 *
 * Decidido con Edgar (2026-06-15):
 *   - Conservar: catálogo real, clientes reales, listas de precio reales,
 *     almacenes MD-10/30/50/CEDIS (reales) y KEPLER-03 (importado del ERP).
 *   - Borrar: marcas/productos testdata (B.3.2), clientes TST-/DEMO-, TODOS
 *     los pedidos dev (PD-*), folios de inventario smoke, almacenes
 *     INV-TEST-WH y TRUCK-*, y el stock seed de MD-CENTRAL (se conserva el
 *     almacén como default, vacío).
 *
 * Patrón dry-run: corre los DELETE dentro de una transacción e imprime los
 * conteos; hace ROLLBACK salvo que se pase --apply (entonces COMMIT).
 *
 *   node database/scripts/cleanup-invented-data.js           # dry-run (rollback)
 *   node database/scripts/cleanup-invented-data.js --apply   # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const TESTDATA_BRANDS = [
  'Chocolates Premium', 'Dulces Típicos MX', 'Chicles & Gomitas',
  'Paletas y Helados', 'Galletas y Snacks',
];

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  const steps = [];
  const del = async (label, sql, params) => {
    const r = await db.query(sql, params);
    steps.push({ label, rows: r.rowCount });
    console.log(`  ${String(r.rowCount).padStart(6)}  ${label}`);
  };

  try {
    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    console.log(`\n=== Limpieza datos inventados (${APPLY ? 'APPLY' : 'DRY-RUN → rollback'}) ===\n`);

    // ── Resolver conjuntos ──
    const tProd = await db.query(
      `SELECT p.id FROM catalog.products p JOIN catalog.brands b ON b.id=p.brand_id
        WHERE p.tenant_id=$1 AND b.nombre = ANY($2)`, [M, TESTDATA_BRANDS]);
    const testProductIds = tProd.rows.map((r) => r.id);
    const tCust = await db.query(
      `SELECT id FROM commercial.customers WHERE tenant_id=$1 AND (code LIKE 'TST-%' OR code LIKE 'DEMO%')`, [M]);
    const testCustomerIds = tCust.rows.map((r) => r.id);
    const tWh = await db.query(
      `SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1 AND (code='INV-TEST-WH' OR code LIKE 'TRUCK-%')`, [M]);
    const junkWhIds = tWh.rows.map((r) => r.id);
    const mdCentral = await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code='MD-CENTRAL'`, [M]);
    const mdCentralId = mdCentral.rows[0]?.id || null;

    console.log(`Conjuntos: productos testdata=${testProductIds.length}, clientes TST/DEMO=${testCustomerIds.length}, almacenes basura=${junkWhIds.length}\n`);

    console.log('Pedidos dev (TODOS):');
    // logistics.shipments tiene FK compuesta (tenant_id, order_id) ON DELETE SET NULL
    // — el SET NULL anularía tenant_id (NOT NULL) → error. Desligamos manualmente
    // solo order_id (el embarque se conserva; decisión sobre logística aparte).
    await del('shipments.order_id → NULL (desligar)', `UPDATE logistics.shipments SET order_id=NULL WHERE tenant_id=$1 AND order_id IS NOT NULL`, [M]);
    await del('payments', `DELETE FROM commercial.payments WHERE tenant_id=$1`, [M]);
    await del('order_status_history', `DELETE FROM commercial.order_status_history WHERE tenant_id=$1`, [M]);
    await del('order_lines', `DELETE FROM commercial.order_lines WHERE tenant_id=$1`, [M]);
    await del('orders', `DELETE FROM commercial.orders WHERE tenant_id=$1`, [M]);

    console.log('Inventario smoke (folios + items cascade):');
    await del('inventory_counts (+items cascade)', `DELETE FROM commercial.inventory_counts WHERE tenant_id=$1`, [M]);

    console.log('Clientes testdata (TST/DEMO) + sus referencias:');
    await del('users.customer_id → NULL', `UPDATE public.users SET customer_id=NULL WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('recommended_baskets', `DELETE FROM commercial.recommended_baskets WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('customer_360', `DELETE FROM commercial.customer_360 WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('commerce_signals', `DELETE FROM commercial.commerce_signals WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('vendor_visits', `DELETE FROM commercial.vendor_visits WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('lead_reservations', `DELETE FROM commercial.lead_reservations WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('call_logs', `DELETE FROM commercial.call_logs WHERE customer_id = ANY($1)`, [testCustomerIds]);
    await del('customers (TST/DEMO)', `DELETE FROM commercial.customers WHERE id = ANY($1)`, [testCustomerIds]);

    console.log('Productos/marcas testdata:');
    await del('stock_movements (prod testdata)', `DELETE FROM commercial.stock_movements WHERE product_id = ANY($1)`, [testProductIds]);
    await del('stock (prod testdata)', `DELETE FROM commercial.stock WHERE product_id = ANY($1)`, [testProductIds]);
    await del('product_prices (prod testdata)', `DELETE FROM commercial.product_prices WHERE product_id = ANY($1)`, [testProductIds]);
    await del('vendor_sale_lines (prod testdata)', `DELETE FROM commercial.vendor_sale_lines WHERE product_id = ANY($1)`, [testProductIds]);
    await del('products (testdata)', `DELETE FROM catalog.products WHERE id = ANY($1)`, [testProductIds]);
    await del('brands (testdata)', `DELETE FROM catalog.brands WHERE tenant_id=$1 AND nombre = ANY($2)`, [M, TESTDATA_BRANDS]);

    console.log('Almacenes basura (INV-TEST-WH, TRUCK-*):');
    await del('stock_movements (wh basura)', `DELETE FROM commercial.stock_movements WHERE warehouse_id = ANY($1)`, [junkWhIds]);
    await del('stock (wh basura)', `DELETE FROM commercial.stock WHERE warehouse_id = ANY($1)`, [junkWhIds]);
    await del('warehouses (basura)', `DELETE FROM commercial.warehouses WHERE id = ANY($1)`, [junkWhIds]);

    console.log('Stock seed de MD-CENTRAL (se conserva el almacén, vacío):');
    if (mdCentralId) {
      await del('stock_movements (MD-CENTRAL)', `DELETE FROM commercial.stock_movements WHERE warehouse_id=$1`, [mdCentralId]);
      await del('stock (MD-CENTRAL)', `DELETE FROM commercial.stock WHERE warehouse_id=$1`, [mdCentralId]);
    }

    const total = steps.reduce((s, x) => s + x.rows, 0);
    console.log(`\nTotal filas afectadas: ${total}`);

    if (APPLY) {
      await db.query('COMMIT');
      console.log('\n[APPLY] COMMIT — datos inventados eliminados.');
    } else {
      await db.query('ROLLBACK');
      console.log('\n[DRY-RUN] ROLLBACK — no se borró nada. Corré con --apply para confirmar.');
    }
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
