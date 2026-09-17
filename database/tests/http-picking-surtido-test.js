/* eslint-disable no-console */
/**
 * CANDADO — EL SURTIDO: lo que se levantó de verdad (Fase SU.4, ADR-067).
 *
 * Complementa `http-picking-pool-test.js` (que cubre el pool y el armado de la ola). Éste cubre
 * el trabajo de la persona: arrancar, ir marcando renglón por renglón, y cerrar.
 *
 * ── Qué mide, y por qué cada bloque existe ───────────────────────────────────────────────────
 *
 *   1. Arrancar CONGELA el consolidado en renglones. Y es idempotente: arrancar dos veces no
 *      pisa lo ya levantado (en el almacén se toca el botón dos veces todo el tiempo).
 *   2. ⭐ El congelado lleva la UNIDAD con la cantidad. Si las líneas venían en unidades
 *      distintas, `qty_unit` es NULL y `unidad_mixta` true — NUNCA se rellena con 'PZA'
 *      (ADR-056: la ausencia se declara; ADR-055: un número sin unidad ya costó $866,805).
 *   3. ⭐⭐ Lo pedido se congela al ARRANCAR, no al armar la ola: si un pedido se corrige en el
 *      medio, la persona no queda buscando una cantidad que ya nadie pidió. Y una vez arrancada,
 *      NO se recalcula: el papel que se está recorriendo no puede cambiar debajo.
 *   4. El estado se DERIVA de la cantidad (todo→surtido, algo→faltante, nada→agotado) pero una
 *      causa declarada (dañado) GANA: "levanté 0" y "levanté 0 porque estaba dañado" son hechos
 *      distintos, y el segundo manda a otro lado (baja de inventario, no sustitución).
 *   5. ⭐ NULL ≠ 0: un renglón sin tocar y uno tocado-en-cero se distinguen. Cerrar con renglones
 *      sin tocar se RECHAZA — si se permitiera, un renglón que nadie caminó saldría del almacén
 *      indistinguible de uno agotado y el pedido iría corto sin que nadie lo supiera.
 *   6. PRUEBA NEGATIVA: no se puede levantar MÁS de lo pedido (eso es un ajuste de inventario,
 *      no un surtido).
 *   7. ⛔ Surtir NO mueve `commercial.stock` (ADR-067: no se aparta, y el consumo real ocurre al
 *      fulfillar el pedido, no al juntarlo en el almacén).
 *
 * Requisitos: API en :3334 con ENABLE_MULTITENANT=true y las migs 20260917140000/140100/150000.
 * Correr: node database/tests/http-picking-surtido-test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
require('./_lib/assert-safe-target').assertSafeTarget('http-picking-surtido-test');
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
    console.log('── 1. Login + setup ──');
    const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
    const token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) throw new Error('sin token');

    const wh = await knex('commercial.warehouses').where({ tenant_id: T, is_default: true }).first();
    let customer = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('default_price_list_id').first();
    if (!customer) customer = await knex('commercial.customers').where({ tenant_id: T }).first();
    const defaultList = await knex('commercial.price_lists').where({ tenant_id: T, is_default: true }).first();
    const priceListId = customer?.default_price_list_id || defaultList?.id;
    const prods = await knex('public.products').limit(2);
    check('setup base', !!wh && !!customer && !!priceListId && prods.length === 2);
    if (!wh || !customer || !priceListId || prods.length !== 2) throw new Error('setup incompleto');

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
      return { id, code: placed.body?.code };
    };
    const o1 = await armaPedido([{ product_id: prods[0].id, quantity: 5 }, { product_id: prods[1].id, quantity: 4 }]);
    const o2 = await armaPedido([{ product_id: prods[0].id, quantity: 8 }]);

    const ola = await req('POST', '/almacen/surtido/waves', { warehouse_id: wh.id, delivery_date: manana(), order_ids: [o1.id, o2.id] }, token);
    const waveId = ola.body?.id;
    if (waveId) wavesCreadas.push(waveId);
    check('ola creada', !!waveId, ola.status);

    console.log('── 2. Arrancar CONGELA el consolidado ──');
    const stockAntes = await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: prods[0].id }).first();
    const start = await req('POST', `/almacen/surtido/waves/${waveId}/start`, {}, token);
    check('start 200/201', start.status < 300, { status: start.status, body: start.body });
    const lineas = start.body || [];
    check('se congelaron 2 renglones (2 SKU distintos)', lineas.length === 2, lineas.length);
    const rCompartido = lineas.find((l) => l.product_id === prods[0].id);
    check('el SKU compartido se congeló en 5 + 8 = 13', Number(rCompartido?.qty_requested) === 13, rCompartido?.qty_requested);
    check('nace pendiente y SIN cantidad levantada (NULL, no 0)',
      rCompartido?.status === 'pendiente' && rCompartido?.qty_picked === null,
      { status: rCompartido?.status, qty_picked: rCompartido?.qty_picked });

    console.log('── 3. ⭐ La unidad viaja con la cantidad ──');
    check('el renglón declara su unidad (o su ausencia), nunca un default',
      Object.prototype.hasOwnProperty.call(rCompartido || {}, 'qty_unit') &&
      Object.prototype.hasOwnProperty.call(rCompartido || {}, 'unidad_mixta'),
      { qty_unit: rCompartido?.qty_unit, unidad_mixta: rCompartido?.unidad_mixta });
    check('sin unidad declarada en las líneas → NULL, no "PZA" de relleno',
      rCompartido?.qty_unit === null, rCompartido?.qty_unit);

    console.log('── 4. Arrancar dos veces NO pisa lo congelado (idempotente) ──');
    const start2 = await req('POST', `/almacen/surtido/waves/${waveId}/start`, {}, token);
    check('segundo start 200/201', start2.status < 300, start2.status);
    check('sigue habiendo 2 renglones', (start2.body || []).length === 2, (start2.body || []).length);

    console.log('── 5. ⭐⭐ Lo congelado NO se recalcula si el pedido cambia ──');
    // Se RECORTA una línea del pedido por debajo (como si alguien lo corrigiera mientras la
    // persona ya está caminando). Se recorta y no se agranda porque el sistema tiene un CHECK
    // real —`commercial_order_lines_qty_le_requested`— que impide superar lo que el cliente
    // pidió: subirla sería una manipulación que el propio esquema no permite.
    const lineaDelPedido = await knex('commercial.order_lines').where({ order_id: o1.id, product_id: prods[0].id }).first();
    await knex('commercial.order_lines').where({ id: lineaDelPedido.id }).update({ quantity: 2 });
    const trasCambio = await req('POST', `/almacen/surtido/waves/${waveId}/start`, {}, token);
    const rTras = (trasCambio.body || []).find((l) => l.product_id === prods[0].id);
    check('el renglón que se está recorriendo NO cambió debajo', Number(rTras?.qty_requested) === 13, rTras?.qty_requested);
    await knex('commercial.order_lines').where({ id: lineaDelPedido.id }).update({ quantity: 5 });

    console.log('── 6. Marcar renglones: el estado se DERIVA de la cantidad ──');
    const full = await req('POST', `/almacen/surtido/waves/${waveId}/lines/${rCompartido.id}/pick`, { qty_picked: 13 }, token);
    check('levantar TODO → surtido', full.body?.status === 'surtido', { status: full.status, body: full.body });
    check('guarda la cantidad levantada', Number(full.body?.qty_picked) === 13, full.body?.qty_picked);

    const rOtro = lineas.find((l) => l.product_id === prods[1].id);
    const parcial = await req('POST', `/almacen/surtido/waves/${waveId}/lines/${rOtro.id}/pick`, { qty_picked: 1 }, token);
    check('levantar MENOS → faltante', parcial.body?.status === 'faltante', parcial.body?.status);

    console.log('── 7. Una causa declarada GANA sobre la derivación ──');
    const danado = await req('POST', `/almacen/surtido/waves/${waveId}/lines/${rOtro.id}/pick`, { qty_picked: 0, status: 'danado', note: 'caja mojada' }, token);
    check('levantar 0 con causa "dañado" NO se convierte en "agotado"', danado.body?.status === 'danado', danado.body?.status);
    check('y guarda el motivo', String(danado.body?.note || '').includes('mojada'), danado.body?.note);

    console.log('── 8. PRUEBA NEGATIVA: no se puede levantar MÁS de lo pedido ──');
    const exceso = await req('POST', `/almacen/surtido/waves/${waveId}/lines/${rCompartido.id}/pick`, { qty_picked: 999 }, token);
    check('levantar de más → 400', exceso.status === 400, { status: exceso.status, body: exceso.body });
    check('y el mensaje explica que eso es un ajuste de inventario',
      /ajuste de inventario/i.test(String(exceso.body?.message || '')), exceso.body?.message);

    console.log('── 9. ⭐ Cerrar con renglones SIN TOCAR se rechaza ──');
    // Se devuelve un renglón a pendiente para probar el freno.
    await knex('commercial.wave_lines').where({ id: rOtro.id }).update({ status: 'pendiente', qty_picked: null });
    const cierreMalo = await req('POST', `/almacen/surtido/waves/${waveId}/finish`, {}, token);
    check('cerrar con pendientes → 409', cierreMalo.status === 409, { status: cierreMalo.status, body: cierreMalo.body });
    check('el mensaje distingue "sin tocar" de "agotado"',
      /sin tocar/i.test(String(cierreMalo.body?.message || '')), cierreMalo.body?.message);

    console.log('── 10. Cerrar bien ──');
    await req('POST', `/almacen/surtido/waves/${waveId}/lines/${rOtro.id}/pick`, { qty_picked: 0, status: 'agotado' }, token);
    const cierre = await req('POST', `/almacen/surtido/waves/${waveId}/finish`, {}, token);
    check('finish 200/201', cierre.status < 300, { status: cierre.status, body: cierre.body });
    check('la ola queda surtida', cierre.body?.status === 'surtida', cierre.body?.status);
    check('registra QUIÉN surtió', !!cierre.body?.picked_by, cierre.body?.picked_by);
    const wo = await knex('commercial.wave_orders').where({ wave_id: waveId }).select('stage');
    check('los pedidos de la ola avanzaron a "surtido"', wo.every((x) => x.stage === 'surtido'), wo.map((x) => x.stage));
    const cierre2 = await req('POST', `/almacen/surtido/waves/${waveId}/finish`, {}, token);
    check('cerrar dos veces es idempotente (no 409)', cierre2.status < 300, cierre2.status);

    console.log('── 11. ⛔ Surtir NO movió el stock ──');
    const stockDespues = await knex('commercial.stock').where({ tenant_id: T, warehouse_id: wh.id, product_id: prods[0].id }).first();
    check('quantity intacta', Number(stockAntes.quantity) === Number(stockDespues.quantity), { antes: stockAntes.quantity, despues: stockDespues.quantity });
    check('reserved_quantity intacta (no se aparta — ADR-067)',
      Number(stockAntes.reserved_quantity) === Number(stockDespues.reserved_quantity));

    console.log('── 12. Ya cerrada, no se puede seguir marcando ──');
    const tarde = await req('POST', `/almacen/surtido/waves/${waveId}/lines/${rCompartido.id}/pick`, { qty_picked: 1 }, token);
    check('marcar sobre una ola cerrada → 409', tarde.status === 409, tarde.status);

    exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('\nERROR:', e.message);
  } finally {
    for (const id of wavesCreadas) {
      await knex('commercial.wave_lines').where({ wave_id: id }).del().catch(() => {});
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
