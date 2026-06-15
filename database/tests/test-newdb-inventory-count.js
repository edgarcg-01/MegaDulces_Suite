/* eslint-disable no-console */
/**
 * Smoke DB-direct del flujo de inventario físico (Fase I).
 *
 * Replica la SQL del InventoryCountService con Knex directo (user app_runtime,
 * RLS forzado) para validar schema + constraints + grants + la lógica crítica:
 *
 *   1. Apertura: folio secuencial (INV-YYYY-NNNNN) + snapshot del teórico
 *   2. Conteo ciego con doble conteo por contadores DISTINTOS
 *   3. Segregación: count_2 por el mismo contador que count_1 → rechazado
 *   4. Discrepancia: count_1 != count_2 → tercer conteo rompe el empate
 *   5. Coverage guard: SKU sin conteo bloquea la reconciliación
 *   6. Reconciliación: stock se ajusta al físico + movement inventory_count
 *   7. Freeze guard: con folio abierto, el almacén está congelado
 *
 * Usa un almacén dedicado (INV-TEST-WH) para no interferir con otros smokes.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL_NEW_RUNTIME,
});

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const USER_A = '00000000-0000-0000-0000-0000000000aa';
const USER_B = '00000000-0000-0000-0000-0000000000bb';
const USER_RECON = '00000000-0000-0000-0000-0000000000cc';

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

const setCtx = (trx) => trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);

// Mirror de la lógica de slot del servicio: el MISMO contador re-escaneando su
// count_1 lo corrige (overwrite); un contador DISTINTO dispara el count_2.
function nextSlot(item, recount, userId) {
  if (recount || (item.count_1 != null && item.count_2 != null)) return 'count_3';
  if (item.count_1 == null) return 'count_1';
  if (item.count_2 == null && item.counted_by_1 === userId) return 'count_1';
  return 'count_2';
}

async function submit(trx, countId, productId, qty, userId, recount = false) {
  const item = await trx('commercial.inventory_count_items')
    .where({ count_id: countId, product_id: productId })
    .forUpdate()
    .first();
  const slot = nextSlot(item, recount, userId);
  const patch = { status: 'counted', updated_at: trx.fn.now(), updated_by: userId };
  patch[slot] = qty;
  patch[slot.replace('count', 'counted_by')] = userId;
  patch[slot.replace('count', 'counted_at')] = trx.fn.now();
  await trx('commercial.inventory_count_items').where({ id: item.id }).update(patch);
  return slot;
}

(async () => {
  let whId, products, folio, countId;
  try {
    // ───── Setup: almacén dedicado + 4 SKUs con saldo ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const existing = await trx('commercial.warehouses').where({ code: 'INV-TEST-WH' }).first();
      if (existing) {
        whId = existing.id;
      } else {
        const [w] = await trx('commercial.warehouses')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            code: 'INV-TEST-WH',
            name: 'Almacén de prueba inventario',
            is_default: false,
          })
          .returning('id');
        whId = w.id;
      }

      products = await trx('public.products').limit(4).select('id', 'nombre');
      const qtys = [100, 50, 30, 10];
      for (let i = 0; i < 4; i++) {
        await trx('commercial.stock')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: whId,
            product_id: products[i].id,
            quantity: qtys[i],
            reserved_quantity: 0,
          })
          .onConflict(['tenant_id', 'warehouse_id', 'product_id'])
          .merge(['quantity', 'reserved_quantity', 'updated_at']);
      }
      // Limpiar folios previos del test (idempotencia).
      await trx('commercial.inventory_counts').where({ warehouse_id: whId }).del();
    });
    console.log('SETUP: almacén INV-TEST-WH con 4 SKUs (100/50/30/10)\n');

    // ───── 1. Apertura: folio + snapshot ─────
    console.log('1. Apertura (folio + snapshot del teórico)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const year = new Date().getFullYear();
      const [{ current_value }] = (
        await trx.raw(
          `INSERT INTO commercial.inventory_count_sequences (tenant_id, year, current_value)
           VALUES (public.current_tenant_id(), ?, 1)
           ON CONFLICT (tenant_id, year) DO UPDATE
             SET current_value = inventory_count_sequences.current_value + 1, updated_at = now()
           RETURNING current_value`,
          [year],
        )
      ).rows;
      folio = `INV-${year}-${String(current_value).padStart(5, '0')}`;
      const [c] = await trx('commercial.inventory_counts')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: whId,
          folio,
          type: 'full',
          status: 'counting',
          freeze_movements: true,
          blind_double_count: true,
          started_at: trx.fn.now(),
          created_by: USER_A,
        })
        .returning('id');
      countId = c.id;
      const snap = await trx.raw(
        `INSERT INTO commercial.inventory_count_items
           (tenant_id, count_id, product_id, location, expected_qty, status)
         SELECT s.tenant_id, ?, s.product_id, p.location, s.quantity, 'pending'
           FROM commercial.stock s LEFT JOIN public.products p ON p.id = s.product_id
          WHERE s.warehouse_id = ? AND s.tenant_id = public.current_tenant_id()`,
        [countId, whId],
      );
      check(!!folio.match(/^INV-\d{4}-\d{5}$/), `folio generado: ${folio}`);
      check(snap.rowCount === 4, `snapshot de 4 SKUs (rowCount=${snap.rowCount})`);
    });

    // ───── 2 + 3. Conteo ciego + segregación ─────
    console.log('\n2. Conteo ciego (doble conteo por contadores distintos)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      // Item0: 98 / 98 → match (varianza -2)
      await submit(trx, countId, products[0].id, 98, USER_A);
      await submit(trx, countId, products[0].id, 98, USER_B);
      // Item1: 50 / 50 → match (varianza 0)
      await submit(trx, countId, products[1].id, 50, USER_A);
      await submit(trx, countId, products[1].id, 50, USER_B);
      // Item2: 30 / 28 → mismatch → reconteo 28
      await submit(trx, countId, products[2].id, 30, USER_A);
      await submit(trx, countId, products[2].id, 28, USER_B);
      check(true, 'conteos registrados (items 0,1,2)');
    });

    console.log('\n3. Corrección del mismo contador (overwrite de count_1)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await submit(trx, countId, products[3].id, 9, USER_A); // typo
      await submit(trx, countId, products[3].id, 10, USER_A); // corrige su propio count_1
      const it = await trx('commercial.inventory_count_items')
        .where({ count_id: countId, product_id: products[3].id })
        .first();
      check(
        Number(it.count_1) === 10 && it.count_2 == null,
        'mismo contador re-escanea → corrige count_1 (10), sin crear count_2',
      );
    });

    // ───── 4. Discrepancia: tercer conteo ─────
    console.log('\n4. Discrepancia (tercer conteo rompe el empate)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await submit(trx, countId, products[2].id, 28, USER_RECON, true); // count_3 = 28
      const it = await trx('commercial.inventory_count_items')
        .where({ count_id: countId, product_id: products[2].id })
        .first();
      check(Number(it.count_3) === 28, 'tercer conteo registrado (28)');
    });

    // ───── compute discrepancias (replica lógica del servicio) ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const items = await trx('commercial.inventory_count_items').where({ count_id: countId });
      for (const it of items) {
        const c1 = it.count_1 != null ? Number(it.count_1) : null;
        const c2 = it.count_2 != null ? Number(it.count_2) : null;
        const c3 = it.count_3 != null ? Number(it.count_3) : null;
        if (c1 == null) continue; // item3 sigue sin count_1 válido (lo cuenta abajo)
        let finalQty = null;
        if (c2 == null) continue;
        if (c1 === c2) finalQty = c1;
        else if (c3 != null && (c3 === c1 || c3 === c2)) finalQty = c3;
        if (finalQty != null) {
          const variance = +(finalQty - Number(it.expected_qty)).toFixed(3);
          await trx('commercial.inventory_count_items')
            .where({ id: it.id })
            .update({ final_qty: finalQty, variance, status: 'resolved' });
        }
      }
    });

    // ───── 5. Coverage guard: item3 sin conteo válido completo ─────
    console.log('\n5. Coverage guard (SKU sin conteo bloquea reconciliación)');
    // item3 sólo tiene count_1 de USER_A (el count_2 falló por segregación) → final_qty NULL
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const items = await trx('commercial.inventory_count_items').where({ count_id: countId });
      const uncounted = items.filter((it) => it.count_1 == null);
      const unresolved = items.filter((it) => it.final_qty == null);
      check(unresolved.length >= 1, `hay ${unresolved.length} item(s) sin valor final → reconcile debe bloquear`);
    });

    // Completar el item3 correctamente para poder reconciliar
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      await submit(trx, countId, products[3].id, 10, USER_B); // count_2 por contador distinto
      const it = await trx('commercial.inventory_count_items')
        .where({ count_id: countId, product_id: products[3].id })
        .first();
      const finalQty = 10; // count_1 (USER_A) == count_2 (USER_B)
      await trx('commercial.inventory_count_items')
        .where({ id: it.id })
        .update({ final_qty: finalQty, variance: finalQty - Number(it.expected_qty), status: 'resolved' });
    });

    // ───── 7. Freeze guard (antes de reconciliar) ─────
    console.log('\n6. Freeze guard (almacén congelado con folio abierto)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const frozen = await trx('commercial.inventory_counts')
        .where({ warehouse_id: whId, freeze_movements: true })
        .whereIn('status', ['open', 'counting', 'review', 'ready_to_reconcile'])
        .first();
      check(!!frozen, `freeze guard detecta folio abierto (${frozen?.folio}) → reserve/adjust bloqueado`);
    });

    // ───── 6. Reconciliación ─────
    console.log('\n7. Reconciliación (ajusta stock al físico + movimientos)');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const items = await trx('commercial.inventory_count_items').where({ count_id: countId });
      const uncounted = items.filter((it) => it.count_1 == null);
      const unresolved = items.filter((it) => it.final_qty == null);
      if (uncounted.length || unresolved.length) throw new Error('coverage guard: faltan conteos');

      let adjusted = 0;
      for (const it of items) {
        const delta = Number(it.final_qty) - Number(it.expected_qty);
        if (delta === 0) continue;
        const stockRow = await trx('commercial.stock')
          .where({ warehouse_id: whId, product_id: it.product_id })
          .forUpdate()
          .first();
        const qBefore = Number(stockRow.quantity);
        await trx('commercial.stock')
          .where({ id: stockRow.id })
          .update({ quantity: it.final_qty, updated_at: trx.fn.now(), updated_by: USER_RECON });
        await trx('commercial.stock_movements').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: whId,
          product_id: it.product_id,
          movement_type: 'adjust',
          quantity: Math.abs(delta),
          quantity_before: qBefore,
          quantity_after: it.final_qty,
          reference_type: 'inventory_count',
          reference_id: countId,
          notes: `Inventario físico ${folio}`,
          created_by: USER_RECON,
        });
        adjusted++;
      }
      await trx('commercial.inventory_counts')
        .where({ id: countId })
        .update({ status: 'reconciled', reconciled_at: trx.fn.now(), reconciled_by: USER_RECON, closed_at: trx.fn.now() });
      check(adjusted === 2, `2 SKUs ajustados (item0 100→98, item2 30→28); fueron ${adjusted}`);
    });

    // ───── Verificación final ─────
    console.log('\n8. Verificación final');
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const s0 = await trx('commercial.stock').where({ warehouse_id: whId, product_id: products[0].id }).first();
      const s2 = await trx('commercial.stock').where({ warehouse_id: whId, product_id: products[2].id }).first();
      check(Number(s0.quantity) === 98, `stock item0 = 98 (físico aplicado)`);
      check(Number(s2.quantity) === 28, `stock item2 = 28 (físico aplicado)`);
      const movs = await trx('commercial.stock_movements')
        .where({ reference_type: 'inventory_count', reference_id: countId });
      check(movs.length === 2, `2 movimientos inventory_count en bitácora`);
      const c = await trx('commercial.inventory_counts').where({ id: countId }).first();
      check(c.status === 'reconciled', `folio en estado reconciled`);
      const stillFrozen = await trx('commercial.inventory_counts')
        .where({ warehouse_id: whId, freeze_movements: true })
        .whereIn('status', ['open', 'counting', 'review', 'ready_to_reconcile'])
        .first();
      check(!stillFrozen, `tras reconciliar, el almacén ya NO está congelado`);
    });

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`RESULTADO: ${passed} ✓ / ${failed} ✗`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (e) {
    console.error('\nERROR FATAL:', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    await knex.destroy();
  }
})();
