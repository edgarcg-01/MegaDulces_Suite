/* eslint-disable no-console */
/**
 * Candado de "Corregir un pedido agendado" (reopen: confirmed -> draft).
 *
 * Lo que se juega aca no es la transicion de estado, es el STOCK. Al reabrir hay
 * que devolver lo que ese pedido aparto -- ni mas ni menos. Y la trampa es que en
 * PREVENTA place() NO reserva nada (mira isPreventa), asi que restar la cantidad
 * de la linea le estaria soltando el apartado a OTRO pedido.
 *
 * Por eso reopen() no mira las lineas: netea el LIBRO DE MOVIMIENTOS
 * (reserve - release con ese reference_id). Este archivo corre esa misma SQL
 * contra la DB real y comprueba las dos ramas, con su prueba negativa:
 *
 *   1. Pedido que SI reservo   -> netea 10, la existencia vuelve exacta al baseline.
 *   2. Pedido de PREVENTA      -> netea vacio, no se libera nada...
 *      ...y la prueba negativa: el criterio ingenuo (la cantidad de la linea) SI
 *      habria liberado, y lo que se llevaba era la reserva del pedido vecino.
 *
 * Corre contra DATABASE_URL_NEW_RUNTIME (platform_test), nunca contra prod.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
const knex = require('knex')({
  client: 'pg',
  connection: process.env.DATABASE_URL_NEW_RUNTIME,
});

const TENANT = '00000000-0000-0000-0000-00000000d01c';
const setCtx = (trx) => trx.raw("SET LOCAL app.tenant_id = '" + TENANT + "'");

let fallas = 0;
function check(nombre, ok, detalle) {
  console.log((ok ? '  OK  ' : ' FALLA') + ' ' + nombre + (detalle ? ' -- ' + detalle : ''));
  if (!ok) fallas++;
}

/** La MISMA SQL que usa reopen() para saber que aparto este pedido. */
function apartadoNeto(trx, orderId) {
  return trx('commercial.stock_movements')
    .where({ reference_type: 'order', reference_id: orderId })
    .whereIn('movement_type', ['reserve', 'release'])
    .groupBy('product_id')
    .select('product_id')
    .sum({
      neto: trx.raw("CASE WHEN movement_type = 'reserve' THEN quantity ELSE -quantity END"),
    });
}

