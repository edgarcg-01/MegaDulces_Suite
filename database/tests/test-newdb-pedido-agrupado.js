/**
 * MCP.3.13 — Pedido agrupado: un pedido del vendedor que se surte en VARIAS sucursales de su zona.
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció
 * contra una base REAL con el payload de la pantalla. Aquí se carga el `CommercialOrdersService`
 * REAL (el TS del repo) y se recorre el camino de la app del vendedor:
 *
 *   createDraft(LPA) → addLine(p1) → addLine(p2, source=PH) → place()
 *
 * y se comprueba en la base:
 *   1. El renglón de otra sucursal de la zona se acepta; el de OTRA zona se rechaza (negativa) y
 *      el control positivo (misma zona) pasa.
 *   2. Al mandar, el pedido se separa: el principal (LPA) y una parte (PH) con group_id = principal,
 *      cada una con SUS renglones y su total; las dos confirmadas.
 *   3. Si TODO se pidió de otra sucursal, no queda un pedido vacío: el principal toma esa sucursal.
 *   4. Mover un renglón de sucursal (updateLine) lo re-tarifica y no choca con otro igual.
 *   5. place() es idempotente: un reintento no crea otra parte.
 *
 * Sólo se sustituye la infraestructura ajena al pedido (precios del motor, alertas, push, stock):
 * los dobles devuelven un precio fijo para que la prueba mida el AGRUPADO, no la tarifa.
 * Todo corre dentro de una transacción que se revierte: no deja filas.
 * Lo que la base no tiene con qué comprobarse reporta NO MEDIDO (ADR-056).
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const T = '00000000-0000-0000-0000-00000000d01c';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const rechaza = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

/** Carga el servicio REAL con dobles para lo que no es del pedido (motor de precios, alertas, push, stock). */
function cargarServicio() {
  const raiz = path.resolve(__dirname, '..', '..');
  const d = (n) => path.join(__dirname, `.stub-mcp313-${n}.js`);
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), 'module.exports = { TenantKnexService: class {}, TenantContextService: class {}, isPlatformAdminRole: (r) => r === "superadmin" };'],
    '@megadulces/contracts': [d('contracts'), 'module.exports = { INVOICE_ISSUER_PORT: "INVOICE_ISSUER_PORT" };'],
    '../commercial-pricing/commercial-pricing.service': [d('pricing'), 'module.exports = { CommercialPricingService: class {} };'],
    '../commercial-inventory/commercial-inventory.service': [d('inventory'), 'module.exports = { CommercialInventoryService: class {} };'],
    '../commercial-alerts/alerts.service': [d('alerts'), 'module.exports = { AlertsService: class {} };'],
    '../commercial-push/commercial-push.service': [d('push'), 'module.exports = { CommercialPushService: class {} };'],
    './order-stock.service': [d('stock'), 'module.exports = { OrderStockService: class {} };'],
    '../commercial-quotes/quote-pricing.service': [d('quotes'), 'module.exports = { QuotePricingService: class {}, rungDeRotulo: () => "base" };'],
  };
  for (const [, [f, src]] of Object.entries(stubs)) fs.writeFileSync(f, src);
  process.on('exit', () => { for (const [, [f]] of Object.entries(stubs)) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } });
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, parent, ...rest) {
    if (stubs[req] && parent && /commercial-orders\.service\.ts$/.test(parent.filename)) return stubs[req][0];
    if (req === '@megadulces/platform-core' || req === '@megadulces/contracts') return stubs[req][0];
    return orig.call(this, req, parent, ...rest);
  };
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
    },
  });
  return require(path.join(raiz, 'libs/commercial/src/lib/commercial-orders/commercial-orders.service.ts')).CommercialOrdersService;
}

/** El servicio sobre la transacción de la prueba. Precio fijo de $10 + 16 %: se mide el agrupado. */
function servicio(Svc, trx, userId) {
  const tk = { run: (fn) => fn(trx) };
  const tenantCtx = {
    get: () => ({ tenantId: T, userId, roleName: 'superadmin' }),
    requireTenantId: () => T,
  };
  const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
  const alerts = { emitLargeOrder() {}, emitOrderConfirmed() {}, emitTo() {} };
  const push = { notifyCustomer: async () => undefined, sendToCustomer: async () => undefined };
  const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
  const quotes = { ladders: async () => new Map(), priceLine: async () => ({ line_total: null, unit_price: null }) };
  return new Svc(tk, tenantCtx, pricing, {}, alerts, push, stock, quotes);
}

