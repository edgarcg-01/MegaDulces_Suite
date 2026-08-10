/* eslint-disable no-console */
/**
 * Registro de handlers de APPLY por feed — ÚNICA fuente de verdad del SQL de escritura.
 *
 * Lo usan dos consumidores:
 *   - modo pg  : el importer on-prem lo llama con su propio Client ya conectado a Railway
 *                (comportamiento histórico, escribe por el proxy público).
 *   - modo http: el servicio `services/feeds-ingest` lo llama con un Client interno
 *                (`*.railway.internal`), tras recibir el changeset por HTTPS (ingress gratis).
 *
 * Contrato de un handler: async (client, tenantId, rows, meta) → rowCount.
 *   - Maneja su PROPIA transacción (BEGIN/COMMIT/ROLLBACK).
 *   - `rows` son objetos JSON (mismos que se serializan en el POST).
 *   - NO asume nada del transporte: idéntico resultado en pg y http.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 1000;

function assertTenant(tenantId) {
  if (!UUID_RE.test(String(tenantId || ''))) throw new Error(`tenant_id inválido: ${tenantId}`);
}

/**
 * feed 'stock-delta' — existencia viva multi-sucursal → commercial.stock.
 * rows: [{ code, product_id, quantity }]  (ya agregadas y únicas por (code, product_id);
 *        una fila con quantity=0 es un "drop" = poner en 0).
 * SQL idéntico al histórico de import-branch-stock-live.js (JOIN warehouses por code,
 * JOIN products para no violar FK con drops de productos borrados, GREATEST vs reserved).
 */
async function applyStockDelta(client, tenantId, rows) {
  assertTenant(tenantId);
  if (!Array.isArray(rows) || !rows.length) return 0;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    await client.query(`CREATE TEMP TABLE stg_stock (code text, product_id uuid, quantity numeric) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((r, ri) => {
        vals.push(`($${ri * 3 + 1},$${ri * 3 + 2},$${ri * 3 + 3})`);
        params.push(r.code, r.product_id, r.quantity);
      });
      await client.query(`INSERT INTO stg_stock (code, product_id, quantity) VALUES ${vals.join(',')}`, params);
    }
    const up = await client.query(`
      INSERT INTO commercial.stock (id, tenant_id, warehouse_id, product_id, quantity, updated_at)
      SELECT gen_random_uuid(), $1, w.id, s.product_id, s.quantity, now()
      FROM stg_stock s
      JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.code=s.code
      JOIN public.products p ON p.tenant_id=$1 AND p.id=s.product_id
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET quantity=GREATEST(EXCLUDED.quantity, commercial.stock.reserved_quantity), updated_at=now()`, [tenantId]);
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * feed 'wincaja-stock' — existencia viva de una sucursal Wincaja → commercial.stock.
 * meta: { warehouse_code }  (destino en commercial.warehouses.code, p.ej. '00' CEDIS, 'MD-30'…).
 * rows: [{ sku, existencia }]  — DELTA incremental (solo SKUs cuya existencia cambió; un 0
 *        es "poner en 0"). NO es snapshot completo → por eso NO hay delete-not-seen (borraría
 *        el resto del almacén). El agente lleva su watermark/snapshot local por sucursal.
 * Resuelve sku→product_id server-side contra catalog.products (lectura interna, gratis).
 * Espeja el mapeo de import-cedis-stock-wincaja.js, pero en modo delta (no REPLACE).
 */
async function applyWincajaStock(client, tenantId, rows, meta) {
  assertTenant(tenantId);
  const wcode = meta && meta.warehouse_code;
  if (!wcode) throw new Error('wincaja-stock: meta.warehouse_code requerido');
  if (!Array.isArray(rows) || !rows.length) return 0; // sin filas = nada (nunca borra el almacén)
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const wh = await client.query(
      `SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`,
      [tenantId, wcode],
    );
    if (!wh.rows.length) throw new Error(`wincaja-stock: warehouse code=${wcode} no existe`);
    const whId = wh.rows[0].id;

    await client.query(`CREATE TEMP TABLE stg_wstk_raw (sku text, existencia numeric) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((r, ri) => {
        vals.push(`($${ri * 2 + 1},$${ri * 2 + 2})`);
        params.push(String(r.sku), r.existencia);
      });
      await client.query(`INSERT INTO stg_wstk_raw (sku, existencia) VALUES ${vals.join(',')}`, params);
    }
    // sku→product_id + agrega por producto (sku duplicado en el .mdb → suma); clamp negativos a 0.
    await client.query(
      `CREATE TEMP TABLE stg_wstk ON COMMIT DROP AS
         SELECT p.id AS product_id, GREATEST(SUM(COALESCE(r.existencia,0)), 0) AS qty
         FROM stg_wstk_raw r
         JOIN catalog.products p ON p.tenant_id=$1 AND p.sku=r.sku AND p.deleted_at IS NULL
         GROUP BY p.id`,
      [tenantId],
    );
    const up = await client.query(
      `INSERT INTO commercial.stock AS s (tenant_id, warehouse_id, product_id, quantity, reserved_quantity, updated_at)
       SELECT $1, $2, product_id, qty, 0, now() FROM stg_wstk
       ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
         SET quantity=GREATEST(EXCLUDED.quantity, commercial.stock.reserved_quantity), updated_at=now()
       WHERE commercial.stock.quantity IS DISTINCT FROM GREATEST(EXCLUDED.quantity, commercial.stock.reserved_quantity)`,
      [tenantId, whId],
    );
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

const HANDLERS = {
  'stock-delta': applyStockDelta,
  'wincaja-stock': applyWincajaStock,
};

module.exports = { HANDLERS, applyStockDelta, applyWincajaStock, UUID_RE };
