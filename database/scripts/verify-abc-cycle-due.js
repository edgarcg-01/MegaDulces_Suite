/* eslint-disable no-console */
// ABC.1 — valida el SQL de cycle-due (CTEs + interval + cadencia + orden) READ-ONLY.
// Inserta 2 filas abc sintéticas en una trx que se ROLLBACK. El script bypassa RLS →
// filtro tenant explícito (en el servicio lo hace RLS).
//   node database/scripts/verify-abc-cycle-due.js
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const MEGA = '00000000-0000-0000-0000-00000000d01c';
const C = { A: 30, B: 90, C: 365 };

(async () => {
  let ok = true;
  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${MEGA}'`);
      // 2 productos DISTINTOS del MISMO almacén (FK-válidos, sin chocar el unique)
      const whRow = await trx('commercial.stock').where({ tenant_id: MEGA })
        .select('warehouse_id').groupBy('warehouse_id').havingRaw('count(distinct product_id) >= 2').first();
      if (!whRow) throw new Error('ningún almacén con >=2 productos');
      const wh = whRow.warehouse_id;
      const prodRows = await trx('commercial.stock').where({ tenant_id: MEGA, warehouse_id: wh }).distinct('product_id').limit(2);
      const prods = prodRows.map((r) => r.product_id);
      if (prods.length < 2) throw new Error('necesito 2 productos distintos en un almacén');
      const rows = [
        { tenant_id: MEGA, warehouse_id: wh, product_id: prods[0], abc_class: 'A', annual_value: 1000, units_window: 50, value_share: 0.5, window_days: 90 },
        { tenant_id: MEGA, warehouse_id: wh, product_id: prods[1], abc_class: 'C', annual_value: 0, units_window: 0, value_share: 1, window_days: 90 },
      ];
      // evitar choque de unique (tenant,wh,product) si ya existieran
      await trx('commercial.abc_classification').where({ warehouse_id: wh }).whereIn('product_id', rows.map((r) => r.product_id)).del();
      await trx('commercial.abc_classification').insert(rows);

      const dueExpr = `(r.last_counted_at IS NULL OR r.last_counted_at + (r.cadence_days || ' days')::interval <= now())`;
      const { rows: out } = await trx.raw(
        `
        WITH last_counted AS (
          SELECT c.warehouse_id, i.product_id, MAX(c.reconciled_at) AS last_counted_at
            FROM commercial.inventory_counts c
            JOIN commercial.inventory_count_items i ON i.count_id = c.id AND i.tenant_id = c.tenant_id
           WHERE c.status = 'reconciled' AND i.product_id IS NOT NULL AND c.tenant_id = ?
           GROUP BY c.warehouse_id, i.product_id
        ),
        ranked AS (
          SELECT a.warehouse_id, a.product_id, a.abc_class, a.annual_value, lc.last_counted_at,
                 (CASE a.abc_class WHEN 'A' THEN ${C.A} WHEN 'B' THEN ${C.B} ELSE ${C.C} END) AS cadence_days
            FROM commercial.abc_classification a
            LEFT JOIN last_counted lc ON lc.warehouse_id = a.warehouse_id AND lc.product_id = a.product_id
            WHERE a.tenant_id = ? AND a.warehouse_id = ?
        )
        SELECT r.abc_class, r.cadence_days, r.last_counted_at,
               (r.last_counted_at + (r.cadence_days || ' days')::interval) AS next_due,
               ${dueExpr} AS is_due
          FROM ranked r
         ORDER BY CASE r.abc_class WHEN 'A' THEN 1 WHEN 'B' THEN 2 ELSE 3 END, r.last_counted_at ASC NULLS FIRST
        `,
        [MEGA, MEGA, wh],
      );

      console.log(`  Filas: ${out.length} (esperado 2)`);
      const a = out.find((x) => x.abc_class === 'A');
      const c = out.find((x) => x.abc_class === 'C');
      if (out.length !== 2) { console.log('  FAIL: no son 2 filas'); ok = false; }
      if (out[0]?.abc_class !== 'A') { console.log('  FAIL: orden — A no va primero'); ok = false; }
      if (Number(a?.cadence_days) !== 30) { console.log(`  FAIL: cadencia A=${a?.cadence_days} (esperado 30)`); ok = false; }
      if (Number(c?.cadence_days) !== 365) { console.log(`  FAIL: cadencia C=${c?.cadence_days} (esperado 365)`); ok = false; }
      if (a?.is_due !== true || c?.is_due !== true) { console.log('  FAIL: nunca contado debe ser is_due=true'); ok = false; }
      if (a?.next_due !== null) { console.log('  FAIL: nunca contado → next_due null'); ok = false; }
      if (ok) console.log('  OK: 2 filas, orden A→C, cadencia 30/365, nunca-contado due=true + next_due null');

      throw new Error('__ROLLBACK__');
    });
  } catch (e) {
    if (e.message !== '__ROLLBACK__') { console.error('FATAL:', e.message); ok = false; }
  }
  await knex.destroy();
  console.log(ok ? '\n✅ PASS (SQL cycle-due válido)' : '\n❌ FAIL');
  process.exit(ok ? 0 : 1);
})();
