/* eslint-disable no-console */
/**
 * CANDADO — LA CANTIDAD QUE SE PIDE ES LA QUE SE VE, Y LA LÍNEA DICE EN QUÉ UNIDAD (VU.4).
 *
 * El hermano de `test-newdb-quantity-unit.js`, que mide la FORMA (que exista la columna del
 * sello). Éste mide el VALOR: que pedir "2 cajas" guarde 2×factor piezas — ni 2, ni 2×factor²
 * — y que ese sello sobreviva a los steppers del carrito.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────────────────────
 *
 * La toma de pedido del vendedor convertía a unidad base EN LA PANTALLA y mandaba el número
 * crudo, así que la línea no decía si esas 116 piezas eran "2 cajas" o "116 piezas sueltas".
 * El protocolo del servidor (VU.2/VU.3: resolver el factor contra el ERP, frenar el desacuerdo)
 * estaba construido y no lo llamaba nadie desde el campo.
 *
 * Al cablearlo aparece un riesgo que NO existía antes, y es el que este candado vigila:
 * `quantity` cambia de significado según venga o no `qty_unit`. Mandar la cantidad ya
 * convertida JUNTO con el sello la multiplica de nuevo — un pedido de 2 cajas se vuelve uno de
 * 232 piezas. Es el error que no se ve en un build ni en un lint: se ve en el almacén.
 *
 * ── Qué mide ─────────────────────────────────────────────────────────────────────────────────
 *
 *   1. addLine SIN sello → la cantidad va en base y la línea queda sin unidad declarada
 *      (`qty_unit = null`). Es el comportamiento viejo: tiene que seguir intacto.
 *   2. addLine CON sello → `quantity × factor` en base, sellada, y con la fuente rotulada.
 *   3. ⭐ NO se convierte dos veces: el comparado contra el mismo pedido hecho en base.
 *   4. ⭐⭐ updateLine CON sello re-sella (antes BORRABA el sello: en esta pantalla todo ajuste
 *      pasa por ahí, así que la procedencia no sobrevivía al primer toque del stepper).
 *   5. updateLine SIN sello sigue borrándolo — una cantidad editada a mano ya no está descrita
 *      por la unidad vieja, y dejar el sello sería peor que no tenerlo (ADR-056).
 *   6. PRUEBA NEGATIVA: un factor que contradice al ERP se RECHAZA (400), no se arbitra en
 *      silencio. Sin esto el protocolo es decorativo.
 *
 * Requisitos: API en :3334 con ENABLE_MULTITENANT=true, con el código de VU.4.
 * Correr: node database/tests/http-vendor-qty-unit-test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });
// Escribe pedidos de prueba: no puede correr contra prod.
require('./_lib/assert-safe-target').assertSafeTarget('http-vendor-qty-unit-test');
const knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL_NEW });
const BASE = 'http://localhost:3334/api';
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, skip = 0;
const failures = [];
const check = (name, cond, detail) => {
  if (cond) { console.log(`  OK   ${name}`); pass++; }
  else { console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); failures.push(name); fail++; }
};
// Lo que no se puede medir se DECLARA, no se pone verde (ADR-056).
const nomedido = (name, why) => { console.log(`  ○ NO MEDIDO — ${name}: ${why}`); skip++; };

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) { /* respuesta sin cuerpo */ }
  return { status: r.status, body: json };
}

const created = [];

