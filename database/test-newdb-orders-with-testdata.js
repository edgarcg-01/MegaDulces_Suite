/* eslint-disable no-console */
/**
 * Smoke test del flujo de pedidos usando la testdata cargada vía importer.
 * Toma un customer real (TST-0001), arma un pedido con 4 líneas distintas,
 * lo confirma, fulfillea, y verifica que el stock bajó correctamente.
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

const LINES_TO_ADD = [
  { brand: 'Chocolates Premium', product: 'Trufas Surtidas 12pz', qty: 5 },
  { brand: 'Chocolates Premium', product: 'Barra Chocolate Amargo 70%', qty: 30 },
  { brand: 'Chicles & Gomitas', product: 'Gomitas Frutales 1kg', qty: 8 },
  { brand: 'Paletas y Helados', product: 'Paleta Glaseada Caramelo', qty: 24 },
];

(async () => {
  let orderId;
  const stockBeforeMap = {};

  try {
    // Snapshot de stock antes
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      for (const l of LINES_TO_ADD) {
        const p = await trx('public.products as p')
          .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
          .whereRaw('LOWER(b.nombre) = LOWER(?)', [l.brand])
          .whereRaw('LOWER(p.nombre) = LOWER(?)', [l.product])
          .select('p.id')
          .first();
        const stock = await trx('commercial.stock').where({ product_id: p.id }).first();
        stockBeforeMap[p.id] = { qty: Number(stock.quantity), name: l.product };
      }
    });

    // Crear pedido con 4 líneas
    await knex.transaction(async (trx) => {
      await setCtx(trx);

      // Resolve customer + warehouse
      const customer = await trx('commercial.customers').where({ code: 'TST-0001' }).first();
      const wh = await trx('commercial.warehouses').where({ code: 'MD-CENTRAL' }).first();
      const anyUser = await trx('public.users').limit(1).first();

      // Generate code
      const r = await trx.raw(
        `INSERT INTO commercial.order_sequences (tenant_id, year, current_value)
         VALUES (?, 2026, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE
           SET current_value = commercial.order_sequences.current_value + 1
         RETURNING current_value`,
        [TENANT],
      );
      const code = `PD-2026-${String(r.rows[0].current_value).padStart(5, '0')}`;

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
      console.log(`CREATED ${code} para ${customer.name}`);

      let totalSubtotal = 0;
      let totalTax = 0;
      let lineNum = 1;

      for (const l of LINES_TO_ADD) {
        const product = await trx('public.products as p')
          .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
          .whereRaw('LOWER(b.nombre) = LOWER(?)', [l.brand])
          .whereRaw('LOWER(p.nombre) = LOWER(?)', [l.product])
          .select('p.id', 'p.nombre')
          .first();

        const price = await trx('commercial.product_prices')
          .where({ price_list_id: customer.default_price_list_id, product_id: product.id })
          .first();

        const qty = l.qty;
        const unit = Number(price.price);
        const tax = Number(price.tax_rate);
        const sub = +(qty * unit).toFixed(2);
        const tx = +(sub * tax).toFixed(2);
        const tot = +(sub + tx).toFixed(2);

        await trx('commercial.order_lines').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          order_id: orderId,
          product_id: product.id,
          line_number: lineNum++,
          quantity: qty,
          unit_price: unit,
          tax_rate: tax,
          discount_percent: 0,
          line_subtotal: sub,
          line_tax: tx,
          line_total: tot,
        });
        totalSubtotal += sub;
        totalTax += tx;
        console.log(`  + ${qty}x ${product.nombre} @ ${unit} = ${tot}`);
      }

      await trx('commercial.orders').where({ id: orderId }).update({
        subtotal: totalSubtotal,
        tax_total: totalTax,
        total: totalSubtotal + totalTax,
        balance_due: totalSubtotal + totalTax,
      });
      console.log(`TOTAL: $${(totalSubtotal + totalTax).toFixed(2)} (sub ${totalSubtotal.toFixed(2)} + tax ${totalTax.toFixed(2)})`);
    });

    // CONFIRM: reserve stock for all lines
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const lines = await trx('commercial.order_lines').where({ order_id: orderId });
      const order = await trx('commercial.orders').where({ id: orderId }).first();

      for (const line of lines) {
        const stock = await trx('commercial.stock')
          .where({ warehouse_id: order.warehouse_id, product_id: line.product_id })
          .forUpdate()
          .first();
        const qty = Number(line.quantity);
        if (Number(stock.quantity) - Number(stock.reserved_quantity) < qty) {
          throw new Error(`Stock insuficiente product ${line.product_id}`);
        }
        await trx('commercial.stock').where({ id: stock.id }).update({
          reserved_quantity: Number(stock.reserved_quantity) + qty,
        });
        await trx('commercial.stock_movements').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: order.warehouse_id,
          product_id: line.product_id,
          movement_type: 'reserve',
          quantity: qty,
          quantity_before: Number(stock.quantity),
          quantity_after: Number(stock.quantity),
          reference_type: 'order',
          reference_id: orderId,
        });
      }

      await trx('commercial.orders').where({ id: orderId }).update({
        status: 'confirmed',
        confirmed_at: trx.fn.now(),
      });
      console.log(`CONFIRMED — ${lines.length} líneas con stock reservado`);
    });

    // FULFILL: consume reserves
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const lines = await trx('commercial.order_lines').where({ order_id: orderId });
      const order = await trx('commercial.orders').where({ id: orderId }).first();

      for (const line of lines) {
        const stock = await trx('commercial.stock')
          .where({ warehouse_id: order.warehouse_id, product_id: line.product_id })
          .forUpdate()
          .first();
        const qty = Number(line.quantity);
        await trx('commercial.stock').where({ id: stock.id }).update({
          quantity: Number(stock.quantity) - qty,
          reserved_quantity: Number(stock.reserved_quantity) - qty,
        });
        await trx('commercial.stock_movements').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: order.warehouse_id,
          product_id: line.product_id,
          movement_type: 'sale',
          quantity: qty,
          quantity_before: Number(stock.quantity),
          quantity_after: Number(stock.quantity) - qty,
          reference_type: 'order',
          reference_id: orderId,
        });
      }

      await trx('commercial.orders').where({ id: orderId }).update({
        status: 'fulfilled',
        fulfilled_at: trx.fn.now(),
      });
      console.log(`FULFILLED — stock consumido`);
    });

    // Verify deltas
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      let allOk = true;
      for (const l of LINES_TO_ADD) {
        const p = await trx('public.products as p')
          .leftJoin('public.brands as b', 'b.id', 'p.brand_id')
          .whereRaw('LOWER(b.nombre) = LOWER(?)', [l.brand])
          .whereRaw('LOWER(p.nombre) = LOWER(?)', [l.product])
          .select('p.id')
          .first();
        const stockAfter = await trx('commercial.stock').where({ product_id: p.id }).first();
        const before = stockBeforeMap[p.id];
        const after = Number(stockAfter.quantity);
        const expectedAfter = before.qty - l.qty;
        const ok = after === expectedAfter;
        console.log(`  ${before.name}: ${before.qty} → ${after} (esperado ${expectedAfter}) ${ok ? 'OK' : 'FAIL'}`);
        if (!ok) allOk = false;
      }
      if (!allOk) throw new Error('Stock deltas no coinciden');
    });

    await knex.destroy();
    console.log('SMOKE OK — pedido multi-línea con testdata real');
  } catch (e) {
    console.error('SMOKE FAIL:', e.message);
    await knex.destroy();
    process.exit(1);
  }
})();
