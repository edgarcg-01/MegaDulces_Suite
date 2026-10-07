/* eslint-disable no-console */
/**
 * FIQ.6 (apartado con TTL) — Smoke DB-direct del motor de reservas.
 *
 * Verifica contra DATA REAL, dentro de UNA transacción con ROLLBACK final (cero
 * efecto permanente sobre stock real):
 *   1. Las 3 tablas existen con RLS FORZADO.
 *   2. El folio AP-YYYY-NNNNN sale del UPSERT atómico de reservation_sequences.
 *   3. Apartar INCREMENTA stock.reserved_quantity y baja el disponible exacto,
 *      manteniendo el invariante quantity >= reserved.
 *   4. El cron de expiración (mismo SQL que StockReservationCronService) DEVUELVE
 *      el reserved_quantity y marca released_reason='expired'.
 *   5. Tras liberar, la consulta de activos por teléfono da 0.
 *
 * Replica el accounting de OrderStockService.reserve/release + el cron, sin DI.
 */
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';
const PHONE = '525599990001'; // teléfono de prueba (canónico), nunca real

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

(async () => {
  try {
    // ── 1. Schema + RLS forzado ────────────────────────────────────────────
    for (const t of ['stock_reservations', 'stock_reservation_lines', 'reservation_sequences']) {
      const r = await knex.raw(
        `SELECT relforcerowsecurity FROM pg_class WHERE oid = 'commercial.${t}'::regclass`,
      );
      ok(r.rows[0]?.relforcerowsecurity === true, `commercial.${t} existe con RLS FORZADO`);
    }

    // Producto con disponible holgado en el almacén default activo del tenant.
    const wh = await knex('commercial.warehouses')
      .where({ tenant_id: T, active: true }).whereNull('deleted_at')
      .orderBy('is_default', 'desc').orderBy('name', 'asc').first('id');
    ok(!!wh, 'hay almacén default activo para el tenant');
    if (!wh) throw new Error('no warehouse');

    const stockRow = await knex('commercial.stock')
      .where({ tenant_id: T, warehouse_id: wh.id })
      .whereRaw('quantity - reserved_quantity > 10')
      .first('id', 'product_id', 'quantity', 'reserved_quantity');
    ok(!!stockRow, 'hay stock con disponible > 10 para probar el apartado');
    if (!stockRow) throw new Error('no stock');

    const qty = 5;
    const rBefore = Number(stockRow.reserved_quantity);
    const qBefore = Number(stockRow.quantity);
    console.log(`  producto ${stockRow.product_id}  quantity=${qBefore} reserved=${rBefore} → aparto ${qty}`);

    await knex.transaction(async (trx) => {
      // ── 2. Folio atómico ──────────────────────────────────────────────────
      const [{ current_value }] = await trx.raw(
        `INSERT INTO commercial.reservation_sequences (tenant_id, year, current_value)
         VALUES (?, 2026, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.reservation_sequences.current_value + 1, updated_at = now()
         RETURNING current_value`,
        [T],
      ).then((r) => r.rows);
      const folio = `AP-2026-${String(current_value).padStart(5, '0')}`;
      ok(/^AP-2026-\d{5}$/.test(folio), `folio con formato AP-YYYY-NNNNN (${folio})`);

      // ── 3. Apartar = header + línea + reserva de stock ────────────────────
      const [h] = await trx('commercial.stock_reservations').insert({
        tenant_id: T, folio, phone: PHONE, warehouse_id: wh.id,
        expires_at: new Date(Date.now() + 3600_000), total: qty,
      }).returning(['id']);

      await trx('commercial.stock').where({ id: stockRow.id })
        .update({ reserved_quantity: rBefore + qty });
      await trx('commercial.stock_movements').insert({
        tenant_id: T, warehouse_id: wh.id, product_id: stockRow.product_id,
        movement_type: 'reserve', quantity: qty, quantity_before: qBefore, quantity_after: qBefore,
        reference_type: 'reservation', reference_id: h.id,
      });
      await trx('commercial.stock_reservation_lines').insert({
        tenant_id: T, reservation_id: h.id, product_id: stockRow.product_id,
        warehouse_id: wh.id, quantity: qty, unit_price: 1, line_total: qty,
      });

      const afterReserve = await trx('commercial.stock').where({ id: stockRow.id })
        .first('quantity', 'reserved_quantity');
      ok(Number(afterReserve.reserved_quantity) === rBefore + qty, `reserved subió +${qty}`);
      ok(
        Number(afterReserve.quantity) - Number(afterReserve.reserved_quantity) === qBefore - rBefore - qty,
        'disponible bajó exactamente la cantidad apartada',
      );
      ok(Number(afterReserve.quantity) >= Number(afterReserve.reserved_quantity), 'invariante quantity >= reserved se mantiene');

      const activeBefore = await trx('commercial.stock_reservations')
        .where({ tenant_id: T, phone: PHONE }).whereNull('released_at')
        .where('expires_at', '>', trx.fn.now());
      ok(activeBefore.length === 1, 'consulta de activos por teléfono = 1 (apartado vigente)');

      // ── 4. Cron de expiración (mismo SQL que StockReservationCronService) ──
      await trx('commercial.stock_reservations').where({ id: h.id })
        .update({ expires_at: new Date(Date.now() - 3600_000) }); // vencer

      const expired = await trx('commercial.stock_reservations')
        .whereNull('released_at').where('expires_at', '<', trx.fn.now())
        .andWhere({ id: h.id }).select('id', 'tenant_id');
      ok(expired.length === 1, 'el cron detecta la reserva vencida');

      for (const e of expired) {
        const lines = await trx('commercial.stock_reservation_lines')
          .where({ tenant_id: e.tenant_id, reservation_id: e.id })
          .select('product_id', 'warehouse_id', 'quantity');
        for (const l of lines) {
          const sr = await trx('commercial.stock')
            .where({ tenant_id: e.tenant_id, warehouse_id: l.warehouse_id, product_id: l.product_id })
            .forUpdate().first('id', 'quantity', 'reserved_quantity');
          const rb = Number(sr.reserved_quantity);
          const rel = Math.min(rb, Number(l.quantity));
          if (rel <= 0) continue;
          await trx('commercial.stock').where({ id: sr.id }).update({ reserved_quantity: rb - rel });
          await trx('commercial.stock_movements').insert({
            tenant_id: e.tenant_id, warehouse_id: l.warehouse_id, product_id: l.product_id,
            movement_type: 'release', quantity: rel, quantity_before: Number(sr.quantity),
            quantity_after: Number(sr.quantity), reference_type: 'reservation', reference_id: e.id,
          });
        }
        await trx('commercial.stock_reservations').where({ id: e.id }).whereNull('released_at')
          .update({ released_at: trx.fn.now(), released_reason: 'expired' });
      }

      const afterRelease = await trx('commercial.stock').where({ id: stockRow.id }).first('reserved_quantity');
      ok(Number(afterRelease.reserved_quantity) === rBefore, 'el cron devolvió reserved_quantity al valor original');

      const rel = await trx('commercial.stock_reservations').where({ id: h.id }).first('released_reason', 'released_at');
      ok(rel.released_reason === 'expired' && !!rel.released_at, "reserva marcada released_reason='expired'");

      const activeAfter = await trx('commercial.stock_reservations')
        .where({ tenant_id: T, phone: PHONE }).whereNull('released_at').where('expires_at', '>', trx.fn.now());
      ok(activeAfter.length === 0, 'consulta de activos por teléfono = 0 tras liberar');

      // ── 5. Rollback: sin efecto permanente sobre el stock real ─────────────
      throw { __rollback: true };
    }).catch((e) => { if (!e || !e.__rollback) throw e; });

    const finalStock = await knex('commercial.stock').where({ id: stockRow.id }).first('reserved_quantity');
    ok(Number(finalStock.reserved_quantity) === rBefore, 'ROLLBACK: reserved_quantity real quedó intacto');

    console.log(`\nFIQ.6 reservations: ${pass} ✓ / ${fail} ✗`);
    await knex.destroy();
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('FATAL', e.message || e);
    await knex.destroy();
    process.exit(1);
  }
})();
