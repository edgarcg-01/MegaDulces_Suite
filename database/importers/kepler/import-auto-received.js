/* eslint-disable no-console */
/**
 * RA.15.1 — Auto-received: concilia nuestras OC abiertas contra la orden de entrada
 * (X-A-40) de Kepler y las cierra sin captura manual (BULK, on-prem).
 *
 * Contexto (ver FASE_RA §2.5 + ADR-031): en Kepler la mercancía entra al inventario en
 * la orden de entrada X-A-40 (único doc que toca el kardex kdij). Mega Dulces hace la
 * recepción EN Kepler, no en la plataforma → nuestras OC quedarían 'open' para siempre.
 * Este feed detecta el X-A-40 y genera la OE (goods_receipt) que cierra la OC.
 *
 * NO mueve stock: como Kepler YA procesó el X-A-40, esa existencia YA viene en el snapshot
 * nocturno → la OE va con source='kepler' + stock_applied=false (evita doble-conteo).
 *
 * Matching (heurístico, decisión Edgar 2026-07-09 — no hay folio compartido, no hay
 * write-back): por PRESENCIA sku+almacén+fecha. Si un X-A-40 posterior a la OC (mismo
 * almacén) contiene el sku de una línea pendiente → se cierra esa línea en full. La qty
 * de Kepler viene en su unidad de presentación (PAQ/CJA) ≠ piezas de la OC → no se
 * reconcilia cantidad exacta; se marca recibido = pendiente (MD captura de golpe, fill
 * ~100%). Dedup por folio (índice único parcial) + OC más vieja primero + cap al pendiente.
 *
 *   node database/importers/kepler/import-auto-received.js          # dry-run
 *   node database/importers/kepler/import-auto-received.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

function branchNum(url) { const m = /md_(\d+)/i.exec(url || ''); return m ? m[1] : null; }
const dstr = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

// Órdenes de entrada X-A-40 agregadas por folio×sku (qty en unidad de presentación Kepler).
const ENTRADAS_SQL = `
  SELECT oe.c6 AS folio, oe.c9 AS doc_date, l.c8 AS sku, SUM(l.c9) AS qty
  FROM md.kdm1 oe
  JOIN md.kdm2 l ON l.c1=oe.c1 AND l.c2=oe.c2 AND l.c3=oe.c3 AND l.c4=oe.c4 AND l.c6=oe.c6
  WHERE oe.c1=$1 AND oe.c2='X' AND oe.c3='A' AND oe.c4='40' AND oe.c9 >= $2
  GROUP BY oe.c6, oe.c9, l.c8
  HAVING SUM(l.c9) > 0`;

/**
 * Matching puro (testeable). Devuelve las recepciones a crear.
 * @param orders   OCs abiertas del almacén, MÁS VIEJA primero:
 *                 [{ id, created_date, lines:[{ po_line_id, product_id, sku, pending }] }]
 * @param entradas X-A-40 del almacén: [{ folio, doc_date, sku }]  (una fila por folio×sku)
 * @param taken    Set de folios ya conciliados (dedup) — se muta al asignar.
 * @returns [{ purchase_order_id, folio, doc_date, lines:[{ po_line_id, product_id, received_qty }] }]
 */
