/* eslint-disable no-console */
/**
 * Genera un SQL bulk (un solo statement con VALUES + upsert) para cargar la
 * existencia Kepler de una sucursal en inventory.warehouse_stock. Mucho más
 * rápido que insertar fila por fila sobre la red.
 *
 *   node database/scripts/gen-kepler-stock-sql.js --branch 03 --warehouse KEPLER-03 > out.sql
 *
 * El SQL resuelve tenant + warehouse por subquery (no hardcodea ids) y crea el
 * almacén si no existe. Idempotente (ON CONFLICT upsert).
 */
const { Client } = require('pg');

const SRC = 'postgresql://postgres:superoot@localhost:5433/md_03';
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const BRANCH = arg('branch', '03');
const WAREHOUSE = arg('warehouse', `KEPLER-${BRANCH}`);

(async () => {
  const src = new Client({ connectionString: SRC });
  await src.connect();
  try {
    const { rows } = await src.query(
      `SELECT c3 AS sku, SUM(c9)::numeric AS qty FROM md.kdil WHERE c1=$1 GROUP BY c3`, [BRANCH]);

    const esc = (s) => String(s).replace(/'/g, "''").trim();
    const values = rows
      .map((r) => `('${esc(r.sku)}',${Number(r.qty)})`)
      .join(',\n');

    const sql = `BEGIN;
INSERT INTO commercial.warehouses (tenant_id, code, name, is_default)
SELECT t.id, '${WAREHOUSE}', 'Kepler sucursal ${BRANCH}', false
FROM identity.tenants t WHERE t.slug='mega_dulces'
ON CONFLICT (tenant_id, code) DO NOTHING;

WITH t AS (SELECT id FROM identity.tenants WHERE slug='mega_dulces' LIMIT 1),
wh AS (
  SELECT w.id FROM commercial.warehouses w, t WHERE w.tenant_id=t.id AND w.code='${WAREHOUSE}' LIMIT 1
),
data(sku, qty) AS (VALUES
${values}
)
INSERT INTO inventory.warehouse_stock (tenant_id, warehouse_id, sku, quantity)
SELECT t.id, wh.id, data.sku, data.qty
FROM data CROSS JOIN t CROSS JOIN wh
ON CONFLICT (tenant_id, warehouse_id, sku)
DO UPDATE SET quantity=EXCLUDED.quantity, updated_at=now();
SELECT '${WAREHOUSE}' AS warehouse, count(*) AS filas FROM inventory.warehouse_stock ws
  JOIN commercial.warehouses w ON w.id=ws.warehouse_id AND w.code='${WAREHOUSE}';
COMMIT;
`;
    process.stdout.write(sql);
    console.error(`[gen] ${WAREHOUSE}: ${rows.length} filas`);
  } finally {
    await src.end();
  }
})();
