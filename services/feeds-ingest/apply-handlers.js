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

const { buildSalesDailySrc } = require('./sales-daily-projection');

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
         SET quantity=GREATEST(EXCLUDED.quantity, s.reserved_quantity), updated_at=now()
       WHERE s.quantity IS DISTINCT FROM GREATEST(EXCLUDED.quantity, s.reserved_quantity)`,
      [tenantId, whId],
    );
    await client.query('COMMIT');
    return up.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * feed 'wincaja-sales-bronze' — venta CRUDA de una sucursal Wincaja → bronze + re-deriva sales_daily.
 * meta: { source_branch, source_dataset='actual' }.
 * rows: cada fila lleva `k`: 'm' (maestro_mov_almacen) o 'd' (detalles_mov_almacen).
 *   El extractor empuja maestro+detalles de los consecutivos NUEVOS (Tipo='V') de forma incremental.
 * Flujo (1 trx): upsert maestro por PK · block-diff detalles por consecutivo (PK surrogate) ·
 *   re-deriva analytics.sales_daily SCOPED a (branch, días tocados) con el MISMO SQL del gold feed
 *   (sales-daily-projection) → cero divergencia. bronze acumula, así el total diario converge.
 */
const M_COLS = ['consecutivo', 'tipo', 'documento', 'tercero', 'referencia', 'fecha', 'hora', 'almacen', 'moneda', 'paridad', 'caja', 'cajero', 'vendedor', 'cancelado', 'observaciones', 'fecha_captura'];
const D_COLS = ['consecutivo', 'articulo', 'tipo', 'documento', 'cantidad_regular', 'cantidad_auxiliar', 'valor_costo', 'valor_venta', 'iva', 'ieps', 'descuento1', 'descuento2', 'tipo_precio', 'unidad_venta'];

async function applyWincajaSalesBronze(client, tenantId, rows, meta) {
  assertTenant(tenantId);
  const branch = meta && meta.source_branch;
  const dataset = (meta && meta.source_dataset) || 'actual';
  if (!branch || !/^[0-9A-Za-z_-]{1,12}$/.test(String(branch))) throw new Error(`wincaja-sales-bronze: meta.source_branch inválido: ${branch}`);
  const maestro = [], detalles = [];
  for (const r of Array.isArray(rows) ? rows : []) { if (r.k === 'm') maestro.push(r); else if (r.k === 'd') detalles.push(r); }
  if (!maestro.length && !detalles.length) return 0;

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);

    // 1) upsert maestro (PK natural)
    let mUp = 0;
    for (let i = 0; i < maestro.length; i += 500) {
      const chunk = maestro.slice(i, i + 500);
      const cols = ['tenant_id', 'source_branch', 'source_dataset', ...M_COLS];
      const params = [];
      const tuples = chunk.map((r) => {
        const rowVals = [tenantId, branch, dataset, ...M_COLS.map((c) => (r[c] === undefined ? null : r[c]))];
        const ph = rowVals.map((v) => { params.push(v); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      const setCols = M_COLS.filter((c) => c !== 'consecutivo').map((c) => `${c}=EXCLUDED.${c}`).join(', ');
      const res = await client.query(
        `INSERT INTO wincaja.maestro_mov_almacen (${cols.join(',')}) VALUES ${tuples.join(',')}
         ON CONFLICT (tenant_id, source_branch, source_dataset, consecutivo) DO UPDATE SET ${setCols}`,
        params,
      );
      mUp += res.rowCount;
    }

    // 2) block-diff detalles por consecutivo (PK surrogate → borrar+insertar)
    const consSet = Array.from(new Set([...maestro, ...detalles].map((r) => String(r.consecutivo)).filter(Boolean)));
    if (consSet.length) {
      await client.query(
        `DELETE FROM wincaja.detalles_mov_almacen WHERE tenant_id=$1 AND source_branch=$2 AND source_dataset=$3 AND consecutivo = ANY($4)`,
        [tenantId, branch, dataset, consSet],
      );
    }
    for (let i = 0; i < detalles.length; i += 500) {
      const chunk = detalles.slice(i, i + 500);
      const cols = ['tenant_id', 'source_branch', 'source_dataset', ...D_COLS];
      const params = [];
      const tuples = chunk.map((r) => {
        const rowVals = [tenantId, branch, dataset, ...D_COLS.map((c) => (r[c] === undefined ? null : r[c]))];
        const ph = rowVals.map((v) => { params.push(v); return `$${params.length}`; });
        return `(${ph.join(',')})`;
      });
      await client.query(`INSERT INTO wincaja.detalles_mov_almacen (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
    }

    // 3) días tocados (de las cabeceras) → 4) re-derivar sales_daily SCOPED
    const days = Array.from(new Set(maestro.map((r) => String(r.fecha || '').slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))));
    let sdUp = 0, sdDel = 0;
    if (days.length) {
      const src = buildSalesDailySrc({ tenantId, branches: [String(branch)], days });
      await client.query(`CREATE TEMP TABLE stg_wsd ON COMMIT DROP AS SELECT * FROM (${src}) src`);
      const up = await client.query(
        `INSERT INTO analytics.sales_daily AS sd (tenant_id, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, updated_at)
         SELECT $1, product_id, warehouse_id, channel, sale_date, units, revenue, cost, tickets, unit_kind, now() FROM stg_wsd
         ON CONFLICT (tenant_id, product_id, warehouse_id, channel, sale_date) DO UPDATE SET
           units=EXCLUDED.units, revenue=EXCLUDED.revenue, cost=EXCLUDED.cost, tickets=EXCLUDED.tickets, unit_kind=EXCLUDED.unit_kind, updated_at=now()
         WHERE (sd.units, sd.revenue, sd.cost, sd.tickets, sd.unit_kind)
               IS DISTINCT FROM (EXCLUDED.units, EXCLUDED.revenue, EXCLUDED.cost, EXCLUDED.tickets, EXCLUDED.unit_kind)`,
        [tenantId],
      );
      sdUp = up.rowCount;
      // reconciliar: borrar filas wincaja% de esos (almacén, día) que ya no vienen del re-proyectado
      const del = await client.query(
        `DELETE FROM analytics.sales_daily sd
          WHERE sd.tenant_id=$1 AND sd.channel LIKE 'wincaja%'
            AND sd.sale_date = ANY($2::date[])
            AND sd.warehouse_id IN (SELECT DISTINCT warehouse_id FROM stg_wsd)
            AND NOT EXISTS (SELECT 1 FROM stg_wsd s WHERE s.product_id=sd.product_id AND s.warehouse_id=sd.warehouse_id AND s.channel=sd.channel AND s.sale_date=sd.sale_date)`,
        [tenantId, days],
      );
      sdDel = del.rowCount;
    }

    await client.query('COMMIT');
    return mUp + sdUp + sdDel;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

const HANDLERS = {
  'stock-delta': applyStockDelta,
  'wincaja-stock': applyWincajaStock,
  'wincaja-sales-bronze': applyWincajaSalesBronze,
};

module.exports = { HANDLERS, applyStockDelta, applyWincajaStock, applyWincajaSalesBronze, UUID_RE };