function matchEntradasToOrders(orders, entradas, taken) {
  // pendiente vivo por OC×línea (se decrementa al asignar).
  const pend = new Map(); // po_id -> Map(sku -> {po_line_id, product_id, qty})
  for (const o of orders) {
    const m = new Map();
    for (const l of o.lines) if (Number(l.pending) > 0) m.set(l.sku, { po_line_id: l.po_line_id, product_id: l.product_id, qty: Number(l.pending) });
    pend.set(o.id, m);
  }
  // folios → { doc_date, skus:Set }, ordenados por fecha asc.
  const folios = new Map();
  for (const e of entradas) {
    if (!folios.has(e.folio)) folios.set(e.folio, { doc_date: e.doc_date, skus: new Set() });
    folios.get(e.folio).skus.add(String(e.sku));
  }
  const folioList = [...folios.entries()].sort((a, b) => dstr(a[1].doc_date).localeCompare(dstr(b[1].doc_date)));

  const receipts = [];
  for (const [folio, f] of folioList) {
    if (taken.has(folio)) continue;
    const fdate = dstr(f.doc_date);
    // OC más vieja (created <= fecha entrada) con ≥1 línea pendiente cuyo sku esté en el folio.
    const target = orders.find((o) =>
      dstr(o.created_date) <= fdate &&
      [...(pend.get(o.id) || new Map()).keys()].some((sku) => f.skus.has(sku)));
    if (!target) continue;

    const m = pend.get(target.id);
    const lines = [];
    for (const sku of f.skus) {
      const pl = m.get(sku);
      if (pl && pl.qty > 0) { lines.push({ po_line_id: pl.po_line_id, product_id: pl.product_id, received_qty: pl.qty }); m.delete(sku); }
    }
    if (!lines.length) continue;
    taken.add(folio);
    receipts.push({ purchase_order_id: target.id, folio, doc_date: f.doc_date, lines });
  }
  return receipts;
}

async function nextOeFolio(db, year) {
  const r = await db.query(
    `INSERT INTO commercial.purchase_doc_sequences (tenant_id, year, doc_kind, last_seq) VALUES ($1,$2,'OE',1)
     ON CONFLICT (tenant_id, year, doc_kind) DO UPDATE SET last_seq = commercial.purchase_doc_sequences.last_seq + 1
     RETURNING last_seq`, [M, year]);
  return `OE-${year}-${String(r.rows[0].last_seq).padStart(5, '0')}`;
}

