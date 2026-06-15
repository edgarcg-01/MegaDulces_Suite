/* eslint-disable no-console */
/**
 * Importer: almacenes Kepler + existencia → inventory.warehouse_stock.
 *
 * Fuente: dump Kepler local (md_03). kdil = existencia por (sucursal, almacén,
 * sku); c1=sucursal, c3=sku, c9=existencia. Crea el warehouse en commercial.
 * warehouses (KEPLER-NN) y carga la existencia por (almacén, sku) en
 * inventory.warehouse_stock — la fuente que la Fase I usa en modo 'inventory'.
 *
 * Destino parametrizable (no hardcodea credenciales de prod):
 *   node database/importers/kepler/import-kepler-warehouse-stock.js \
 *     --branch 03 --warehouse KEPLER-03 [--dst-url <postgres-url>] [--apply]
 *   (sin --dst-url usa el local localhost:5433/postgres_platform)
 *
 * Idempotente: upsert por (tenant, warehouse, sku).
 */

const { Client } = require('pg');

const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
const LOCAL_DST = 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const BRANCH = arg('branch', '03');
const WAREHOUSE = arg('warehouse', `KEPLER-${BRANCH}`);
const DST_URL = arg('dst-url', LOCAL_DST);
const APPLY = process.argv.includes('--apply');
const IS_PROD = DST_URL !== LOCAL_DST;

(async () => {
  const src = new Client({ connectionString: SRC });
  const dst = new Client({ connectionString: DST_URL });
  await src.connect();
  await dst.connect();
  try {
    console.log(`\n=== Almacén Kepler ${BRANCH} → ${WAREHOUSE} en ${IS_PROD ? 'PROD' : 'LOCAL'} (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // tenant (por slug, no hardcode)
    const { rows: tr } = await dst.query(`SELECT id FROM identity.tenants WHERE slug='mega_dulces' LIMIT 1`);
    if (!tr.length) throw new Error('No se encontró el tenant mega_dulces en el destino');
    const tenant = tr[0].id;

    // existencia Kepler de la sucursal
    const { rows: ex } = await src.query(
      `SELECT c3 AS sku, SUM(c9)::numeric AS qty FROM md.kdil WHERE c1=$1 GROUP BY c3`, [BRANCH]);
    const withStock = ex.filter((r) => Number(r.qty) !== 0);
    console.log(`Kepler suc ${BRANCH}: ${ex.length} SKUs (${withStock.length} con existencia != 0)`);

    if (!APPLY) {
      console.log('\n[DRY-RUN] No se escribió. Muestra:');
      withStock.slice(0, 6).forEach((r) => console.log(`  ${r.sku}  ${r.qty}`));
      console.log('\nCorré con --apply para crear el almacén + cargar la existencia.');
      return;
    }

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${tenant}'`);

    // warehouse
    let wh = await dst.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [tenant, WAREHOUSE]);
    let whId;
    if (wh.rows.length) whId = wh.rows[0].id;
    else {
      const ins = await dst.query(
        `INSERT INTO commercial.warehouses (tenant_id, code, name, is_default) VALUES ($1,$2,$3,false) RETURNING id`,
        [tenant, WAREHOUSE, `Kepler sucursal ${BRANCH}`]);
      whId = ins.rows[0].id;
      console.log(`Almacén ${WAREHOUSE} creado.`);
    }

    let n = 0;
    for (const r of ex) {
      await dst.query(
        `INSERT INTO inventory.warehouse_stock (tenant_id, warehouse_id, sku, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, warehouse_id, sku)
         DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now()`,
        [tenant, whId, String(r.sku).trim(), Number(r.qty)]);
      n++;
    }
    await dst.query('COMMIT');
    console.log(`\n[APPLY] ${n} filas en inventory.warehouse_stock (almacén ${WAREHOUSE}).`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('ERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await dst.end();
  }
})();
