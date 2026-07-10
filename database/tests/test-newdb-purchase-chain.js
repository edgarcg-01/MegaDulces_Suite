/* eslint-disable no-console */
/**
 * RA.15 (ADR-031) — Smoke E2E de la cadena de compra: Requisición → OC → OE (recepción
 * que MUEVE stock). DB-direct, autocontenido: una transacción con ROLLBACK, no persiste.
 * Replica el SQL del CommercialPurchaseOrdersService para validar schema + invariantes:
 *   folios OC/OE · generar OC desde requisición (RQ→ordered) · recepción parcial mueve
 *   stock +destino · recompute estado open→partial→received · fill rate · RQ→received al
 *   completar · traspaso (branch) mueve +destino y −origen (clamp) · RLS forzado.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

async function nextFolio(trx, kind, year) {
  const r = await trx.raw(
    `INSERT INTO commercial.purchase_doc_sequences (tenant_id, year, doc_kind, last_seq) VALUES (?, ?, ?, 1)
     ON CONFLICT (tenant_id, year, doc_kind) DO UPDATE SET last_seq = commercial.purchase_doc_sequences.last_seq + 1
     RETURNING last_seq`, [T, year, kind]);
  return `${kind}-${year}-${String(r.rows[0].last_seq).padStart(5, '0')}`;
}
async function moveStock(trx, wh, prod, kind, qty, ref) {
  const s = await trx('commercial.stock').where({ warehouse_id: wh, product_id: prod }).forUpdate().first();
  const before = s ? Number(s.quantity) : 0;
  const reserved = s ? Number(s.reserved_quantity) : 0;
  const applied = kind === 'out' ? Math.min(qty, Math.max(0, before - reserved)) : qty;
  const after = kind === 'in' ? before + applied : before - applied;
  if (s) await trx('commercial.stock').where({ id: s.id }).update({ quantity: after });
  else await trx('commercial.stock').insert({ tenant_id: T, warehouse_id: wh, product_id: prod, quantity: after, reserved_quantity: 0 });
  await trx('commercial.stock_movements').insert({
    tenant_id: T, warehouse_id: wh, product_id: prod, movement_type: kind, quantity: applied,
    quantity_before: before, quantity_after: after, reference_type: 'goods_receipt', reference_id: ref,
  });
  return { before, after, applied };
}

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const year = new Date().getFullYear();

      // ── 1. Schema ────────────────────────────────────────────────────────
      const reg = async (n) => (await trx.raw('select to_regclass(?) r', [`commercial.${n}`])).rows[0].r;
      for (const t of ['purchase_orders', 'purchase_order_lines', 'goods_receipts', 'goods_receipt_lines', 'purchase_doc_sequences'])
        ok(await reg(t), `tabla commercial.${t}`);
      const est = (await trx.raw(`select pg_get_constraintdef(oid) d from pg_constraint where conname like '%purchase_orders_estado%' or conrelid='commercial.purchase_orders'::regclass and contype='c'`)).rows.find((r) => /open.*partial.*received/.test(r.d));
      ok(!!est, `estado OC CHECK (open|partial|received|cancelled)`);
      // RLS forzado en las 4 tablas nuevas
      const rls = (await trx.raw(`select relname from pg_class where relname in ('purchase_orders','goods_receipts') and relforcerowsecurity`)).rows;
      ok(rls.length === 2, 'RLS forzado en purchase_orders + goods_receipts');

      // ── 2. Datos base ─────────────────────────────────────────────────────
      const wh = await trx('commercial.warehouses').where('tenant_id', T).select('id', 'code').limit(2);
      const prods = await trx('catalog.products').where('tenant_id', T).whereNotNull('supplier_id').limit(2);
      ok(wh.length >= 2 && prods.length >= 2, 'data base (≥2 almacenes + 2 productos con proveedor)');
      const [dst, src] = [wh[0].id, wh[1].id];
      const [p1, p2] = prods;
      const supplierId = p1.supplier_id;

      // Existencia inicial conocida en destino.
      const setStock = async (wh_, prod, q) => {
        await trx('commercial.stock').insert({ tenant_id: T, warehouse_id: wh_, product_id: prod, quantity: q, reserved_quantity: 0 })
          .onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge({ quantity: q, reserved_quantity: 0 });
      };
      await setStock(dst, p1.id, 100); await setStock(dst, p2.id, 100);
      await setStock(src, p1.id, 500); // origen del traspaso

      // ── 3. Requisición aprobada (compra) → generar OC ──────────────────────
      const rqFolio = await nextFolio(trx, 'OC', year).then(() => `RQ-${year}-90001`); // folio RQ ficticio único
      const [rq] = await trx('commercial.purchase_requisitions').insert({
        tenant_id: T, warehouse_id: dst, supplier_id: supplierId, folio: rqFolio, estado: 'approved',
        target_basis: 'max', source_type: 'supplier', total_lines: 2, total_units: 60, total_cost: 600,
      }).returning(['id']);
      await trx('commercial.purchase_requisition_lines').insert([
        { tenant_id: T, requisition_id: rq.id, product_id: p1.id, supplier_id: supplierId, final_qty: 40, unit_cost: 10, line_cost: 400 },
        { tenant_id: T, requisition_id: rq.id, product_id: p2.id, supplier_id: supplierId, final_qty: 20, unit_cost: 10, line_cost: 200 },
      ]);

      // createFromRequisition: OC + líneas, RQ→ordered
      const ocFolio = await nextFolio(trx, 'OC', year);
      ok(/^OC-\d{4}-\d{5}$/.test(ocFolio), `folio OC-YYYY-NNNNN (${ocFolio})`);
      const reqLines = await trx('commercial.purchase_requisition_lines').where({ tenant_id: T, requisition_id: rq.id }).select('*');
      const [po] = await trx('commercial.purchase_orders').insert({
        tenant_id: T, folio: ocFolio, warehouse_id: dst, supplier_id: supplierId, source_type: 'supplier',
        requisition_id: rq.id, estado: 'open', target_basis: 'max', total_lines: 2, total_units: 60, total_cost: 600,
      }).returning(['id']);
      await trx('commercial.purchase_order_lines').insert(reqLines.map((l) => ({
        tenant_id: T, purchase_order_id: po.id, product_id: l.product_id, requisition_line_id: l.id,
        ordered_qty: Number(l.final_qty), received_qty: 0, unit_cost: Number(l.unit_cost), line_cost: Number(l.line_cost),
      })));
      await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: rq.id, estado: 'approved' }).update({ estado: 'ordered' });
      const rqAfter = await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: rq.id }).first('estado');
      ok(rqAfter.estado === 'ordered', 'RQ → ordered al generar OC (convertida)');

      const poLines = await trx('commercial.purchase_order_lines').where({ tenant_id: T, purchase_order_id: po.id }).orderBy('product_id');
      const l1 = poLines.find((l) => l.product_id === p1.id);
      const l2 = poLines.find((l) => l.product_id === p2.id);

      // ── 4. Recepción PARCIAL (OE #1): p1 30 de 40 → OC 'partial', stock +30 ──
      const oe1 = await nextFolio(trx, 'OE', year);
      ok(/^OE-\d{4}-\d{5}$/.test(oe1), `folio OE-YYYY-NNNNN (${oe1})`);
      const [gr1] = await trx('commercial.goods_receipts').insert({
        tenant_id: T, folio: oe1, purchase_order_id: po.id, warehouse_id: dst, total_units: 30, total_cost: 300, stock_applied: true,
      }).returning(['id']);
      await trx('commercial.goods_receipt_lines').insert({ tenant_id: T, goods_receipt_id: gr1.id, purchase_order_line_id: l1.id, product_id: p1.id, received_qty: 30, unit_cost: 10, line_cost: 300 });
      const mv1 = await moveStock(trx, dst, p1.id, 'in', 30, gr1.id);
      ok(mv1.before === 100 && mv1.after === 130, `OE mueve stock +30 (100→130)`);
      await trx('commercial.purchase_order_lines').where({ tenant_id: T, id: l1.id }).update({ received_qty: 30 });
      // recompute
      let fresh = await trx('commercial.purchase_order_lines').where({ tenant_id: T, purchase_order_id: po.id });
      let recv = fresh.reduce((s, l) => s + Number(l.received_qty), 0);
      let complete = fresh.every((l) => Number(l.received_qty) >= Number(l.ordered_qty));
      await trx('commercial.purchase_orders').where({ tenant_id: T, id: po.id }).update({ estado: complete ? 'received' : 'partial', received_units: recv });
      let poNow = await trx('commercial.purchase_orders').where({ tenant_id: T, id: po.id }).first();
      ok(poNow.estado === 'partial' && Number(poNow.received_units) === 30, `OC → partial (recibido 30/60)`);

      // ── 5. Recepción FINAL (OE #2): p1 10 + p2 20 → OC 'received', RQ 'received' ─
      const oe2 = await nextFolio(trx, 'OE', year);
      const [gr2] = await trx('commercial.goods_receipts').insert({
        tenant_id: T, folio: oe2, purchase_order_id: po.id, warehouse_id: dst, total_units: 30, total_cost: 300, stock_applied: true,
      }).returning(['id']);
      await trx('commercial.goods_receipt_lines').insert([
        { tenant_id: T, goods_receipt_id: gr2.id, purchase_order_line_id: l1.id, product_id: p1.id, received_qty: 10, unit_cost: 10, line_cost: 100 },
        { tenant_id: T, goods_receipt_id: gr2.id, purchase_order_line_id: l2.id, product_id: p2.id, received_qty: 20, unit_cost: 10, line_cost: 200 },
      ]);
      const mvA = await moveStock(trx, dst, p1.id, 'in', 10, gr2.id);
      const mvB = await moveStock(trx, dst, p2.id, 'in', 20, gr2.id);
      ok(mvA.after === 140 && mvB.after === 120, `OE#2 mueve stock (p1 130→140, p2 100→120)`);
      await trx('commercial.purchase_order_lines').where({ tenant_id: T, id: l1.id }).update({ received_qty: 40 });
      await trx('commercial.purchase_order_lines').where({ tenant_id: T, id: l2.id }).update({ received_qty: 20 });
      fresh = await trx('commercial.purchase_order_lines').where({ tenant_id: T, purchase_order_id: po.id });
      recv = fresh.reduce((s, l) => s + Number(l.received_qty), 0);
      complete = fresh.every((l) => Number(l.received_qty) >= Number(l.ordered_qty));
      await trx('commercial.purchase_orders').where({ tenant_id: T, id: po.id }).update({ estado: complete ? 'received' : 'partial', received_units: recv, closed_at: complete ? trx.fn.now() : null });
      if (complete) await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: rq.id }).whereIn('estado', ['ordered', 'approved']).update({ estado: 'received' });
      poNow = await trx('commercial.purchase_orders').where({ tenant_id: T, id: po.id }).first();
      const rqFinal = await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: rq.id }).first('estado');
      ok(poNow.estado === 'received' && Number(poNow.received_units) === 60, `OC → received (60/60)`);
      ok(rqFinal.estado === 'received', 'RQ → received al completar la OC (traza)');
      const fill = Number(poNow.received_units) / Number(poNow.total_units);
      ok(fill === 1, `fill rate = 100% (${poNow.received_units}/${poNow.total_units})`);

      // 2 OE contra la misma OC
      const nOE = Number((await trx('commercial.goods_receipts').where({ tenant_id: T, purchase_order_id: po.id }).count('* as c').first()).c);
      ok(nOE === 2, 'OC admite recepciones múltiples (2 OE)');

      // ── 6. Traspaso (branch): mueve +destino y −origen ─────────────────────
      const ocT = await nextFolio(trx, 'OC', year);
      const [poT] = await trx('commercial.purchase_orders').insert({
        tenant_id: T, folio: ocT, warehouse_id: dst, source_type: 'branch', source_warehouse_id: src,
        estado: 'open', target_basis: 'max', total_lines: 1, total_units: 50, total_cost: 500,
      }).returning(['id']);
      const [ltl] = await trx('commercial.purchase_order_lines').insert({
        tenant_id: T, purchase_order_id: poT.id, product_id: p1.id, ordered_qty: 50, received_qty: 0, unit_cost: 10, line_cost: 500,
      }).returning(['id']);
      const oeT = await nextFolio(trx, 'OE', year);
      const [grT] = await trx('commercial.goods_receipts').insert({ tenant_id: T, folio: oeT, purchase_order_id: poT.id, warehouse_id: dst, total_units: 50, total_cost: 500, stock_applied: true }).returning(['id']);
      const dstBefore = Number((await trx('commercial.stock').where({ warehouse_id: dst, product_id: p1.id }).first()).quantity);
      const srcBefore = Number((await trx('commercial.stock').where({ warehouse_id: src, product_id: p1.id }).first()).quantity);
      const inMv = await moveStock(trx, dst, p1.id, 'in', 50, grT.id);
      const outMv = await moveStock(trx, src, p1.id, 'out', 50, grT.id);
      ok(inMv.after === dstBefore + 50, `traspaso +destino (${dstBefore}→${inMv.after})`);
      ok(outMv.after === srcBefore - 50, `traspaso −origen (${srcBefore}→${outMv.after})`);

      // clamp: out no deja negativo (pedir más de lo disponible)
      const clamp = await moveStock(trx, src, p1.id, 'out', 999999, grT.id);
      ok(clamp.after >= 0 && clamp.applied <= srcBefore, 'traspaso −origen best-effort (clamp ≥ 0, no bloquea)');

      // (RLS cross-tenant NO se testea aquí: el smoke corre como superuser, que
      //  bypassa RLS aunque esté FORCE. El flag FORCE se verifica arriba; la
      //  aplicación real vía rol app_runtime la cubren los HTTP tenant-isolation tests.)

      await trx.rollback(new Error('smoke rollback (no persiste)'));
    }).catch((e) => { if (!/smoke rollback/.test(e.message)) throw e; });

    console.log(`\nRA.15 purchase-chain smoke: ${pass} OK, ${fail} fallidos`);
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