(async () => {
  let exitCode = 1;
  try {
    console.log('── 1. Login ──');
    const login = await req('POST', '/auth-mt/login', { tenant_slug: 'mega_dulces', username: 'superoot', password: 'superoot' });
    const token = login.body?.access_token;
    check('JWT recibido', !!token, login.status);
    if (!token) throw new Error('sin token');

    console.log('── 2. Setup: un producto cuyo factor de CAJA el ERP afirme ──');
    const wh = await knex('commercial.warehouses').where({ tenant_id: T, is_default: true }).first();
    let customer = await knex('commercial.customers').where({ tenant_id: T }).whereNotNull('default_price_list_id').first();
    if (!customer) customer = await knex('commercial.customers').where({ tenant_id: T }).first();
    const defaultList = await knex('commercial.price_lists').where({ tenant_id: T, is_default: true }).first();
    const priceListId = customer?.default_price_list_id || defaultList?.id;
    check('setup: warehouse + customer + price list', !!wh && !!customer && !!priceListId);
    if (!wh || !customer || !priceListId) throw new Error('setup incompleto');

    // El caso REAL: el resolvedor tiene que AFIRMAR el factor, si no la conversión cae al
    // rótulo del cliente y no probaríamos el camino que importa.
    const cand = await knex.raw(
      `select bf.product_id, bf.box_factor::numeric as factor, bf.unit_base, bf.source
         from analytics.v_product_box_factor bf
        where bf.tenant_id = ?
          and bf.source <> 'default'
          and coalesce(bf.is_master_suspect, false) = false
          and bf.box_factor > 1
        limit 1`, [T]);
    const row = cand.rows?.[0];
    if (!row) {
      nomedido('conversión de caja', 'ningún producto con factor de caja afirmado por el ERP en esta base');
      console.log(`\n  ${pass} OK · ${fail} FAIL · ${skip} NO MEDIDO`);
      await knex.destroy();
      process.exit(fail ? 1 : 0);
    }
    const productId = row.product_id;
    const factor = Number(row.factor);
    console.log(`  producto ${productId} · caja = ${factor} ${row.unit_base || '(base)'} · source=${row.source}`);

    await knex('commercial.product_prices')
      .insert({ tenant_id: T, price_list_id: priceListId, product_id: productId, price: 10, tax_rate: 0.16, min_qty: 1 })
      .onConflict(['tenant_id', 'price_list_id', 'product_id']).merge(['price', 'tax_rate', 'min_qty']);
    await knex('commercial.stock')
      .insert({ tenant_id: T, warehouse_id: wh.id, product_id: productId, quantity: 100000, reserved_quantity: 0 })
      .onConflict(['tenant_id', 'warehouse_id', 'product_id']).merge(['quantity', 'reserved_quantity']);

    const nuevoDraft = async () => {
      const d = await req('POST', '/commercial/orders', { customer_id: customer.id, warehouse_id: wh.id, delivery_type: 'route' }, token);
      if (d.body?.id) created.push(d.body.id);
      return d.body?.id;
    };
    const lineaDe = (orderId) => knex('commercial.order_lines').where({ order_id: orderId, product_id: productId }).first();

    console.log('── 3. addLine SIN sello: en base, sin unidad declarada (comportamiento viejo) ──');
    const oBase = await nuevoDraft();
    const rBase = await req('POST', `/commercial/orders/${oBase}/lines`, { product_id: productId, quantity: 2 * factor }, token);
    check('addLine sin sello 200/201', rBase.status < 300, rBase.status);
    const lBase = await lineaDe(oBase);
    check('sin sello → cantidad tal cual (base)', Number(lBase?.quantity) === 2 * factor, { got: lBase?.quantity, want: 2 * factor });
    check('sin sello → qty_unit null (ausencia honesta)', lBase?.qty_unit === null, lBase?.qty_unit);

    console.log('── 4. addLine CON sello: "2 cajas" = 2 × factor, sellado ──');
    const oCaja = await nuevoDraft();
    const rCaja = await req('POST', `/commercial/orders/${oCaja}/lines`,
      { product_id: productId, quantity: 2, qty_unit: 'CJA', qty_factor: factor }, token);
    check('addLine con sello 200/201', rCaja.status < 300, { status: rCaja.status, body: rCaja.body });
    const lCaja = await lineaDe(oCaja);
    check('con sello → 2 cajas se guardan como 2 × factor', Number(lCaja?.quantity) === 2 * factor, { got: lCaja?.quantity, want: 2 * factor });
    check('con sello → qty_unit = CJA', lCaja?.qty_unit === 'CJA', lCaja?.qty_unit);
    check('con sello → qty_factor = el del ERP', Number(lCaja?.qty_factor) === factor, lCaja?.qty_factor);
    check('con sello → la fuente queda rotulada', !!lCaja?.qty_factor_source, lCaja?.qty_factor_source);

    console.log('── 5. ⭐ La conversión NO se aplica dos veces ──');
    check('2 cajas (sellado) == 2×factor piezas (base): misma cantidad',
      Number(lCaja?.quantity) === Number(lBase?.quantity), { sellado: lCaja?.quantity, base: lBase?.quantity });
    check('y NO es factor² (la trampa de mandar la cantidad ya convertida + el sello)',
      Number(lCaja?.quantity) !== 2 * factor * factor, { got: lCaja?.quantity, trampa: 2 * factor * factor });

    console.log('── 6. ⭐⭐ updateLine CON sello re-sella (antes lo borraba) ──');
    const upd = await req('PATCH', `/commercial/orders/${oCaja}/lines/${lCaja.id}`,
      { quantity: 3, qty_unit: 'CJA', qty_factor: factor }, token);
    check('updateLine con sello 200', upd.status < 300, { status: upd.status, body: upd.body });
    const lUpd = await lineaDe(oCaja);
    check('ajustar a 3 cajas → 3 × factor', Number(lUpd?.quantity) === 3 * factor, { got: lUpd?.quantity, want: 3 * factor });
    check('el sello SOBREVIVE al ajuste', lUpd?.qty_unit === 'CJA', lUpd?.qty_unit);

    console.log('── 7. updateLine SIN sello sigue borrándolo (cantidad editada a mano) ──');
    const updPlano = await req('PATCH', `/commercial/orders/${oCaja}/lines/${lCaja.id}`, { quantity: 7 }, token);
    check('updateLine sin sello 200', updPlano.status < 300, updPlano.status);
    const lPlano = await lineaDe(oCaja);
    check('sin sello → cantidad en base tal cual', Number(lPlano?.quantity) === 7, lPlano?.quantity);
    check('sin sello → el sello viejo se BORRA (no queda mintiendo)', lPlano?.qty_unit === null, lPlano?.qty_unit);

    console.log('── 8. PRUEBA NEGATIVA: el desacuerdo de empaque se RECHAZA ──');
    const oMal = await nuevoDraft();
    const malo = await req('POST', `/commercial/orders/${oMal}/lines`,
      { product_id: productId, quantity: 2, qty_unit: 'CJA', qty_factor: factor + 7 }, token);
    check('factor que contradice al ERP → 400', malo.status === 400, { status: malo.status, body: malo.body });
    check('y el mensaje NOMBRA las dos cifras', /\b(desacuerdo|empaque)\b/i.test(String(malo.body?.message || '')), malo.body?.message);
    const lMal = await lineaDe(oMal);
    check('la línea NO se creó con ninguno de los dos factores', !lMal, lMal?.quantity);

    exitCode = fail ? 1 : 0;
  } catch (e) {
    console.error('\nERROR:', e.message);
  } finally {
    for (const id of created) {
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
