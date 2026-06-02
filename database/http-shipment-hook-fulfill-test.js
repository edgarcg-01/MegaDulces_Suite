/* eslint-disable no-console */
/**
 * Test E2E del hook close → orders.fulfilled (J.6.1 fix).
 *
 * Verifica que al cerrar la última shipment del order:
 *   1. El order pasa a status='fulfilled' (con fulfilled_at).
 *   2. El stock reservado se CONSUME (movement type='sale').
 *   3. order_status_history registra la transición confirmed→fulfilled.
 *
 * El bug anterior: ShipmentsService.close() hacía UPDATE pelado del status
 * sin consumir stock ni registrar history. Inventario quedaba inflado.
 *
 * Requisitos:
 *   - API en :3334 con ENABLE_MULTITENANT=true
 *   - Seed baseline + testdata B.3.2 (productos con stock)
 *
 * Correr: node database/http-shipment-hook-fulfill-test.js
 */

const BASE = 'http://localhost:3334/api';
let pass = 0, fail = 0;
const failures = [];

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, body: json };
}

function check(name, cond, detail) {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else      { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
}

(async () => {
  // 1. Login
  console.log('── 1. Login ──');
  const login = await req('POST', '/auth-mt/login', {
    tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot',
  });
  const token = login.body?.access_token;
  check('JWT recibido', !!token);
  if (!token) process.exit(1);

  // 2. Setup: pedir customer + warehouse + producto con stock
  console.log('\n── 2. Setup data ──');
  const customers = await req('GET', '/commercial/customers?pageSize=5', null, token);
  const customer = (customers.body?.data || []).find((c) => c.active);
  check('customer activo encontrado', !!customer?.id);

  const warehouses = await req('GET', '/commercial/warehouses', null, token);
  const warehouse = (warehouses.body?.data || warehouses.body || []).find((w) => w.is_default);
  check('warehouse default encontrado', !!warehouse?.id);

  // Buscar producto con stock disponible vía endpoint pricing (que devuelve productos con precio)
  // Pickeamos uno con stock > 5 para tener margen
  const stockResp = await req(`GET`, `/commercial/inventory/stock?warehouse_id=${warehouse.id}&pageSize=50`, null, token);
  const stockRows = (stockResp.body?.data || stockResp.body || []);
  const withStock = Array.isArray(stockRows)
    ? stockRows.find((s) => Number(s.available_quantity || s.available || s.quantity || 0) > 5)
    : undefined;
  check('producto con stock > 5 encontrado', !!withStock, { count: stockRows.length });
  if (!withStock) {
    console.error('  ⚠️ Sin productos con stock — correr testdata B.3.2 antes de este test.');
    process.exit(1);
  }
  const productId = withStock.product_id;
  const initialStock = Number(withStock.available_quantity || withStock.available || withStock.quantity);
  console.log(`  Producto: ${productId} | stock inicial: ${initialStock}`);

  // 3. Crear pedido draft + agregar línea
  console.log('\n── 3. Crear pedido draft ──');
  const draft = await req('POST', '/commercial/orders', {
    customer_id: customer.id,
    warehouse_id: warehouse.id,
    notes: 'E2E hook fulfill test',
  }, token);
  const orderId = draft.body?.id;
  check('order creado', !!orderId);

  const QTY = 3;
  const line = await req('POST', `/commercial/orders/${orderId}/lines`, {
    product_id: productId,
    quantity: QTY,
    discount_percent: 0,
  }, token);
  check('línea agregada', line.status === 201, line.body);

  // 4. Confirmar pedido (cliente → pending_approval, reserva stock) + aprobar (vendedor → confirmed)
  console.log('\n── 4. Confirmar pedido (pending_approval) + aprobar (confirmed) ──');
  const confirmed = await req('POST', `/commercial/orders/${orderId}/confirm`, {}, token);
  check('order → pending_approval tras confirm', confirmed.body?.status === 'pending_approval', { status: confirmed.body?.status });

  const approved = await req('POST', `/commercial/orders/${orderId}/approve`, {}, token);
  check('order → confirmed tras approve', approved.body?.status === 'confirmed', { status: approved.body?.status });

  const stockAfterConfirm = await req(`GET`, `/commercial/inventory/stock?warehouse_id=${warehouse.id}&pageSize=50`, null, token);
  const stockListAC = stockAfterConfirm.body?.data || stockAfterConfirm.body || [];
  const stockNow = (Array.isArray(stockListAC) ? stockListAC : []).find((s) => s.product_id === productId);
  const reservedAfter = Number(stockNow?.reserved_quantity || stockNow?.reserved || 0);
  console.log(`  Stock reservado tras confirm: ${reservedAfter} (esperado >= ${QTY})`);
  check('stock reservado >= QTY tras confirm', reservedAfter >= QTY, { reservedAfter });

  // 5. Crear shipment vinculado al order
  console.log('\n── 5. Crear shipment vinculado al order ──');
  const vehicles = await req('GET', '/logistics/fleet/vehicles', null, token);
  const vehicle = (vehicles.body || []).find((v) => v.plate === 'DEMO-001');
  check('vehicle DEMO-001 existe', !!vehicle?.id);

  const today = new Date().toISOString().slice(0, 10);
  const ship = await req('POST', '/logistics/shipments', {
    shipment_date: today,
    vehicle_id: vehicle.id,
    order_id: orderId,
    origin: 'CEDIS',
    destination: 'E2E test',
    type: 'entrega',
    boxes_count: QTY,
  }, token);
  check('shipment creado con order_id', !!ship.body?.id && ship.body?.order_id === orderId, ship.body);
  const shipmentId = ship.body?.id;

  // 6. Recorrer state machine: depart → deliver → close
  console.log('\n── 6. depart → deliver → close ──');
  const depart = await req('POST', `/logistics/shipments/${shipmentId}/depart`, {}, token);
  check('depart → en_ruta', depart.body?.status === 'en_ruta');

  const deliver = await req('POST', `/logistics/shipments/${shipmentId}/deliver`, {}, token);
  check('deliver → entregado', deliver.body?.status === 'entregado');

  const close = await req('POST', `/logistics/shipments/${shipmentId}/close`, {}, token);
  check('close → cerrado', close.body?.status === 'cerrado');

  // 7. ★ VERIFICACIONES DEL HOOK ★
  console.log('\n── 7. ★ Verificar hook close → fulfilled ★ ──');

  // 7a. Order pasa a fulfilled
  const orderAfter = await req('GET', `/commercial/orders/${orderId}`, null, token);
  check('order.status = fulfilled tras close', orderAfter.body?.status === 'fulfilled', { status: orderAfter.body?.status });
  check('order.fulfilled_at no es null', !!orderAfter.body?.fulfilled_at, { fulfilled_at: orderAfter.body?.fulfilled_at });

  // 7b. history registra transición
  const history = await req('GET', `/commercial/orders/${orderId}/history`, null, token);
  const events = history.body?.data || history.body || [];
  const fulfilledEvent = events.find((e) => e.from_status === 'confirmed' && e.to_status === 'fulfilled');
  check('history tiene transición confirmed→fulfilled', !!fulfilledEvent, { events_count: events.length });

  // 7c. Stock fue CONSUMIDO (la verificación crítica del bug)
  const stockFinal = await req(`GET`, `/commercial/inventory/stock?warehouse_id=${warehouse.id}&pageSize=50`, null, token);
  const stockListFinal = stockFinal.body?.data || stockFinal.body || [];
  const stockEnd = (Array.isArray(stockListFinal) ? stockListFinal : []).find((s) => s.product_id === productId);
  const reservedEnd = Number(stockEnd?.reserved_quantity || stockEnd?.reserved || 0);
  const availableEnd = Number(stockEnd?.available_quantity || stockEnd?.available || stockEnd?.quantity || 0);
  console.log(`  Stock final: available=${availableEnd}, reserved=${reservedEnd}`);
  console.log(`  Esperado: available = initial(${initialStock}) - QTY(${QTY}) = ${initialStock - QTY}, reserved liberado de QTY(${QTY})`);

  check(
    `stock available disminuyó en ${QTY} (consumo real, no solo reserva)`,
    initialStock - availableEnd === QTY,
    { availableEnd, initialStock, delta: initialStock - availableEnd, expected_delta: QTY },
  );
  // Robusto a state previo (pueden haber reservas de otras corridas):
  // verificamos que las reservas disminuyeron en AL MENOS QTY (liberé las mías).
  check(
    `reserved liberó al menos ${QTY} unidades (delta desde reservedAfter)`,
    reservedAfter - reservedEnd >= QTY,
    { reservedEnd, reservedAfter, delta: reservedAfter - reservedEnd },
  );

  // 7d. Hubo movement type='sale' por la cantidad
  // (esto requiere endpoint para ver movements — si no existe, lo skipeamos)

  console.log(`\n═══ Total: ${pass} pass / ${fail} fail ═══`);
  if (failures.length) {
    console.log('Failures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('💥 fatal:', err.message, err.stack);
  process.exit(1);
});
