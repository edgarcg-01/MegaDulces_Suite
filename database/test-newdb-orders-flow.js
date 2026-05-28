/* eslint-disable no-console */
/**
 * Smoke test end-to-end del flujo de pedidos B.2.
 *
 * Replica la lógica del CommercialOrdersService usando Knex directo para
 * validar que la SQL emitida funciona contra la DB real. Cubre:
 *
 *   1. Generación de code secuencial vía order_sequences (UPSERT atómico)
 *   2. INSERT draft con tenant_id default
 *   3. INSERT order_line + recalc totals
 *   4. Confirm: reserve stock (con FOR UPDATE) + transición status
 *   5. Fulfill: consume reserved (movement_type='sale') + transición status
 *   6. Verificación final del estado del pedido y movimientos
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL_NEW_RUNTIME,
});

const TENANT = '00000000-0000-0000-0000-00000000d01c';

async function setCtx(trx) {
  await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
}

(async () => {
  let orderId, wh, customer, product, hadPrice = false;

  try {
    // ───── Setup ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      wh = await trx('commercial.warehouses').where({ is_default: true }).first();
      customer = await trx('commercial.customers').where({ code: 'DEMO-001' }).first();
      product = await trx('public.products').limit(1).first();

      await trx('commercial.stock')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: wh.id,
          product_id: product.id,
          quantity: 200,
          reserved_quantity: 0,
        })
        .onConflict(['tenant_id', 'warehouse_id', 'product_id'])
        .merge(['quantity', 'reserved_quantity', 'updated_at']);
      console.log('SETUP: stock 200 de', product.nombre, 'en', wh.code);

      // Asegurar precio del producto
      const price = await trx('commercial.product_prices')
        .where({ price_list_id: customer.default_price_list_id, product_id: product.id })
        .first();
      if (!price) {
        await trx('commercial.product_prices').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          price_list_id: customer.default_price_list_id,
          product_id: product.id,
          price: 12.5,
          tax_rate: 0.16,
          min_qty: 1,
        });
        console.log('SETUP: precio 12.5 creado para producto');
      }
      hadPrice = true;
    });

    // ───── CREATE DRAFT con code secuencial ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const r = await trx.raw(
        `INSERT INTO commercial.order_sequences (tenant_id, year, current_value)
         VALUES (?, 2026, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.order_sequences.current_value + 1
         RETURNING current_value`,
        [TENANT],
      );
      const seq = r.rows[0].current_value;
      const code = `PD-2026-${String(seq).padStart(5, '0')}`;
      console.log('Generated code:', code);

      const anyUser = await trx('public.users').limit(1).first();

      const [order] = await trx('commercial.orders').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        code,
        customer_id: customer.id,
        user_id: anyUser.id,
        warehouse_id: wh.id,
        price_list_id: customer.default_price_list_id,
        status: 'draft',
        payment_method: 'cash',
      }).returning('*');
      orderId = order.id;
      console.log('CREATED draft:', order.code);

      const price = await trx('commercial.product_prices')
        .where({ price_list_id: customer.default_price_list_id, product_id: product.id })
        .first();

      const qty = 10;
      const unitPrice = Number(price.price);
      const taxRate = Number(price.tax_rate);
      const lineSubtotal = +(qty * unitPrice).toFixed(2);
      const lineTax = +(lineSubtotal * taxRate).toFixed(2);
      const lineTotal = +(lineSubtotal + lineTax).toFixed(2);

      await trx('commercial.order_lines').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        order_id: orderId,
        product_id: product.id,
        line_number: 1,
        quantity: qty,
        unit_price: unitPrice,
        tax_rate: taxRate,
        discount_percent: 0,
        line_subtotal: lineSubtotal,
        line_tax: lineTax,
        line_total: lineTotal,
      });

      await trx('commercial.orders').where({ id: orderId }).update({
        subtotal: lineSubtotal,
        tax_total: lineTax,
        total: lineTotal,
        balance_due: lineTotal,
      });
      console.log('ADDED line: qty=' + qty + ' subtotal=' + lineSubtotal + ' total=' + lineTotal);
    });

    // ───── CONFIRM ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const stockBefore = await trx('commercial.stock')
        .where({ warehouse_id: wh.id, product_id: product.id })
        .forUpdate()
        .first();
      console.log(`Stock before: q=${stockBefore.quantity} r=${stockBefore.reserved_quantity}`);

      await trx('commercial.stock').where({ id: stockBefore.id }).update({
        reserved_quantity: Number(stockBefore.reserved_quantity) + 10,
        updated_at: trx.fn.now(),
      });
      await trx('commercial.stock_movements').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        warehouse_id: wh.id,
        product_id: product.id,
        movement_type: 'reserve',
        quantity: 10,
        quantity_before: Number(stockBefore.quantity),
        quantity_after: Number(stockBefore.quantity),
        reference_type: 'order',
        reference_id: orderId,
      });
      await trx('commercial.orders').where({ id: orderId }).update({
        status: 'confirmed',
        confirmed_at: trx.fn.now(),
      });
      console.log('CONFIRMED → 10 reserved');
    });

    // ───── FULFILL ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const stockBefore = await trx('commercial.stock')
        .where({ warehouse_id: wh.id, product_id: product.id })
        .forUpdate()
        .first();

      await trx('commercial.stock').where({ id: stockBefore.id }).update({
        quantity: Number(stockBefore.quantity) - 10,
        reserved_quantity: Number(stockBefore.reserved_quantity) - 10,
      });
      await trx('commercial.stock_movements').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        warehouse_id: wh.id,
        product_id: product.id,
        movement_type: 'sale',
        quantity: 10,
        quantity_before: Number(stockBefore.quantity),
        quantity_after: Number(stockBefore.quantity) - 10,
        reference_type: 'order',
        reference_id: orderId,
      });
      await trx('commercial.orders').where({ id: orderId }).update({
        status: 'fulfilled',
        fulfilled_at: trx.fn.now(),
      });

      const stockAfter = await trx('commercial.stock')
        .where({ warehouse_id: wh.id, product_id: product.id })
        .first();
      console.log(`Stock after: q=${stockAfter.quantity} r=${stockAfter.reserved_quantity}`);
    });

    // ───── Verify ─────
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const order = await trx('commercial.orders').where({ id: orderId }).first();
      const movements = await trx('commercial.stock_movements')
        .where({ reference_type: 'order', reference_id: orderId })
        .orderBy('created_at');
      console.log('FINAL status:', order.status, 'total:', order.total);
      console.log('Movements:', movements.map((m) => `${m.movement_type}:${m.quantity}`).join(' → '));

      if (order.status !== 'fulfilled') throw new Error('status no es fulfilled');
      if (movements.length !== 2) throw new Error('esperaba 2 movements');
      if (movements[0].movement_type !== 'reserve') throw new Error('primer movement no es reserve');
      if (movements[1].movement_type !== 'sale') throw new Error('segundo movement no es sale');
    });

    await knex.destroy();
    console.log('SMOKE OK B.2');
  } catch (e) {
    console.error('SMOKE FAIL:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    await knex.destroy();
    process.exit(1);
  }
})();