(async () => {
  const creados = { orders: [], stock: null };
  try {
    await knex.transaction(async (trx) => {
      await setCtx(trx);
      const wh = await trx('commercial.warehouses').where({ is_default: true }).first();
      const customer = await trx('commercial.customers').where({ code: 'DEMO-001' }).first();
      const product = await trx('public.products').limit(1).first();
      const vendedor = await trx('public.users').whereNull('deleted_at').first();
      if (!wh || !customer || !product || !vendedor)
        throw new Error('falta baseline (warehouse/customer/product/user)');

      // ----- Baseline de existencia -----
      await trx('commercial.stock')
        .insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          warehouse_id: wh.id,
          product_id: product.id,
          quantity: 500,
          reserved_quantity: 0,
        })
        .onConflict(['tenant_id', 'warehouse_id', 'product_id'])
        .merge({ quantity: 500, reserved_quantity: 0 });
      creados.stock = { warehouse_id: wh.id, product_id: product.id };

      const nuevoPedido = async (code, preventa) => {
        const [o] = await trx('commercial.orders')
          .insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            code,
            customer_id: customer.id,
            warehouse_id: wh.id,
            user_id: vendedor.id,
            status: 'draft',
            subtotal: 0,
            tax_total: 0,
            total: 0,
            balance_due: 0,
            requested_delivery_date: preventa ? '2030-01-15' : null,
          })
          .returning('*');
        await trx('commercial.order_lines').insert({
          tenant_id: trx.raw('public.current_tenant_id()'),
          order_id: o.id,
          line_number: 1,
          product_id: product.id,
          quantity: 10,
          unit_price: 10,
          line_subtotal: 100,
          line_tax: 0,
          line_total: 100,
        });
        creados.orders.push(o.id);
        return o;
      };

      const sello = Date.now().toString().slice(-8);
      const conReserva = await nuevoPedido('RO-A-' + sello, false);
      const preventa = await nuevoPedido('RO-B-' + sello, true);

      // ----- place(): solo el NO-preventa reserva -----
      await trx('commercial.stock')
        .where({ warehouse_id: wh.id, product_id: product.id })
        .update({ reserved_quantity: 10 });
      await trx('commercial.stock_movements').insert({
        tenant_id: trx.raw('public.current_tenant_id()'),
        warehouse_id: wh.id,
        product_id: product.id,
        movement_type: 'reserve',
        quantity: 10,
        quantity_before: 500,
        quantity_after: 500,
        reference_type: 'order',
        reference_id: conReserva.id,
      });
      await trx('commercial.orders')
        .whereIn('id', [conReserva.id, preventa.id])
        .update({ status: 'confirmed', confirmed_at: trx.fn.now() });

      // ----- 1. El pedido que SI aparto -----
      const netoA = await apartadoNeto(trx, conReserva.id);
      check(
        'el que reservo netea exactamente lo apartado',
        netoA.length === 1 && Number(netoA[0].neto) === 10,
        'filas=' + netoA.length + ' neto=' + (netoA[0] ? netoA[0].neto : '-'),
      );

      const stAntes = await trx('commercial.stock').where(creados.stock).first();
      for (const r of netoA) {
        const neto = Number(r.neto);
        if (neto > 0) {
          const row = await trx('commercial.stock')
            .where({ warehouse_id: wh.id, product_id: r.product_id })
            .forUpdate()
            .first();
          const libera = Math.min(Number(row.reserved_quantity), neto);
          await trx('commercial.stock')
            .where({ id: row.id })
            .update({ reserved_quantity: Number(row.reserved_quantity) - libera });
          await trx('commercial.stock_movements').insert({
            tenant_id: trx.raw('public.current_tenant_id()'),
            warehouse_id: wh.id,
            product_id: r.product_id,
            movement_type: 'release',
            quantity: libera,
            quantity_before: Number(row.quantity),
            quantity_after: Number(row.quantity),
            reference_type: 'order',
            reference_id: conReserva.id,
          });
        }
      }
      const stDespues = await trx('commercial.stock').where(creados.stock).first();
      check(
        'al reabrir, la existencia vuelve EXACTA al baseline',
        Number(stAntes.reserved_quantity) === 10 && Number(stDespues.reserved_quantity) === 0,
        'reservado ' + stAntes.reserved_quantity + ' -> ' + stDespues.reserved_quantity,
      );

      // Ya neteado, un segundo reopen no vuelve a liberar (reserve - release = 0).
      const netoA2 = await apartadoNeto(trx, conReserva.id);
      check(
        'reabrir dos veces NO libera dos veces',
        netoA2.every((r) => Number(r.neto) <= 0),
        'neto=' + netoA2.map((r) => r.neto).join(','),
      );

      // ----- 2. El de preventa: nunca aparto nada -----
      // Se le devuelve al vecino su reserva para que haya algo que robar.
      await trx('commercial.stock').where(creados.stock).update({ reserved_quantity: 10 });
      const netoB = await apartadoNeto(trx, preventa.id);
      check('el de preventa no netea nada que liberar', netoB.length === 0, 'filas=' + netoB.length);

      // PRUEBA NEGATIVA: el criterio ingenuo -- restar la cantidad de la LINEA,
      // que es lo que hace cancel() hoy -- si habria liberado, y lo liberado no
      // era suyo: era la reserva del pedido de al lado.
      const lineasB = await trx('commercial.order_lines').where({ order_id: preventa.id });
      const ingenuo = lineasB.reduce((s, l) => s + Number(l.quantity), 0);
      const stVecino = await trx('commercial.stock').where(creados.stock).first();
      check(
        '(negativa) el criterio por LINEA si habria soltado reserva ajena',
        ingenuo > 0 && Math.min(Number(stVecino.reserved_quantity), ingenuo) === 10,
        'linea=' + ingenuo + ' reservado ajeno=' + stVecino.reserved_quantity,
      );

      // ----- 3. El folio se conserva: es el mismo pedido -----
      const [reabierto] = await trx('commercial.orders')
        .where({ id: conReserva.id })
        .update({ status: 'draft', confirmed_at: null, pending_approval_at: null })
        .returning('*');
      check(
        'reabrir conserva el folio',
        reabierto.code === conReserva.code,
        conReserva.code + ' -> ' + reabierto.code,
      );
      check('reabrir deja el pedido editable', reabierto.status === 'draft', reabierto.status);

      // ----- Limpieza -----
      await trx('commercial.stock_movements').whereIn('reference_id', creados.orders).del();
      await trx('commercial.order_lines').whereIn('order_id', creados.orders).del();
      await trx('commercial.orders').whereIn('id', creados.orders).del();
      await trx('commercial.stock').where(creados.stock).update({ reserved_quantity: 0 });
    });

    await knex.destroy();
    if (fallas) {
      console.error('SMOKE FAIL reopen: ' + fallas + ' fallas');
      process.exit(1);
    }
    console.log('SMOKE OK reopen');
  } catch (e) {
    console.error('SMOKE FAIL reopen:', e.message);
    if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
    await knex.destroy();
    process.exit(1);
  }
})();
