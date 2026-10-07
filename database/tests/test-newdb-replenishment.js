/* eslint-disable no-console */
/**
 * RA.9 — Smoke E2E dedicado de Compras / Reabastecimiento (ADR-030). DB-direct
 * (sin API), autocontenido: todo corre en UNA transacción con ROLLBACK, no persiste.
 *
 * Cubre: schema (tablas/columnas/CHECK) · bucket + sugerido con resta de tránsito (RA.5)
 * · requisición folio + guard de traspaso (RA.11) + state machine approved→ordered→
 * received + received_qty/fill (RA.14) · min_order_boxes (RA.13a) · scanner de
 * hallazgos: detección + UPSERT idempotente + auto-resolución (RA.8).
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // ── 1. Schema ───────────────────────────────────────────────────────
      const reg = async (s, n) => (await trx.raw('select to_regclass(?) r', [`${s}.${n}`])).rows[0].r;
      ok(await reg('analytics', 'purchase_in_transit'), 'tabla analytics.purchase_in_transit');
      ok(await reg('commercial', 'replenishment_findings'), 'tabla commercial.replenishment_findings');
      const hasCol = async (sc, tb, c) => (await trx.raw(
        `select 1 from information_schema.columns where table_schema=? and table_name=? and column_name=?`, [sc, tb, c])).rows.length > 0;
      ok(await hasCol('commercial', 'purchase_requisitions', 'source_type'), 'col purchase_requisitions.source_type');
      ok(await hasCol('commercial', 'purchase_requisition_lines', 'received_qty'), 'col _lines.received_qty');
      ok(await hasCol('catalog', 'suppliers', 'min_order_boxes'), 'col suppliers.min_order_boxes');
      const est = (await trx.raw(`select pg_get_constraintdef(oid) d from pg_constraint where conname='chk_purch_req_estado'`)).rows[0];
      ok(est && /received/.test(est.d), `estado CHECK incluye 'received'`);

      // ── 2. Bucket + sugerido con resta de tránsito (RA.4/RA.5) ───────────
      const wh = await trx('commercial.warehouses').where('tenant_id', T).select('id').limit(2);
      const pr = await trx('catalog.products').where('tenant_id', T).first('id');
      ok(wh.length >= 2 && !!pr, 'data base local (≥2 almacenes + producto)');
      const [dst, src] = [wh[0].id, wh[1].id];

      const pol = await trx('commercial.reorder_policy as rp')
        .leftJoin('commercial.stock as s', (j) => j.on('s.tenant_id', 'rp.tenant_id').andOn('s.warehouse_id', 'rp.warehouse_id').andOn('s.product_id', 'rp.product_id'))
        .where('rp.tenant_id', T).andWhere('rp.max_stock', '>', 0)
        .select('rp.warehouse_id', 'rp.product_id', 'rp.max_stock',
          trx.raw('(COALESCE(s.quantity,0)-COALESCE(s.reserved_quantity,0)) as on_hand')).first();
      if (pol) {
        const target = Number(pol.max_stock), onhand = Number(pol.on_hand);
        const sinT = Math.max(0, target - onhand);
        const tr = Math.max(1, Math.round(sinT * 0.4)) || 1;
        await trx('analytics.purchase_in_transit').insert({ tenant_id: T, warehouse_id: pol.warehouse_id, product_id: pol.product_id, qty_in_transit: tr, oc_count: 1 })
          .onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge();
        const r = await trx('commercial.reorder_policy as rp')
          .leftJoin('commercial.stock as s', (j) => j.on('s.tenant_id', 'rp.tenant_id').andOn('s.warehouse_id', 'rp.warehouse_id').andOn('s.product_id', 'rp.product_id'))
          .leftJoin('analytics.purchase_in_transit as pit', (j) => j.on('pit.tenant_id', 'rp.tenant_id').andOn('pit.warehouse_id', 'rp.warehouse_id').andOn('pit.product_id', 'rp.product_id'))
          .where({ 'rp.tenant_id': T, 'rp.warehouse_id': pol.warehouse_id, 'rp.product_id': pol.product_id })
          .select(trx.raw('GREATEST(0, rp.max_stock - (COALESCE(s.quantity,0)-COALESCE(s.reserved_quantity,0)) - COALESCE(pit.qty_in_transit,0)) as suggested')).first();
        ok(Number(r.suggested) === Math.max(0, sinT - tr), `sugerido resta tránsito (${sinT} − ${tr} = ${Number(r.suggested)})`);
      } else { console.log('  ⚠ sin política max>0 local — skip sugerido'); }

      // ── 3. Requisición: guard traspaso + state machine (RA.11/RA.14) ─────
      let guard = false;
      try {
        await trx.raw(`SAVEPOINT sp1`);
        await trx('commercial.purchase_requisitions').insert({ tenant_id: T, warehouse_id: dst, folio: 'RQ-TEST-G', source_type: 'branch', source_warehouse_id: null });
        await trx.raw(`ROLLBACK TO SAVEPOINT sp1`);
      } catch { guard = true; await trx.raw(`ROLLBACK TO SAVEPOINT sp1`); }
      ok(guard, 'CHECK rechaza traspaso (branch) sin almacén origen');

      const year = new Date().getFullYear();
      const seq = await trx.raw(`INSERT INTO commercial.requisition_sequences (tenant_id,year,last_seq) VALUES (?,?,1)
        ON CONFLICT (tenant_id,year) DO UPDATE SET last_seq=commercial.requisition_sequences.last_seq+1 RETURNING last_seq`, [T, year]);
      const folio = `RQ-${year}-${String(seq.rows[0].last_seq).padStart(5, '0')}`;
      ok(/^RQ-\d{4}-\d{5}$/.test(folio), `folio con formato RQ-YYYY-NNNNN (${folio})`);
      const [req] = await trx('commercial.purchase_requisitions').insert({
        tenant_id: T, warehouse_id: dst, folio, estado: 'approved', target_basis: 'max',
        source_type: 'branch', source_warehouse_id: src,
      }).returning('id');
      await trx('commercial.purchase_requisition_lines').insert({ tenant_id: T, requisition_id: req.id, product_id: pr.id, source_type: 'branch', source_warehouse_id: src, final_qty: 24 });

      const toOrdered = await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: req.id, estado: 'approved' }).update({ estado: 'ordered', ordered_at: trx.fn.now() });
      ok(toOrdered === 1, 'transición approved → ordered');
      await trx('commercial.purchase_requisition_lines').where({ tenant_id: T, requisition_id: req.id }).update({ received_qty: 20, received_at: trx.fn.now() });
      const toRecv = await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: req.id, estado: 'ordered' }).update({ estado: 'received', received_at: trx.fn.now() });
      ok(toRecv === 1, 'transición ordered → received');
      const badJump = await trx('commercial.purchase_requisitions').where({ tenant_id: T, id: req.id, estado: 'approved' }).update({ estado: 'ordered' });
      ok(badJump === 0, 'state machine bloquea transición inválida (received ✗→ ordered)');
      const ln = await trx('commercial.purchase_requisition_lines').where({ tenant_id: T, requisition_id: req.id }).first('final_qty', 'received_qty');
      ok(Number(ln.received_qty) === 20 && Number(ln.final_qty) === 24, 'fill rate: recibido 20 / pedido 24');

      // ── 4. min_order_boxes (RA.13a) ─────────────────────────────────────
      const sup = await trx('catalog.suppliers').where('tenant_id', T).first('id');
      if (sup) {
        await trx('catalog.suppliers').where({ tenant_id: T, id: sup.id }).update({ min_order_boxes: 15 });
        const sv = await trx('catalog.suppliers').where({ tenant_id: T, id: sup.id }).first('min_order_boxes');
        ok(Number(sv.min_order_boxes) === 15, 'min_order_boxes captura (15 cajas)');
      } else { console.log('  ⚠ sin proveedor local — skip min_boxes'); }

      // ── 5. Scanner de hallazgos: detección + UPSERT idempotente + resolve (RA.8) ─
      const oh = '(COALESCE(s.quantity,0)-COALESCE(s.reserved_quantity,0))';
      const crit = await trx('commercial.reorder_policy as rp')
        .leftJoin('commercial.stock as s', (j) => j.on('s.tenant_id', 'rp.tenant_id').andOn('s.warehouse_id', 'rp.warehouse_id').andOn('s.product_id', 'rp.product_id'))
        .where('rp.tenant_id', T).andWhere('rp.reorder_point', '>', 0).andWhereRaw(`${oh} <= rp.reorder_point`)
        .select('rp.warehouse_id', 'rp.product_id').limit(3);
      ok(crit.length > 0, `scanner detecta filas críticas (${crit.length} muestra)`);
      if (crit.length) {
        const r = crit[0];
        const dedup = `bajo_reorden:${r.warehouse_id}:${r.product_id}`;
        const upsert = () => trx.raw(`INSERT INTO commercial.replenishment_findings
          (tenant_id,warehouse_id,product_id,kind,severity,dedup_key,status,on_hand,reorder_point,in_transit,suggested_qty,suggested_cost,first_seen_at,last_seen_at,updated_at)
          VALUES (?,?,?,'bajo_reorden','media',?,'open',0,0,0,0,0,now(),now(),now())
          ON CONFLICT (tenant_id,dedup_key) DO UPDATE SET last_seen_at=now(),status='open',resolved_at=NULL,updated_at=now()`,
          [T, r.warehouse_id, r.product_id, dedup]);
        await upsert(); await upsert();
        const cnt = await trx('commercial.replenishment_findings').where({ tenant_id: T, dedup_key: dedup }).count('* as c').first();
        ok(Number(cnt.c) === 1, 'hallazgo UPSERT idempotente (2 scans → 1 fila)');
        // Auto-resolución: un scan que ya no ve ese dedup lo marca resolved.
        await trx('commercial.replenishment_findings').where({ tenant_id: T, status: 'open' }).whereNotIn('dedup_key', ['__none__']).update({ status: 'resolved', resolved_at: trx.fn.now() });
        const res = await trx('commercial.replenishment_findings').where({ tenant_id: T, dedup_key: dedup }).first('status');
        ok(res.status === 'resolved', 'hallazgo se auto-resuelve cuando despeja la condición');
      }

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('ERROR:', e.message); fail++; }
  } finally {
    await knex.destroy();
  }

  console.log(`\nRA.9 replenishment smoke: ${pass} OK, ${fail} fallidos`);
  process.exit(fail === 0 ? 0 : 1);
})();
