/* eslint-disable no-console */
/**
 * CANDADO — EL POOL Y LA OLA (Fase SU.2, ADR-067).
 *
 * Primera pieza del tramo de almacén que faltaba: entre "el pedido está autorizado" y "la
 * mercancía sube al camión" no había nada.
 *
 * ── Qué mide, y por qué cada bloque existe ───────────────────────────────────────────────────
 *
 *   1. El pool es DERIVADO: muestra los confirmados sin ola. Un pedido en borrador no está.
 *   2. ⭐ Armar la ola SACA al pedido del pool. Si no, dos jefes de almacén lo surten dos veces.
 *   3. ⭐⭐ El consolidado por SKU suma entre pedidos **y dice en qué unidad**, conservando el
 *      desglose por pedido. Las dos mitades importan: sin unidad es ADR-055 mudado al almacén
 *      ($866,805 de sobre-pedido ya pagados); sin desglose no se puede desconsolidar después.
 *   4. ⭐ Unidad MIXTA: si dos pedidos capturaron el mismo SKU en unidades distintas, NO se
 *      inventa un total común — se declara `unidad_mixta` (ADR-056: lo que no se puede expresar
 *      se declara, no se dibuja).
 *   5. Un pedido no entra a dos olas vivas, y el rechazo NOMBRA cuál (un 23505 crudo no le dice
 *      nada al jefe de almacén).
 *   6. Cancelar la ola DEVUELVE los pedidos al pool. Es la prueba de que el índice único parcial
 *      no los deja presos: si se marcara en vez de borrar, el pedido quedaría preso por una ola
 *      que ya no existe.
 *   7. PRUEBA NEGATIVA del alcance: pedidos de OTRO almacén se rechazan (una ola es un recorrido,
 *      y no se puede recorrer dos almacenes).
 *   8. ⛔ NO se aparta stock (decisión de Edgar 2026-09-17): armar una ola deja `commercial.stock`
 *      intacto. Si algún día alguien mete una reserva acá, este bloque se pone rojo.
 *
 * Requisitos: API en :3334 con ENABLE_MULTITENANT=true y las migs 20260917140000/140100.
 * Correr: node database/tests/http-picking-pool-test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
require('./_lib/assert-safe-target').assertSafeTarget('http-picking-pool-test');
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, skip = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
};
const nomedido = (name, why) => { console.log(`  ○ NO MEDIDO — ${name}: ${why}`); skip++; };

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* sin cuerpo */ }
  return { status: r.status, body: json };
}
const manana = () => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

const ordersCreados = [];
const wavesCreadas = [];

