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
const { buildMovementsSelect, SM_COLS } = require('./movements-projection');
const { computeLabels, toStageTuple, upsertLabels } = require('./label-compute');
const { computeBarcodes } = require('./barcode-compute');
const { normalizeCost, normalizeReorder, normalizeBoxFactor, normalizeBoxPrice, normalizeSalePrice } = require('./ods-derived');

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

    // 5) re-derivar analytics.stock_movements (todos los tipos, desde bronce acumulado) scoped
    //    a (almacén de esta sucursal wincaja_only, días tocados). Delete+insert (ventana chica,
    //    idempotente). source_branch='W<branch>' — el feed Kepler excluye 'W%' de su DELETE.
    let smMv = 0;
    if (days.length) {
      const wcode = `MD-${branch}`; // sucursales wincaja_only 30/32/50 → MD-30/32/50
      const whMv = await client.query(
        `SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`,
        [tenantId, wcode],
      );
      if (whMv.rows.length) {
        const whId = whMv.rows[0].id;
        const mvSel = buildMovementsSelect({ tenantId, branch: String(branch), warehouseId: whId, days });
        await client.query(
          `DELETE FROM analytics.stock_movements WHERE tenant_id=$1 AND warehouse_id=$2 AND source_branch=$3 AND doc_date = ANY($4::date[])`,
          [tenantId, whId, `W${branch}`, days],
        );
        const insMv = await client.query(`INSERT INTO analytics.stock_movements (${SM_COLS.join(',')}) ${mvSel}`);
        smMv = insMv.rowCount;
      }
    }

    await client.query('COMMIT');
    return mUp + sdUp + sdDel + smMv;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/** Inserta filas (objetos) en una tabla TEMP por lotes parametrizados.
 * perInsert acota filas×columnas ≤ límite de bind params de Postgres (65535); con muchas
 * columnas (p.ej. kdii=104) un batch fijo de 1000 se pasa → "bind message supplies N params". */
async function copyIntoTemp(client, tempName, cols, rows, perInsert) {
  const step = Math.max(1, perInsert || BATCH);
  for (let i = 0; i < rows.length; i += step) {
    const chunk = rows.slice(i, i + step);
    const params = [];
    const tuples = chunk.map((r) => {
      const ph = cols.map((c) => { params.push(r[c] === undefined ? null : r[c]); return `$${params.length}`; });
      return `(${ph.join(',')})`;
    });
    // Identificadores CITADOS: la staging se crea con comillas (preserva el case del origen) y sin
    // citar acá, Postgres bajaba el nombre a minúsculas → `column "almacen" of relation "stg_raw"
    // does not exist` con las tablas CamelCase de Wincaja (WR.8.0). Para los demás handlers, que
    // pasan snake_case en minúsculas, citar no cambia nada.
    const colList = cols.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',');
    await client.query(`INSERT INTO ${tempName} (${colList}) VALUES ${tuples.join(',')}`, params);
  }
}

/**
 * feed 'erp-goods-receipts' — órdenes de entrada Kepler (XA2001) → analytics.erp_goods_receipts (+ _lines).
 * rows: cada fila lleva `k`: 'h' (cabecera) o 'l' (línea). El poller on-prem detecta XA2001 nuevos/cambiados
 *   en las sucursales Kepler y los empuja. Ledger append-only (upsert por PK, SIN delete). Mismo SQL que
 *   import-goods-receipts (una sola fuente de verdad de columnas/conflictos).
 */