async function run() {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Auto-received: X-A-40 Kepler → cierre de OC (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await db.query(`SET app.tenant_id = '${M}'`);

    // OC abiertas/parciales + líneas pendientes + sku, agrupadas por código de almacén.
    const ocRows = (await db.query(`
      SELECT po.id, po.warehouse_id, w.code AS warehouse_code, po.created_at::date AS created_date,
             po.requisition_id, l.id AS po_line_id, l.product_id, pr.sku,
             (l.ordered_qty - l.received_qty) AS pending
      FROM commercial.purchase_orders po
      JOIN commercial.warehouses w ON w.tenant_id=po.tenant_id AND w.id=po.warehouse_id
      JOIN commercial.purchase_order_lines l ON l.tenant_id=po.tenant_id AND l.purchase_order_id=po.id
      JOIN catalog.products pr ON pr.tenant_id=po.tenant_id AND pr.id=l.product_id
      WHERE po.tenant_id=$1 AND po.estado IN ('open','partial') AND po.source_type='supplier'
        AND (l.ordered_qty - l.received_qty) > 0
      ORDER BY po.created_at ASC`, [M])).rows;

    if (!ocRows.length) { console.log('  Sin OC abiertas para conciliar. Nada que hacer.'); return; }

    const byWh = new Map(); // warehouse_code -> { warehouse_id, orders: Map(po_id -> {id, created_date, requisition_id, lines[]}) }
    for (const r of ocRows) {
      if (!byWh.has(r.warehouse_code)) byWh.set(r.warehouse_code, { warehouse_id: r.warehouse_id, orders: new Map() });
      const g = byWh.get(r.warehouse_code);
      if (!g.orders.has(r.id)) g.orders.set(r.id, { id: r.id, created_date: r.created_date, requisition_id: r.requisition_id, lines: [] });
      g.orders.get(r.id).lines.push({ po_line_id: r.po_line_id, product_id: r.product_id, sku: String(r.sku), pending: Number(r.pending) });
    }
    console.log(`  OC abiertas: ${new Set(ocRows.map((r) => r.id)).size} en ${byWh.size} almacén(es).`);

    // Folios ya conciliados (dedup global).
    const taken = new Set((await db.query(
      `SELECT source_kepler_folio FROM commercial.goods_receipts WHERE tenant_id=$1 AND source='kepler' AND source_kepler_folio IS NOT NULL`, [M]
    )).rows.map((r) => r.source_kepler_folio));

    await db.query('BEGIN');
    const year = new Date().getFullYear();
    const summary = [];
    let created = 0;

    for (const m of MAP) {
      const g = byWh.get(m.code);
      if (!g) continue; // sin OC abiertas en ese almacén
      const suc = branchNum(m.url);
      if (!suc) { console.log(`  ⚠ ${m.code}: no pude derivar sucursal — skip`); continue; }
      const orders = [...g.orders.values()].sort((a, b) => dstr(a.created_date).localeCompare(dstr(b.created_date)));
      const minDate = dstr(orders[0].created_date);

      let src;
      try { src = new Client({ connectionString: m.url }); await src.connect(); }
      catch (e) { console.log(`  ⚠ ${m.code}: sin conexión (${e.message}) — skip`); continue; }

      let matched = 0;
      try {
        const entradas = (await src.query(ENTRADAS_SQL, [suc, minDate])).rows;
        const receipts = matchEntradasToOrders(orders, entradas, taken);
        matched = receipts.length;

        for (const rc of receipts) {
          const folio = await nextOeFolio(db, year);
          let units = 0;
          for (const l of rc.lines) units += Number(l.received_qty);
          const gr = (await db.query(`
            INSERT INTO commercial.goods_receipts
              (tenant_id, folio, purchase_order_id, warehouse_id, total_units, total_cost, stock_applied, source, source_kepler_folio, notes, received_at)
            VALUES ($1,$2,$3,$4,$5,0,false,'kepler',$6,$7,$8) RETURNING id`,
            [M, folio, rc.purchase_order_id, g.warehouse_id, units, rc.folio, `Auto-conciliado X-A-40 ${rc.folio}`, dstr(rc.doc_date)])).rows[0];
          for (const l of rc.lines) {
            await db.query(`INSERT INTO commercial.goods_receipt_lines
              (tenant_id, goods_receipt_id, purchase_order_line_id, product_id, received_qty, unit_cost, line_cost)
              VALUES ($1,$2,$3,$4,$5,0,0)`, [M, gr.id, l.po_line_id, l.product_id, l.received_qty]);
            await db.query(`UPDATE commercial.purchase_order_lines SET received_qty = received_qty + $3
              WHERE tenant_id=$1 AND id=$2`, [M, l.po_line_id, l.received_qty]);
          }
          // Recalcula estado de la OC.
          const fresh = (await db.query(`SELECT ordered_qty, received_qty FROM commercial.purchase_order_lines WHERE tenant_id=$1 AND purchase_order_id=$2`, [M, rc.purchase_order_id])).rows;
          const recv = fresh.reduce((s, x) => s + Number(x.received_qty), 0);
          const complete = fresh.every((x) => Number(x.received_qty) >= Number(x.ordered_qty));
          await db.query(`UPDATE commercial.purchase_orders SET estado=$3, received_units=$4, closed_at=$5, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
            [M, rc.purchase_order_id, complete ? 'received' : 'partial', recv, complete ? new Date().toISOString() : null]);
          if (complete) {
            const o = g.orders.get(rc.purchase_order_id);
            if (o?.requisition_id) await db.query(`UPDATE commercial.purchase_requisitions SET estado='received', received_at=now(), updated_at=now()
              WHERE tenant_id=$1 AND id=$2 AND estado IN ('ordered','approved')`, [M, o.requisition_id]);
          }
          created++;
        }
        summary.push({ code: m.code, suc, ocs_open: g.orders.size, entradas: entradas.length, matched });
      } catch (e) {
        console.log(`  ⚠ ${m.code}: error (${e.message}) — skip`);
      } finally { await src.end(); }
    }
    console.table(summary);

    if (!APPLY) { await db.query('ROLLBACK'); console.log(`\n[DRY-RUN] ROLLBACK — habría creado ${created} OE de conciliación.`); return; }
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${created} OE auto-conciliadas (source=kepler, stock_applied=false).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
}

module.exports = { matchEntradasToOrders };
if (require.main === module) run();