(async () => {
  let exitCode = 1;
  try {
    console.log('── 1. Login ──');
    const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
    const token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) throw new Error('sin token');

    console.log('── 2. Setup: 2 pedidos confirmados del mismo almacén ──');
    const wh = await knex('commercial.warehouses').where({ tenant_id: T, is_default: true }).first();
    let customer = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('default_price_list_id').first();
    if (!customer) customer = await knex('commercial.customers').where({ tenant_id: T }).first();
    const defaultList = await knex('commercial.price_lists').where({ tenant_id: T, is_default: true }).first();
    const priceListId = customer?.default_price_list_id || defaultList?.id;
    check('setup base', !!wh && !!customer && !!priceListId);
    if (!wh || !customer || !priceListId) throw new Error('setup incompleto');

    // Dos productos: uno compartido (para consolidar) y otro exclusivo.
    const prods = await knex('public.products').limit(2);
    check('hay 2 productos', prods.length === 2);
    for (const p of prods) {
      await knex('commercial.product_prices')
        .insert({ tenant_id: T, price_list_id: priceListId, product_id: p.id, price: 10, tax_rate: 0.16, min_qty: 1 })
        .onConflict(['tenant_id', 'price_list_id', 'product_id']).merge(['price', 'tax_rate', 'min_qty']);
      await knex('commercial.stock')
        .insert({ tenant_id: T, warehouse_id: wh.id, product_id: p.id, quantity: 100000, reserved_quantity: 0 })
        .onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge(['quantity']);
    }

    const armaPedido = async (lineas) => {
      const d = await req('POST', '/commercial/orders', { customer_id: customer.id, warehouse_id: wh.id, delivery_type: 'route' }, token);
      const id = d.body?.id;
      if (id) ordersCreados.push(id);
      for (const l of lineas) await req('POST', `/commercial/orders/${id}/lines`, l, token);
      const placed = await req('POST', `/commercial/orders/${id}/place`, { requested_delivery_date: manana() }, token);
      return { id, code: placed.body?.code, status: placed.body?.status };
    };

    const o1 = await armaPedido([
      { product_id: prods[0].id, quantity: 5 },
      { product_id: prods[1].id, quantity: 3 },
    ]);
    const o2 = await armaPedido([{ product_id: prods[0].id, quantity: 8 }]);
    check('pedido 1 confirmado', o1.status === 'confirmed', o1);
    check('pedido 2 confirmado', o2.status === 'confirmed', o2);

    // Un borrador, que NO debe aparecer en el pool.
    const draft = await req('POST', '/commercial/orders', { customer_id: customer.id, warehouse_id: wh.id, delivery_type: 'route' }, token);
    if (draft.body?.id) ordersCreados.push(draft.body.id);

    console.log('── 3. El pool muestra lo confirmado y sin ola ──');
    const pool1 = await req('GET', `/almacen/surtido/pool?warehouse_id=${wh.id}`, null, token);
    check('pool 200', pool1.status === 200, pool1.status);
    const idsPool = (pool1.body?.data || []).map((r) => r.id);
    check('el pedido 1 está en el pool', idsPool.includes(o1.id));
    check('el pedido 2 está en el pool', idsPool.includes(o2.id));
    check('el BORRADOR no está en el pool', !idsPool.includes(draft.body?.id));
    const fila = (pool1.body?.data || []).find((r) => r.id === o1.id);
    check('el pool trae líneas y unidades del pedido', Number(fila?.lines) === 2 && Number(fila?.units) === 8, { lines: fila?.lines, units: fila?.units });
    check('declara que lo capturado sin señal no se puede medir desde el servidor',
      pool1.body?.pendiente_offline === 'no_medible_desde_el_servidor', pool1.body?.pendiente_offline);

    console.log('── 4. ⛔ Stock ANTES de armar la ola (no se aparta) ──');
    const stockAntes = await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: prods[0].id }).first();

    console.log('── 5. Armar la ola ──');
    const ola = await req('POST', '/almacen/surtido/waves', { warehouse_id: wh.id, delivery_date: manana(), order_ids: [o1.id, o2.id] }, token);
    check('crear ola 200/201', ola.status < 300, { status: ola.status, body: ola.body });
    const waveId = ola.body?.id;
    if (waveId) wavesCreadas.push(waveId);
    check('la ola trae folio W-', /^W-\d{4}-\d{5}$/.test(ola.body?.code || ''), ola.body?.code);
    check('la ola tiene 2 pedidos', ola.body?.orders_count === 2, ola.body?.orders_count);

    console.log('── 6. ⭐ Los pedidos SALEN del pool ──');
    const pool2 = await req('GET', `/almacen/surtido/pool?warehouse_id=${wh.id}`, null, token);
    const idsPool2 = (pool2.body?.data || []).map((r) => r.id);
    check('el pedido 1 ya no está en el pool', !idsPool2.includes(o1.id));
    check('el pedido 2 ya no está en el pool', !idsPool2.includes(o2.id));

    console.log('── 7. ⭐⭐ Consolidado por SKU: suma, unidad y desglose ──');
    const det = await req('GET', `/almacen/surtido/waves/${waveId}`, null, token);
    check('detalle 200', det.status === 200, det.status);
    const cons = det.body?.consolidated || [];
    const compartido = cons.find((c) => c.product_id === prods[0].id);
    check('el SKU compartido se consolidó 5 + 8 = 13', Number(compartido?.total_base) === 13, compartido?.total_base);
    check('conserva el desglose por pedido (2 renglones)', (compartido?.por_pedido || []).length === 2, compartido?.por_pedido);
    check('el desglose cuadra con el total',
      (compartido?.por_pedido || []).reduce((s, x) => s + Number(x.quantity), 0) === Number(compartido?.total_base));
    check('el consolidado DECLARA la unidad (aunque sea "sin declarar")',
      Object.prototype.hasOwnProperty.call(compartido || {}, 'qty_unit') && Array.isArray(compartido?.unidades_capturadas),
      { qty_unit: compartido?.qty_unit, unidades: compartido?.unidades_capturadas });
    const exclusivo = cons.find((c) => c.product_id === prods[1].id);
    check('el SKU de un solo pedido queda en 3', Number(exclusivo?.total_base) === 3, exclusivo?.total_base);

    console.log('── 8. ⭐ Unidad MIXTA: no se inventa un total común ──');
    // Se sella UNA de las dos líneas del SKU compartido: quedan dos unidades distintas.
    const filas = await knex('commercial.order_lines')
      .whereIn('order_id', [o1.id, o2.id]).andWhere('product_id', prods[0].id).select('id', 'order_id');
    if (filas.length === 2) {
      await knex('commercial.order_lines').where({ id: filas[0].id }).update({ qty_unit: 'CJA', qty_factor: 1, qty_factor_source: 'test' });
      const det2 = await req('GET', `/almacen/surtido/waves/${waveId}`, null, token);
      const mix = (det2.body?.consolidated || []).find((c) => c.product_id === prods[0].id);
      check('con dos unidades distintas se marca unidad_mixta', mix?.unidad_mixta === true, mix?.unidades_capturadas);
      check('y NO se publica una unidad común inventada', mix?.qty_unit === null, mix?.qty_unit);
      check('el total en unidad base sigue siendo correcto', Number(mix?.total_base) === 13, mix?.total_base);
      await knex('commercial.order_lines').where({ id: filas[0].id }).update({ qty_unit: null, qty_factor: null, qty_factor_source: null });
    } else {
      nomedido('unidad mixta', `se esperaban 2 líneas del SKU compartido y hay ${filas.length}`);
    }

    console.log('── 9. Un pedido no entra a DOS olas vivas, y el rechazo lo nombra ──');
    const dup = await req('POST', '/almacen/surtido/waves', { warehouse_id: wh.id, order_ids: [o1.id] }, token);
    check('segunda ola con el mismo pedido → 409', dup.status === 409, { status: dup.status, body: dup.body });
    check('el mensaje NOMBRA el folio del pedido', String(dup.body?.message || '').includes(o1.code), dup.body?.message);

    console.log('── 10. ⛔ Armar la ola NO apartó stock ──');
    const stockDespues = await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: prods[0].id }).first();
    check('quantity intacta', Number(stockAntes.quantity) === Number(stockDespues.quantity), { antes: stockAntes.quantity, despues: stockDespues.quantity });
    check('reserved_quantity intacta (NO se aparta — ADR-067)',
      Number(stockAntes.reserved_quantity) === Number(stockDespues.reserved_quantity),
      { antes: stockAntes.reserved_quantity, despues: stockDespues.reserved_quantity });

    console.log('── 11. PRUEBA NEGATIVA: otro almacén se rechaza ──');
    const otroWh = await knex('commercial.warehouses').where({ tenant_id: T }).whereNot({ id: wh.id }).first();
    if (otroWh) {
      const malo = await req('POST', '/almacen/surtido/waves', { warehouse_id: otroWh.id, order_ids: [o2.id] }, token);
      check('pedido de otro almacén → 409', malo.status === 409, { status: malo.status, body: malo.body });
    } else {
      nomedido('alcance por almacén', 'no hay un segundo almacén en esta base');
    }

    console.log('── 12. ⭐ Cancelar la ola DEVUELVE los pedidos al pool ──');
    const canc = await req('POST', `/almacen/surtido/waves/${waveId}/cancel`, { reason: 'prueba' }, token);
    check('cancelar 200/201', canc.status < 300, canc.status);
    check('la ola queda cancelada', canc.body?.status === 'cancelada', canc.body?.status);
    const pool3 = await req('GET', `/almacen/surtido/pool?warehouse_id=${wh.id}`, null, token);
    const idsPool3 = (pool3.body?.data || []).map((r) => r.id);
    check('el pedido 1 volvió al pool', idsPool3.includes(o1.id));
    check('el pedido 2 volvió al pool', idsPool3.includes(o2.id));
    const reOla = await req('POST', '/almacen/surtido/waves', { warehouse_id: wh.id, order_ids: [o1.id] }, token);
    check('y puede entrar a una ola NUEVA (no quedó preso)', reOla.status < 300, { status: reOla.status, body: reOla.body });
    if (reOla.body?.id) wavesCreadas.push(reOla.body.id);

    exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('\nERROR:', e.message);
  } finally {
    for (const id of wavesCreadas) {
      await knex('commercial.wave_orders').where({ wave_id: id }).del().catch(() => {});
      await knex('commercial.picking_waves').where({ id }).del().catch(() => {});
    }
    for (const id of ordersCreados) {
      await knex('commercial.order_lines').where({ order_id: id }).del().catch(() => {});
      await knex('commercial.order_status_history').where({ order_id: id }).del().catch(() => {});
      await knex('commercial.orders').where({ id }).del().catch(() => {});
    }
    console.log(`\n  ${pass} OK · ${fail} FAIL · ${skip} NO MEDIDO`);
    if (failures.length) console.log('  fallaron: ' + failures.join(', '));
    await knex.destroy();
    process.exit(exitCode);
  }
})();