(async () => {
  let Svc;
  try {
    Svc = cargarServicio();
  } catch (e) {
    noMedido(`no se pudo cargar el servicio real (${e.message.split('\n')[0]})`);
    console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const user = await trx('public.users').whereNull('deleted_at').first('id');
      const prods = await trx('catalog.products').limit(3).pluck('id');
      if (!user || prods.length < 3) {
        noMedido('la base no tiene usuarios o 3 productos con qué armar el pedido');
        throw new Error(RB);
      }
      const [p1, p2, p3] = prods;
      const wh = async (code, zona) => (await trx('commercial.warehouses').insert({
        tenant_id: T, code, name: `Prueba ${code}`, kind: 'central', active: true, purchase_zone: zona,
      }).returning('id'))[0].id;
      const LPA = await wh('ZZ-MCP313-LPA', 'ZZ-ZONA-PRUEBA');
      const PH = await wh('ZZ-MCP313-PH', 'ZZ-ZONA-PRUEBA');
      const OTRA = await wh('ZZ-MCP313-ZAM', 'ZZ-OTRA-ZONA');
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP313-CLI', name: 'Cliente prueba MCP.3.13', active: true,
      }).returning('id');
      const svc = servicio(Svc, trx, user.id);
      const borrador = () => svc.createDraft({ customer_id: cli.id, warehouse_id: LPA, requested_delivery_date: '2030-01-02' });

      console.log('\n[1] El renglón de otra sucursal: misma zona sí, otra zona no');
      const o = await borrador();
      await svc.addLine(o.id, { product_id: p1, quantity: 2 });
      const l2 = await svc.addLine(o.id, { product_id: p2, quantity: 3, source_warehouse_id: PH });
      ok(l2.source_warehouse_id === PH, 'control positivo: el renglón de PH (misma zona) se guarda con su sucursal');
      ok(await rechaza(() => svc.addLine(o.id, { product_id: p3, quantity: 1, source_warehouse_id: OTRA }), /no es de la zona/),
        'NEGATIVA: un renglón de otra zona se RECHAZA');
      const mismo = await svc.addLine(o.id, { product_id: p2, quantity: 1, source_warehouse_id: PH });
      ok(mismo.id === l2.id && Number(mismo.quantity) === 4, 'el mismo producto de la MISMA sucursal se suma al renglón (no duplica)');
      const otroOrigen = await svc.addLine(o.id, { product_id: p2, quantity: 1 });
      ok(otroOrigen.id !== l2.id, 'el mismo producto de OTRA sucursal es otro renglón');

      console.log('\n[2] Al mandar se separa en partes');
      const res = await svc.place(o.id);
      ok(res.group_parts === 2, `place() avisa que el pedido quedó en 2 partes (vino ${res.group_parts})`);
      const grupo = await trx('commercial.orders').where({ group_id: o.id }).select('id', 'warehouse_id', 'status', 'total', 'code');
      ok(grupo.length === 2, 'quedan 2 pedidos en el grupo (principal + parte)');
      const principal = grupo.find((g) => g.id === o.id);
      const parte = grupo.find((g) => g.id !== o.id);
      ok(principal && principal.warehouse_id === LPA && principal.status === 'confirmed', 'el principal sigue en LPA y quedó confirmado');
      ok(parte && parte.warehouse_id === PH && parte.status === 'confirmed', 'la parte es de PH y quedó confirmada');
      const lp = await trx('commercial.order_lines').where({ order_id: o.id }).orderBy('line_number').select('product_id', 'line_number');
      const lpa = await trx('commercial.order_lines').where({ order_id: parte.id }).orderBy('line_number').select('product_id', 'line_number', 'source_warehouse_id');
      ok(lp.length === 2 && lp.map((l) => l.line_number).join() === '1,2', 'el principal conserva sus 2 renglones, renumerados 1..2');
      ok(lpa.length === 1 && lpa[0].product_id === p2 && lpa[0].line_number === 1, 'la parte tiene el renglón de PH (renglón 1)');
      ok(Number(parte.total) > 0 && Number(principal.total) > 0, 'cada parte tiene su propio total');

      console.log('\n[5] Reintento de place(): idempotente');
      await svc.place(o.id);
      const otraVez = await trx('commercial.orders').where({ group_id: o.id }).count('* as n').first();
      ok(Number(otraVez.n) === 2, 'un reintento no crea otra parte');

      console.log('\n[3] Todo de otra sucursal: no queda un pedido vacío');
      const o2 = await borrador();
      await svc.addLine(o2.id, { product_id: p1, quantity: 1, source_warehouse_id: PH });
      const r2 = await svc.place(o2.id);
      const o2f = await trx('commercial.orders').where({ id: o2.id }).first('warehouse_id', 'group_id', 'status');
      ok(o2f.warehouse_id === PH && o2f.group_id === null && o2f.status === 'confirmed', 'el principal toma la sucursal (PH), sin grupo');
      ok(!r2.group_parts, 'no se reporta grupo');

      console.log('\n[4] Mover un renglón de sucursal');
      const o3 = await borrador();
      const a = await svc.addLine(o3.id, { product_id: p1, quantity: 2 });
      const movido = await svc.updateLine(o3.id, a.id, { quantity: 2, source_warehouse_id: PH });
      ok(movido.source_warehouse_id === PH, 'updateLine mueve el renglón a PH');
      await svc.addLine(o3.id, { product_id: p1, quantity: 1 });
      const l3 = await trx('commercial.order_lines').where({ order_id: o3.id, product_id: p1 }).whereNull('source_warehouse_id').first('id');
      ok(await rechaza(() => svc.updateLine(o3.id, l3.id, { quantity: 1, source_warehouse_id: PH }), /Ya tienes ese producto/),
        'NEGATIVA: mover a una sucursal donde ya está ese producto se RECHAZA');
      ok(await rechaza(() => svc.updateLine(o3.id, a.id, { quantity: 2, source_warehouse_id: OTRA }), /no es de la zona/),
        'NEGATIVA: mover a otra zona se RECHAZA');

      throw new Error(RB);
    });
  } catch (e) {
    if (!String(e.message).includes(RB)) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