const GR_COLS = ['sucursal', 'folio', 'doc_prefix', 'receipt_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'vale_folio', 'oc_folio', 'concepto', 'monto', 'source_branch'];
const GRL_COLS = ['sucursal', 'folio', 'linea', 'sku', 'nombre', 'cantidad', 'unidad', 'costo_unitario', 'importe'];

async function applyErpGoodsReceipts(client, tenantId, rows) {
  assertTenant(tenantId);
  const headers = [], lines = [];
  for (const r of Array.isArray(rows) ? rows : []) { if (r.k === 'h') headers.push(r); else if (r.k === 'l') lines.push(r); }
  if (!headers.length && !lines.length) return 0;

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    let up = 0, upl = 0;

    if (headers.length) {
      await client.query(`CREATE TEMP TABLE stg_gr (sucursal text, folio text, doc_prefix text, receipt_date date, proveedor_code text, proveedor_nombre text, proveedor_rfc text, vale_folio text, oc_folio text, concepto text, monto numeric, source_branch text) ON COMMIT DROP`);
      await copyIntoTemp(client, 'stg_gr', GR_COLS, headers);
      up = (await client.query(
        `INSERT INTO analytics.erp_goods_receipts AS t
           (tenant_id, sucursal, folio, doc_prefix, receipt_date, proveedor_code, proveedor_nombre, proveedor_rfc, vale_folio, oc_folio, concepto, monto, source_branch, computed_at)
         SELECT $1, sucursal, folio, doc_prefix, receipt_date, proveedor_code, proveedor_nombre, proveedor_rfc, vale_folio, oc_folio, concepto, monto, source_branch, now() FROM stg_gr
         ON CONFLICT (tenant_id, sucursal, doc_prefix, folio) DO UPDATE SET
           doc_prefix=EXCLUDED.doc_prefix, receipt_date=EXCLUDED.receipt_date,
           proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
           proveedor_rfc=EXCLUDED.proveedor_rfc, vale_folio=EXCLUDED.vale_folio, oc_folio=EXCLUDED.oc_folio,
           concepto=EXCLUDED.concepto, monto=EXCLUDED.monto, source_branch=EXCLUDED.source_branch, computed_at=now()
         WHERE (t.receipt_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.vale_folio, t.oc_folio, t.concepto, t.monto)
               IS DISTINCT FROM
               (EXCLUDED.receipt_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre, EXCLUDED.proveedor_rfc, EXCLUDED.vale_folio, EXCLUDED.oc_folio, EXCLUDED.concepto, EXCLUDED.monto)`,
        [tenantId])).rowCount;
    }

    if (lines.length) {
      await client.query(`CREATE TEMP TABLE stg_grl (sucursal text, folio text, linea text, sku text, nombre text, cantidad numeric, unidad text, costo_unitario numeric, importe numeric) ON COMMIT DROP`);
      await copyIntoTemp(client, 'stg_grl', GRL_COLS, lines);
      upl = (await client.query(
        `INSERT INTO analytics.erp_goods_receipt_lines AS t
           (tenant_id, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, computed_at)
         SELECT $1, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, now() FROM stg_grl
         ON CONFLICT (tenant_id, sucursal, folio, linea) DO UPDATE SET
           sku=EXCLUDED.sku, nombre=EXCLUDED.nombre, cantidad=EXCLUDED.cantidad, unidad=EXCLUDED.unidad,
           costo_unitario=EXCLUDED.costo_unitario, importe=EXCLUDED.importe, computed_at=now()
         WHERE (t.sku, t.nombre, t.cantidad, t.unidad, t.costo_unitario, t.importe)
               IS DISTINCT FROM
               (EXCLUDED.sku, EXCLUDED.nombre, EXCLUDED.cantidad, EXCLUDED.unidad, EXCLUDED.costo_unitario, EXCLUDED.importe)`,
        [tenantId])).rowCount;
    }

    await client.query('COMMIT');
    return up + upl;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * feed 'erp-purchase-docs' — OC (X-A-35) y Vales (X-A-37) → analytics.erp_purchase_docs (+ _lines).
 * rows: cada fila lleva `k`: 'h' (cabecera) o 'l' (línea). Mismo SQL que import-purchase-docs
 *   (una sola fuente de verdad de columnas/conflictos). Ledger append-only, upsert por PK sin delete.
 *   Los dos doctypes van en la MISMA tabla — comparten shape en kdm1/kdm2 — y `doctype` es parte de la PK.
 */
const PD_COLS = ['doctype', 'sucursal', 'folio', 'doc_date', 'due_date', 'proveedor_code', 'proveedor_nombre', 'proveedor_rfc', 'concepto', 'condicion_pago', 'referencia', 'monto', 'ref_doctype', 'ref_folio', 'source_branch'];
const PDL_COLS = ['doctype', 'sucursal', 'folio', 'linea', 'sku', 'nombre', 'cantidad', 'unidad', 'costo_unitario', 'importe'];

async function applyErpPurchaseDocs(client, tenantId, rows) {
  assertTenant(tenantId);
  const headers = [], lines = [];
  for (const r of Array.isArray(rows) ? rows : []) { if (r.k === 'h') headers.push(r); else if (r.k === 'l') lines.push(r); }
  if (!headers.length && !lines.length) return 0;

  // Espejo convertido a vista en vivo (mig 20260820200000): el feed queda sin efecto a
  // proposito — la vista ya trae los documentos al segundo desde kepler_ods.
  const kind = await client.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass('analytics.erp_purchase_docs')`);
  if (kind.rows[0] && kind.rows[0].relkind === 'v') return 0;

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    let up = 0, upl = 0;

    if (headers.length) {
      await client.query(`CREATE TEMP TABLE stg_pd (doctype text, sucursal text, folio text, doc_date date, due_date date, proveedor_code text, proveedor_nombre text, proveedor_rfc text, concepto text, condicion_pago text, referencia text, monto numeric, ref_doctype text, ref_folio text, source_branch text) ON COMMIT DROP`);
      await copyIntoTemp(client, 'stg_pd', PD_COLS, headers);
      up = (await client.query(
        `INSERT INTO analytics.erp_purchase_docs AS t
           (tenant_id, doctype, sucursal, folio, doc_date, due_date, proveedor_code, proveedor_nombre,
            proveedor_rfc, concepto, condicion_pago, referencia, monto, ref_doctype, ref_folio, source_branch, computed_at)
         SELECT $1, doctype, sucursal, folio, doc_date, due_date, proveedor_code, proveedor_nombre,
                proveedor_rfc, concepto, condicion_pago, referencia, monto, ref_doctype, ref_folio, source_branch, now() FROM stg_pd
         ON CONFLICT (tenant_id, doctype, sucursal, folio) DO UPDATE SET
           doc_date=EXCLUDED.doc_date, due_date=EXCLUDED.due_date,
           proveedor_code=EXCLUDED.proveedor_code, proveedor_nombre=EXCLUDED.proveedor_nombre,
           proveedor_rfc=EXCLUDED.proveedor_rfc, concepto=EXCLUDED.concepto,
           condicion_pago=EXCLUDED.condicion_pago, referencia=EXCLUDED.referencia, monto=EXCLUDED.monto,
           ref_doctype=EXCLUDED.ref_doctype, ref_folio=EXCLUDED.ref_folio,
           source_branch=EXCLUDED.source_branch, computed_at=now()
         WHERE (t.doc_date, t.due_date, t.proveedor_code, t.proveedor_nombre, t.proveedor_rfc, t.concepto,
                t.condicion_pago, t.referencia, t.monto, t.ref_doctype, t.ref_folio)
               IS DISTINCT FROM
               (EXCLUDED.doc_date, EXCLUDED.due_date, EXCLUDED.proveedor_code, EXCLUDED.proveedor_nombre,
                EXCLUDED.proveedor_rfc, EXCLUDED.concepto, EXCLUDED.condicion_pago, EXCLUDED.referencia,
                EXCLUDED.monto, EXCLUDED.ref_doctype, EXCLUDED.ref_folio)`,
        [tenantId])).rowCount;
    }

    if (lines.length) {
      await client.query(`CREATE TEMP TABLE stg_pdl (doctype text, sucursal text, folio text, linea text, sku text, nombre text, cantidad numeric, unidad text, costo_unitario numeric, importe numeric) ON COMMIT DROP`);
      await copyIntoTemp(client, 'stg_pdl', PDL_COLS, lines);
      upl = (await client.query(
        `INSERT INTO analytics.erp_purchase_doc_lines AS t
           (tenant_id, doctype, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, computed_at)
         SELECT $1, doctype, sucursal, folio, linea, sku, nombre, cantidad, unidad, costo_unitario, importe, now() FROM stg_pdl
         ON CONFLICT (tenant_id, doctype, sucursal, folio, linea) DO UPDATE SET
           sku=EXCLUDED.sku, nombre=EXCLUDED.nombre, cantidad=EXCLUDED.cantidad, unidad=EXCLUDED.unidad,
           costo_unitario=EXCLUDED.costo_unitario, importe=EXCLUDED.importe, computed_at=now()
         WHERE (t.sku, t.nombre, t.cantidad, t.unidad, t.costo_unitario, t.importe)
               IS DISTINCT FROM
               (EXCLUDED.sku, EXCLUDED.nombre, EXCLUDED.cantidad, EXCLUDED.unidad, EXCLUDED.costo_unitario, EXCLUDED.importe)`,
        [tenantId])).rowCount;
    }

    await client.query('COMMIT');
    return up + upl;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * feed 'raw-upsert' — CDC genérico Access/Kepler → <schema>.<tabla> (SYNC.2 · WR.8).
 *
 * TABLA-AGNÓSTICO: replica cualquier tabla de origen sin código por tabla. El replicador
 * descubre columnas + PK del origen y los manda en `meta`; este handler:
 *   1) auto-crea/auto-altera <schema>.<tabla> (DDL confinado a un schema de la whitelist),
 *   2) UPSERT SIN CHURN: ON CONFLICT (sucursal, PK…) DO UPDATE … WHERE IS DISTINCT FROM
 *      → una fila que no cambió NO se reescribe (cero I/O, cero bloat).
 *
 * meta: { table, pk:[cols-origen sin 'sucursal'], columns:[{name,type}] (incluye 'sucursal'),
 *         schema?: 'kepler_ods' (default) | 'wincaja_ods' }.
 * rows: objetos { sucursal, <col>:val, … }. Los identificadores vienen por HTTP → se validan
 *   contra whitelist estricta. Los ODS son single-tenant (sin tenant_id/RLS); assertTenant solo
 *   protege el endpoint.
 *
 * `meta.schema` (WR.8.0) permite reusar este mismo handler para el agente-POS de Wincaja, que
 * empuja desde el `.mdb` VIVO de la caja. El UPSERT sin churn de acá es justamente lo que le
 * permite al agente mandar SNAPSHOTS COMPLETOS de catálogos sin hashear en PowerShell: el delta
 * lo calcula Postgres. Default sin cambios → el carril Kepler no se entera.
 */
const ODS_SCHEMAS = new Set(['kepler_ods', 'wincaja_ods']);
const ODS_IDENT_RE = /^[a-z_][a-z0-9_]*$/i;
const ODS_TYPES = new Set(['text', 'numeric', 'double precision', 'real', 'integer', 'bigint', 'smallint', 'boolean', 'date', 'timestamp', 'timestamptz']);
const odsQid = (id) => '"' + String(id).replace(/"/g, '""') + '"';
function odsIdent(x) {
  const s = String(x == null ? '' : x);
  if (!ODS_IDENT_RE.test(s) || s.length > 63) throw new Error(`raw-upsert: identificador inválido '${s}'`);
  return s;
}
function odsType(t) { return ODS_TYPES.has(String(t)) ? String(t) : 'text'; }
function odsSchema(s) {
  const v = String(s == null || s === '' ? 'kepler_ods' : s);
  if (!ODS_SCHEMAS.has(v)) throw new Error(`raw-upsert: schema no permitido '${v}'`);
  return v;
}

async function applyRawUpsert(client, tenantId, rows, meta) {
  assertTenant(tenantId);
  if (!meta || typeof meta !== 'object') throw new Error('raw-upsert: meta requerido');
  const table = odsIdent(meta.table);
  const cols = (Array.isArray(meta.columns) ? meta.columns : []).map((c) => ({ name: odsIdent(c && c.name), type: odsType(c && c.type) }));
  if (!cols.length) throw new Error('raw-upsert: meta.columns vacío');
  const colSet = new Set(cols.map((c) => c.name));
  if (!colSet.has('sucursal')) throw new Error("raw-upsert: falta la columna 'sucursal'");
  const pk = (Array.isArray(meta.pk) ? meta.pk : []).map(odsIdent);
  if (!pk.length) throw new Error('raw-upsert: meta.pk vacío (requerido para UPSERT sin churn)');
  for (const k of pk) if (!colSet.has(k)) throw new Error(`raw-upsert: PK '${k}' no está en columns`);

  // Destino: PK compuesta (sucursal, PK-origen). No-clave = todo lo demás.
  const schema = odsSchema(meta.schema);
  const conflict = ['sucursal', ...pk.filter((k) => k !== 'sucursal')];
  const conflictSet = new Set(conflict);
  const nonKey = cols.map((c) => c.name).filter((n) => !conflictSet.has(n));
  const rel = `${odsQid(schema)}.${odsQid(table)}`;

  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${odsQid(schema)}`);

    // Auto-create / auto-alter.
    // OJO: `to_regclass` sobre un literal SIN comillas baja el identificador a minúsculas → con
    // nombres CamelCase (las tablas de Wincaja: `MaestroMovAlmacen`) daba null aunque la tabla
    // existiera, y el handler intentaba CREATE de nuevo. `quote_ident` lo resuelve para los dos
    // carriles (Kepler ya venía en minúsculas, así que no cambia nada allá).
    const exists = (await client.query(
      `SELECT to_regclass(quote_ident($1) || '.' || quote_ident($2)) t`, [schema, table])).rows[0].t;
    if (!exists) {
      const defs = cols.map((c) => `${odsQid(c.name)} ${c.type}`).join(', ');
      await client.query(`CREATE TABLE ${rel} (${defs}, PRIMARY KEY (${conflict.map(odsQid).join(', ')}))`);
      try { await client.query(`GRANT SELECT ON ${rel} TO app_runtime`); } catch { /* rol ausente en dev */ }
    } else {
      const have = new Set((await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2`, [schema, table]
      )).rows.map((r) => r.column_name));
      for (const c of cols) {
        if (!have.has(c.name)) await client.query(`ALTER TABLE ${rel} ADD COLUMN ${odsQid(c.name)} ${c.type}`);
      }
    }

    let changed = 0;
    if (Array.isArray(rows) && rows.length) {
      const defs = cols.map((c) => `${odsQid(c.name)} ${c.type}`).join(', ');
      await client.query(`CREATE TEMP TABLE stg_raw (${defs}) ON COMMIT DROP`);
      const perInsert = Math.max(1, Math.floor(60000 / cols.length)); // ≤65535 bind params
      await copyIntoTemp(client, 'stg_raw', cols.map((c) => c.name), rows, perInsert);

      const colList = cols.map((c) => odsQid(c.name)).join(', ');
      const onConf = conflict.map(odsQid).join(', ');
      let sql;
      if (!nonKey.length) {
        // Tabla toda-PK (junction): nada que actualizar.
        sql = `INSERT INTO ${rel} (${colList}) SELECT ${colList} FROM stg_raw ON CONFLICT (${onConf}) DO NOTHING`;
      } else {
        const setList = nonKey.map((n) => `${odsQid(n)}=EXCLUDED.${odsQid(n)}`).join(', ');
        const tTuple = nonKey.map((n) => `t.${odsQid(n)}`).join(', ');
        const eTuple = nonKey.map((n) => `EXCLUDED.${odsQid(n)}`).join(', ');
        sql = `INSERT INTO ${rel} AS t (${colList}) SELECT ${colList} FROM stg_raw
               ON CONFLICT (${onConf}) DO UPDATE SET ${setList}
               WHERE (${tTuple}) IS DISTINCT FROM (${eTuple})`;
      }
      changed = (await client.query(sql)).rowCount;
    }

    // Marca de frescura (siempre, aunque changed=0 → prueba que el sync corrió). Por schema:
    // el carril Wincaja tiene su propio `_sync_status` y no se mezcla con el de Kepler.
    // La sucursal va en la llave porque el agente-POS empuja por caja: un `MaestroMovAlmacen`
    // fresco en la 30 no dice nada de la 32, y una sola fila por tabla lo taparía.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${odsQid(schema)}._sync_status (
        table_name text PRIMARY KEY, last_push_at timestamptz NOT NULL DEFAULT now(),
        rows_last integer DEFAULT 0, rows_seen integer DEFAULT 0)`);
    // Sólo el carril nuevo lleva sucursal en la llave. En `kepler_ods` la llave sigue siendo la
    // tabla a secas: `db-health` ya lee esas llaves y cambiarlas le rompería el sensor de frescura.
    const branches = schema === 'kepler_ods' ? [] : (Array.isArray(rows)
      ? Array.from(new Set(rows.map((r) => (r && r.sucursal != null ? String(r.sucursal).trim() : '')).filter(Boolean)))
      : []);
    const stKey = branches.length === 1 ? `${table}@${branches[0]}` : table;
    await client.query(
      `INSERT INTO ${odsQid(schema)}._sync_status (table_name, last_push_at, rows_last, rows_seen)
       VALUES ($1, now(), $2, $3)
       ON CONFLICT (table_name) DO UPDATE SET last_push_at=now(), rows_last=EXCLUDED.rows_last, rows_seen=EXCLUDED.rows_seen`,
      [stKey, changed, Array.isArray(rows) ? rows.length : 0]);

    await client.query('COMMIT');

    // Normalize-al-llegar (hop 2): si esta tabla tiene normalizador (kdii→catálogo/precio), corre
    // en tx PROPIA tras el COMMIT del mirror crudo → si falla NO bloquea el CDC (el barrido completo
    // sync-product-master es el respaldo). Scoped a las llaves que llegaron = barato.
    // Los normalizadores son de Kepler (kdii…); wincaja_ods no matchea ninguno y no corre nada.
    const cfg = schema === 'kepler_ods' ? ODS_NORMALIZERS[table] : null;
    if (cfg && Array.isArray(rows) && rows.length) {
      const skuCol = cfg.skuCol || pk[0];
      const keys = Array.from(new Set(rows.map((r) => (r[skuCol] == null ? '' : String(r[skuCol]).trim())).filter(Boolean)));
      if (keys.length) {
        for (const norm of cfg.fns) {
          // cada normalizador en su PROPIA tx → si uno falla, NO tumba a los otros ni al CDC (lo toma el barrido).
          try { const nz = await norm(client, tenantId, keys); if (nz) console.log(`  [normalize:${table}:${norm.name}] ${nz} filas (${keys.length} llaves)`); }
          catch (e) { console.error(`  [normalize:${table}:${norm.name}] ⚠ ${String(e.message).slice(0, 140)} (CDC ok; lo toma el barrido)`); }
        }
      }
    }
    return changed;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * feed 'raw-delete' — CDC DELETE genérico → borra de kepler_ods.<tabla> por llave (sucursal, PK).
 * Gemelo de 'raw-upsert' para el hard-delete que el poll (UPSERT-only) nunca propagó (ADR-047, CDC.3).
 * meta: { table, pk:[cols], columns:[{name,type}] (incluye 'sucursal') } (misma que raw-upsert).
 * rows: objetos con AL MENOS las columnas llave { sucursal, <pk>:val } (el resto se ignora).
 * Si la tabla no existe → 0 (nada que borrar; no auto-crea en un delete).
 */
async function applyRawDelete(client, tenantId, rows, meta) {
  assertTenant(tenantId);
  if (!meta || typeof meta !== 'object') throw new Error('raw-delete: meta requerido');
  const table = odsIdent(meta.table);
  const cols = (Array.isArray(meta.columns) ? meta.columns : []).map((c) => ({ name: odsIdent(c && c.name), type: odsType(c && c.type) }));
  const colType = new Map(cols.map((c) => [c.name, c.type]));
  const pk = (Array.isArray(meta.pk) ? meta.pk : []).map(odsIdent);
  if (!pk.length) throw new Error('raw-delete: meta.pk vacío (requerido para el WHERE del borrado)');
  const keyCols = ['sucursal', ...pk.filter((k) => k !== 'sucursal')];
  for (const k of keyCols) if (k !== 'sucursal' && !colType.has(k)) throw new Error(`raw-delete: PK '${k}' no está en columns`);
  if (!Array.isArray(rows) || !rows.length) return 0;
  const rel = `kepler_ods.${odsQid(table)}`;

  await client.query('BEGIN');
  try {
    const exists = (await client.query(`SELECT to_regclass('kepler_ods.${table.replace(/'/g, "''")}') t`)).rows[0].t;
    if (!exists) { await client.query('ROLLBACK'); return 0; }
    const defs = keyCols.map((c) => `${odsQid(c)} ${c === 'sucursal' ? 'text' : colType.get(c)}`).join(', ');
    await client.query(`CREATE TEMP TABLE stg_del (${defs}) ON COMMIT DROP`);
    await copyIntoTemp(client, 'stg_del', keyCols, rows, Math.max(1, Math.floor(60000 / keyCols.length)));
    const on = keyCols.map((c) => `t.${odsQid(c)}=d.${odsQid(c)}`).join(' AND ');
    const del = await client.query(`DELETE FROM ${rel} t USING stg_del d WHERE ${on}`);
    // marca de frescura (un batch de solo-deletes igual prueba que el sync corrió)
    await client.query(
      `INSERT INTO kepler_ods._sync_status (table_name, last_push_at, rows_last, rows_seen)
       VALUES ($1, now(), $2, $2)
       ON CONFLICT (table_name) DO UPDATE SET last_push_at=now()`, [table, del.rowCount]).catch(() => {});
    await client.query('COMMIT');
    return del.rowCount;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * feed 'cdc-heartbeat' — latido del consumidor CDC on-prem → analytics.cron_runs (CDC.5).
 * El consumidor (ods-cdc-wal.js) corre en la LAN y shipea por feeds-ingest; no puede escribir
 * cron_runs directo (su DATABASE_URL apunta al :5433). Este handler lo hace del lado prod.
 * rows[0]: { job_key, label?, status?, note? (lag del slot + shipped), host? }.
 * Con esto db-health hace dead-man's switch: si el consumidor muere (y el slot empieza a
 * retener WAL en el :5433), cron_runs se congela → ROJO antes de llenar disco.
 */
async function applyCdcHeartbeat(client, tenantId, rows) {
  assertTenant(tenantId);
  if (!Array.isArray(rows) || !rows.length) return 0;
  const r = rows[0] || {};
  const jobKey = String(r.job_key || '').slice(0, 60);
  if (!/^[a-z0-9_]+$/i.test(jobKey)) throw new Error(`cdc-heartbeat: job_key inválido '${jobKey}'`);
  await client.query(
    `INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, last_finish, status, note, host, updated_at)
     VALUES ($1,$2,$3, now(), now(), $4, $5, $6, now())
     ON CONFLICT (tenant_id, job_key) DO UPDATE
       SET label=COALESCE(EXCLUDED.label, analytics.cron_runs.label), last_finish=now(),
           status=EXCLUDED.status, note=EXCLUDED.note, host=EXCLUDED.host, updated_at=now()`,
    [tenantId, jobKey, String(r.label || jobKey).slice(0, 120), String(r.status || 'ok').slice(0, 20), r.note ? String(r.note).slice(0, 500) : null, String(r.host || 'cdc-lan').slice(0, 80)]);
  return 1;
}

// ---- Normalize-al-llegar (hop 2): kepler_ods.<tabla> → tablas que la app LEE ----
// Cuando llega un cambio crudo a kepler_ods, se normaliza SOLO esas llaves a las tablas de la app.
// El mismo single-source que el barrido (sync-product-master) pero dirigido y en tx aparte.

const PRODUCT_BASE_LIST = '00000000-0000-0000-0000-0000c0ffee02'; // commercial.price_lists BASE-MXN (is_default)

// Política de barcode (Edgar 2026-08-17): la plataforma CONSERVA el EAN real; Kepler solo llena si
// está vacío o es placeholder (c7 = SKU con ceros, p.ej. '089137'). NUNCA pisa un EAN real con un
// placeholder. Placeholder := nulo, o == sku (sin ceros), o < 8 chars. Real := ≥ 12 chars.
const BARCODE_CASE = `CASE
    WHEN length(coalesce(p.barcode,'')) >= 12
         AND (s.barcode IS NULL OR ltrim(s.barcode,'0') = ltrim(s.sku,'0') OR length(s.barcode) < 8)
      THEN p.barcode
    ELSE COALESCE(nullif(s.barcode,''), p.barcode)
  END`;

/**
 * Normaliza SOLO estos SKUs desde kepler_ods.kdii → catalog.products (identidad + política barcode)
 * (el precio lo lleva normalizeSalePrice). NO reactiva (activo=false es decisión aparte) ni borra (el
 * barrido reconcilia bajas). Idempotente y churn-free.
 */
async function normalizeProductsFromOds(client, tenantId, skus) {
  assertTenant(tenantId);
  if (!Array.isArray(skus) || !skus.length) return 0;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);

    // snapshot canónico SOLO de estos SKUs (una fila por sku, CEDIS '00' primero).
    await client.query(`
      CREATE TEMP TABLE snap_p ON COMMIT DROP AS
      SELECT DISTINCT ON (btrim(c1))
             btrim(c1) AS sku, btrim(c2) AS nombre,
             nullif(btrim(coalesce(c7,'')),'') AS barcode,
             btrim(c3::text) AS linea, NULL::uuid AS brand_id
        FROM kepler_ods.kdii
       WHERE btrim(c1) = ANY($1) AND btrim(coalesce(c2,'')) <> ''
       ORDER BY btrim(c1), (sucursal='00') DESC, sucursal`, [skus]);
    await client.query(`UPDATE snap_p s SET brand_id=b.id FROM catalog.brands b
                         WHERE b.tenant_id=$1 AND b.deleted_at IS NULL AND btrim(b.code)=s.linea`, [tenantId]);
    const fallback = (await client.query(
      `SELECT id FROM catalog.brands WHERE tenant_id=$1 AND code='SIN-LINEA' LIMIT 1`, [tenantId])).rows[0]?.id || null;

    // 1) INSERT nuevos: sku sin fila alguna, (brand,nombre) sin colisión, marca = resuelta ∨ fallback.
    const ins = fallback ? (await client.query(`
      INSERT INTO catalog.products (id, tenant_id, brand_id, sku, nombre, barcode, source, created_at, updated_at)
      SELECT gen_random_uuid(), $1, d.brand_id, d.sku, d.nombre, d.barcode, 'kepler', now(), now()
      FROM (SELECT DISTINCT ON (eff.brand_id, eff.nombre) eff.brand_id, eff.sku, eff.nombre, eff.barcode
              FROM (SELECT sku, nombre, barcode, COALESCE(brand_id, $2::uuid) AS brand_id FROM snap_p) eff
             WHERE eff.brand_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM catalog.products p WHERE p.tenant_id=$1 AND p.sku=eff.sku)
               AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1 AND p2.brand_id=eff.brand_id AND p2.nombre=eff.nombre)
             ORDER BY eff.brand_id, eff.nombre, eff.sku) d`, [tenantId, fallback])).rowCount : 0;

    // 2) UPDATE identidad (nombre + barcode por política), churn-free, sin colisión de la unique.
    const idn = (await client.query(`
      UPDATE catalog.products p SET nombre=s.nombre, barcode=${BARCODE_CASE}, updated_at=now()
      FROM snap_p s
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.sku=s.sku
        AND ( p.nombre IS DISTINCT FROM s.nombre OR p.barcode IS DISTINCT FROM ${BARCODE_CASE} )
        AND NOT EXISTS (SELECT 1 FROM catalog.products p2 WHERE p2.tenant_id=$1 AND p2.id<>p.id
                          AND p2.brand_id=p.brand_id AND p2.nombre=s.nombre)`, [tenantId])).rowCount;

    // El PRECIO ya no se escribe acá. Vivía como "UPSERT c90 > 0.05" tomando la fila de CEDIS
    // primero y sin una sola validación — era el escritor que estampaba las plantillas de kdii
    // ($15.25/$7.02/$8.48) sobre BASE-MXN. Pasó a `normalizeSalePrice` (ods-derived), que lee la
    // BITÁCORA con su unidad y valida contra lo cobrado / la escalera / el costo. Sigue siendo
    // al-momento: está registrado en ODS_NORMALIZERS para kdm2 (la venta), kdii y kdpv_prod_util.
    await client.query('COMMIT');
    return ins + idn;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * Normaliza SOLO estos SKUs desde kepler_ods.kdii + kdpv_prod_util → commercial.product_label_prices
 * (etiquetera Tienda). Hop-2 AL-MOMENTO: cuando un cambio de kdii/kdpv llega al ODS, la etiqueta de
 * anaquel se recomputa al instante (misma lógica que el importer nocturno, vía label-compute — single
 * source of truth). Churn-free (upsertLabels solo reescribe si algo cambió). NUNCA pisa source='manual'.
 * El barcode-fallback de productos SIN sku + el backfill de products.barcode los cubre el nightly.
 * Ver feedback_ods_derived_realtime_no_batch_lag.
 */
async function normalizeLabelsFromOds(client, tenantId, skus) {
  assertTenant(tenantId);
  const clean = Array.from(new Set((Array.isArray(skus) ? skus : []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean)));
  if (!clean.length) return 0;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const labels = await computeLabels(client, { schema: 'kepler_ods', skus: clean });
    if (!labels.length) { await client.query('COMMIT'); return 0; }
    // sku → product_id (activos). Productos sin sku (match por barcode) los toma el barrido nocturno.
    const pmap = new Map((await client.query(
      `SELECT id, btrim(sku) AS sku FROM catalog.products
        WHERE tenant_id=$1 AND deleted_at IS NULL AND btrim(coalesce(sku,'')) = ANY($2)`,
      [tenantId, clean])).rows.map((r) => [r.sku, r.id]));
    const seen = new Set();
    const tuples = [];
    for (const lab of labels) {
      const pid = pmap.get(lab.sku);
      if (!pid || seen.has(pid)) continue; // 1ª (mayor c90 por DISTINCT ON) gana
      seen.add(pid);
      tuples.push(toStageTuple(lab, pid));
    }
    const changed = await upsertLabels(client, tenantId, tuples);
    await client.query('COMMIT');
    return changed;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * Normaliza SOLO estos SKUs desde kepler_ods.kdii → catalog.product_barcodes (barcodes por UNIDAD,
 * 1 SKU→N). Hop-2 AL-MOMENTO: un cambio de kdii recomputa los barcodes al instante (misma lógica que
 * el reconciliador nocturno, vía barcode-compute — single source of truth). Churn-free (solo escribe
 * si algo cambió). Soft-delete de los barcodes kepler_* que ya no salen de Kepler para ese SKU (no toca
 * source='wincaja' ni manual). Ver feedback_everything_derivable_from_ods + project_etiquetera_tienda.
 */
async function normalizeBarcodesFromOds(client, tenantId, skus) {
  assertTenant(tenantId);
  const clean = Array.from(new Set((Array.isArray(skus) ? skus : []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean)));
  if (!clean.length) return 0;
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL app.tenant_id = '${tenantId}'`);
    const rows = await computeBarcodes(client, { schema: 'kepler_ods', skus: clean });
    // stg_bc SIEMPRE (aunque vacía) para que el soft-delete de stale funcione uniforme.
    await client.query(`CREATE TEMP TABLE stg_bc (
      sku text, barcode text, unit text, factor numeric, source text, is_primary boolean) ON COMMIT DROP`);
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = [], params = [];
      chunk.forEach((r, ri) => {
        const b = ri * 6;
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
        params.push(r.sku, r.barcode, r.unit, r.factor, r.source, r.is_primary);
      });
      await client.query(`INSERT INTO stg_bc VALUES ${vals.join(',')}`, params);
    }
    let changed = 0;
    if (rows.length) {
      const up = await client.query(`
        INSERT INTO catalog.product_barcodes (id, tenant_id, sku, barcode, unit, factor, source, is_primary, synced_at, updated_at)
        SELECT gen_random_uuid(), $1, s.sku, s.barcode, s.unit, s.factor, s.source, s.is_primary, now(), now()
          FROM stg_bc s
        ON CONFLICT (tenant_id, sku, barcode) WHERE deleted_at IS NULL DO UPDATE SET
          unit=EXCLUDED.unit, factor=EXCLUDED.factor, source=EXCLUDED.source,
          is_primary=EXCLUDED.is_primary, synced_at=now(), updated_at=now()
        WHERE (catalog.product_barcodes.unit, catalog.product_barcodes.factor,
               catalog.product_barcodes.source, catalog.product_barcodes.is_primary)
              IS DISTINCT FROM (EXCLUDED.unit, EXCLUDED.factor, EXCLUDED.source, EXCLUDED.is_primary)`,
        [tenantId]);
      changed += up.rowCount;
    }
    // soft-delete de barcodes kepler_* que ya NO salen de Kepler para estos SKUs (no toca wincaja/manual).
    const del = await client.query(`
      UPDATE catalog.product_barcodes p SET deleted_at=now(), updated_at=now()
       WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND p.source LIKE 'kepler\\_%'
         AND btrim(p.sku) = ANY($2)
         AND NOT EXISTS (SELECT 1 FROM stg_bc s WHERE s.sku=btrim(p.sku) AND s.barcode=p.barcode)`,
      [tenantId, clean]);
    changed += del.rowCount;
    await client.query('COMMIT');
    return changed;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

// Una tabla → { skuCol?, fns:[...] }. skuCol = de qué columna sacar los SKUs que llegaron (default pk[0];
// kdik lo tiene en c2, no en su pk[0]=c1). Cada fn se corre en orden, en su PROPIA tx.
// Todo lo derivado de current-state del ODS va acá (al-momento) → feedback_ods_derived_realtime_no_batch_lag.
const ODS_NORMALIZERS = {
  kdii: { fns: [normalizeProductsFromOds, normalizeSalePrice, normalizeLabelsFromOds, normalizeBarcodesFromOds, normalizeCost, normalizeBoxFactor, normalizeReorder] },
  kdik: { skuCol: 'c2', fns: [normalizeCost] },              // costo: c16 es la fuente primaria
  kdpv_prod_util: { fns: [normalizeSalePrice, normalizeLabelsFromOds, normalizeBoxPrice] },
  // Bitácora de cambios de precio de Kepler: es la FUENTE del precio de venta, así que un cambio de
  // precio recalcula al instante. Su SKU vive en c3 (el pk[0] es la sucursal).
  // Una VENTA nueva es un precio nuevo: el PdV es la fuente. Su SKU vive en c8.
  kdm2: { skuCol: 'c8', fns: [normalizeSalePrice] },
};

const HANDLERS = {
  'stock-delta': applyStockDelta,
  'wincaja-stock': applyWincajaStock,
  'wincaja-sales-bronze': applyWincajaSalesBronze,
  'erp-goods-receipts': applyErpGoodsReceipts,
  'erp-purchase-docs': applyErpPurchaseDocs,
  'raw-upsert': applyRawUpsert,
  'raw-delete': applyRawDelete,
  'cdc-heartbeat': applyCdcHeartbeat,
};

module.exports = { HANDLERS, applyStockDelta, applyWincajaStock, applyWincajaSalesBronze, applyErpGoodsReceipts, applyErpPurchaseDocs, applyRawUpsert, applyRawDelete, applyCdcHeartbeat, normalizeProductsFromOds, UUID_RE };
