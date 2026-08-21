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
    await client.query(`INSERT INTO ${tempName} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
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
 * feed 'raw-upsert' — CDC genérico Kepler → kepler_ods.<tabla> (SYNC.2).
 *
 * TABLA-AGNÓSTICO: replica cualquier tabla `md.*` de Kepler sin código por tabla. El replicador
 * (replicate-ods.js) descubre columnas + PK del origen y los manda en `meta`; este handler:
 *   1) auto-crea/auto-altera kepler_ods.<tabla> (DDL confinado a ese schema),
 *   2) UPSERT SIN CHURN: ON CONFLICT (sucursal, PK…) DO UPDATE … WHERE IS DISTINCT FROM
 *      → una fila que no cambió NO se reescribe (cero I/O, cero bloat).
 *
 * meta: { table, pk:[cols-origen sin 'sucursal'], columns:[{name,type}] (incluye 'sucursal') }.
 * rows: objetos { sucursal, <col>:val, … }. Los identificadores vienen por HTTP → se validan
 *   contra whitelist estricta (solo tablas/columnas estilo Kepler). kepler_ods es single-tenant
 *   (sin tenant_id/RLS); assertTenant solo protege el endpoint.
 */
const ODS_IDENT_RE = /^[a-z_][a-z0-9_]*$/i;
const ODS_TYPES = new Set(['text', 'numeric', 'double precision', 'real', 'integer', 'bigint', 'smallint', 'boolean', 'date', 'timestamp', 'timestamptz']);
const odsQid = (id) => '"' + String(id).replace(/"/g, '""') + '"';
function odsIdent(x) {
  const s = String(x == null ? '' : x);
  if (!ODS_IDENT_RE.test(s) || s.length > 63) throw new Error(`raw-upsert: identificador inválido '${s}'`);
  return s;
}
function odsType(t) { return ODS_TYPES.has(String(t)) ? String(t) : 'text'; }

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
  const conflict = ['sucursal', ...pk.filter((k) => k !== 'sucursal')];
  const conflictSet = new Set(conflict);
  const nonKey = cols.map((c) => c.name).filter((n) => !conflictSet.has(n));
  const rel = `kepler_ods.${odsQid(table)}`;

  await client.query('BEGIN');
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS kepler_ods`);

    // Auto-create / auto-alter.
    const exists = (await client.query(`SELECT to_regclass('kepler_ods.${table.replace(/'/g, "''")}') t`)).rows[0].t;
    if (!exists) {
      const defs = cols.map((c) => `${odsQid(c.name)} ${c.type}`).join(', ');
      await client.query(`CREATE TABLE ${rel} (${defs}, PRIMARY KEY (${conflict.map(odsQid).join(', ')}))`);
      try { await client.query(`GRANT SELECT ON ${rel} TO app_runtime`); } catch { /* rol ausente en dev */ }
    } else {
      const have = new Set((await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='kepler_ods' AND table_name=$1`, [table]
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

    // Marca de frescura (siempre, aunque changed=0 → prueba que el sync corrió).
    await client.query(`
      CREATE TABLE IF NOT EXISTS kepler_ods._sync_status (
        table_name text PRIMARY KEY, last_push_at timestamptz NOT NULL DEFAULT now(),
        rows_last integer DEFAULT 0, rows_seen integer DEFAULT 0)`);
    await client.query(
      `INSERT INTO kepler_ods._sync_status (table_name, last_push_at, rows_last, rows_seen)
       VALUES ($1, now(), $2, $3)
       ON CONFLICT (table_name) DO UPDATE SET last_push_at=now(), rows_last=EXCLUDED.rows_last, rows_seen=EXCLUDED.rows_seen`,
      [table, changed, Array.isArray(rows) ? rows.length : 0]);

    await client.query('COMMIT');

    // Normalize-al-llegar (hop 2): si esta tabla tiene normalizador (kdii→catálogo/precio), corre
    // en tx PROPIA tras el COMMIT del mirror crudo → si falla NO bloquea el CDC (el barrido completo
    // sync-product-master es el respaldo). Scoped a las llaves que llegaron = barato.
    const normalizer = ODS_NORMALIZERS[table];
    if (normalizer && Array.isArray(rows) && rows.length) {
      const keyCol = pk[0];
      const keys = Array.from(new Set(rows.map((r) => (r[keyCol] == null ? '' : String(r[keyCol]).trim())).filter(Boolean)));
      if (keys.length) {
        try { const nz = await normalizer(client, tenantId, keys); if (nz) console.log(`  [normalize:${table}] ${nz} filas app-facing (${keys.length} llaves)`); }
        catch (e) { console.error(`  [normalize:${table}] ⚠ ${String(e.message).slice(0, 140)} (CDC ok; lo toma el barrido)`); }
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
 * + commercial.product_prices (c90). NO reactiva (activo=false es decisión aparte) ni borra (el
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
             btrim(c3::text) AS linea, c90::numeric AS precio, NULL::uuid AS brand_id
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

    // 3) UPSERT precio base (c90 > 0.05, churn-free) — Kepler es autoridad del precio de venta.
    const prc = (await client.query(`
      INSERT INTO commercial.product_prices (id, tenant_id, price_list_id, product_id, price, tax_rate, min_qty, created_at, updated_at)
      SELECT gen_random_uuid(), $1, '${PRODUCT_BASE_LIST}', p.id, s.precio, COALESCE(p.iva_rate,0), 1, now(), now()
      FROM catalog.products p JOIN snap_p s ON s.sku=p.sku
      WHERE p.tenant_id=$1 AND p.deleted_at IS NULL AND s.precio > 0.05
      ON CONFLICT (tenant_id, price_list_id, product_id) DO UPDATE SET price=EXCLUDED.price, updated_at=now()
        WHERE commercial.product_prices.price IS DISTINCT FROM EXCLUDED.price`, [tenantId])).rowCount;

    await client.query('COMMIT');
    return ins + idn + prc;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

const ODS_NORMALIZERS = { kdii: normalizeProductsFromOds };

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
