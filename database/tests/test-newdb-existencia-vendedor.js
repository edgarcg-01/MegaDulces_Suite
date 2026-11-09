/**
 * MCP.3.16 + DN.7 — Existencia en la toma de pedido del vendedor: estado por sucursal, gemelo del
 * legado, frescura del carril y la REVISIÓN al agregar (hasta ADR-115, 2026-11-07, era un bloqueo).
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció
 * contra una base REAL. Aquí se cargan por ts-node los módulos REALES del repo —el resolvedor
 * (`commercial-inventory/stock-state.ts`), la zona (`zone-stock.ts`), el catálogo
 * (`CommercialPricingService.listPrices`) y el pedido (`CommercialOrdersService`)— y se recorren
 * contra la base local, con la vista canónica `analytics.v_erp_stock_on_hand` sobre filas de
 * `kepler_ods.kdil` sembradas en la prueba y la frescura en `analytics.ods_branch_checks`:
 *
 *   1. El resolvedor da los cuatro estados (y el legado toma la existencia de su gemelo).
 *   2. La zona: la sucursal vieja viaja `stale` con sus celdas en null; el legado trae la del gemelo.
 *   3. El catálogo con `stock_state=1`: estado por renglón y los «no se maneja» AL FINAL. Se cruzan
 *      DOS implementaciones: el predicado SQL del orden contra la regla de `estadoDeExistencia`.
 *      Sin `stock_state`, el renglón no trae estado (como antes).
 *   4. `[DN.7]` addLine del vendedor YA NO da 409 (ADR-115): el agotado se GUARDA y la respuesta trae
 *      `stock_state` y `stock_review` con las alternativas de la zona; nadie al día lo tiene pero una
 *      sucursal está vieja → el texto NO dice «tu zona» y nombra la que falta; con existencia pasa y
 *      dice si alcanza; `sin_dato` (sucursal vieja) se dice `sin_dato`; un rol sin VENDOR_APP_ACCESS no
 *      se revisa; el legado se guarda con SU id (la existencia es la del gemelo); cambiar el renglón a
 *      una sucursal en 0 (updateLine) se hace y lo dice.
 *   5. replaceLines (lote de la sincronización offline) NO bloquea: el agotado se guarda.
 *
 * Sólo se sustituye la infraestructura ajena (motor de precios, alertas, push, stock transaccional).
 * Todo corre en una transacción que se revierte: no deja filas. Lo que la base no tiene con qué
 * comprobarse reporta NO MEDIDO con la razón (ADR-056), nunca verde.
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const { asegurarColumnasDeProd } = require('./_lib/columnas-de-prod');
const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.resolve(__dirname, '..', '..');

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const falla = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/** Carga los módulos REALES con dobles sólo para lo que no es de existencia ni del pedido. */
function cargar() {
  const d = (n) => path.join(__dirname, `.stub-mcp316-${n}.js`);
  const contrato = path.join(RAIZ, 'libs/contracts/src/http/stock-state.contract.ts').replace(/\\/g, '/');
  // [MCP.11] La regla de promociones (esNombreDePromocion) la usan ahora el bloqueo y el catálogo.
  const simbolico = path.join(RAIZ, 'libs/contracts/src/http/codigo-simbolico.contract.ts').replace(/\\/g, '/');
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), 'module.exports = { TenantKnexService: class {}, TenantContextService: class {}, isPlatformAdminRole: (r) => r === "superadmin" || r === "admin" };'],
    '@megadulces/contracts': [d('contracts'), `module.exports = { ...require(${JSON.stringify(contrato)}), ...require(${JSON.stringify(simbolico)}), INVOICE_ISSUER_PORT: "INVOICE_ISSUER_PORT" };`],
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
    const p = parent && parent.filename ? parent.filename : '';
    if (req === '@megadulces/platform-core' || req === '@megadulces/contracts') return stubs[req][0];
    if (stubs[req] && /commercial-orders\.service\.ts$/.test(p)) return stubs[req][0];
    if (req === '../commercial-quotes/quote-pricing.service' && /commercial-pricing\.service\.ts$/.test(p)) return stubs[req][0];
    return orig.call(this, req, parent, ...rest);
  };
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
    },
  });
  const lib = (r) => require(path.join(RAIZ, 'libs/commercial/src/lib', r));
  return {
    estado: lib('commercial-inventory/stock-state.ts'),
    contrato: require(contrato),
    zoneStock: lib('commercial-vendor-routes/zone-stock.ts').zoneStock,
    Pricing: lib('commercial-pricing/commercial-pricing.service.ts').CommercialPricingService,
    Orders: lib('commercial-orders/commercial-orders.service.ts').CommercialOrdersService,
  };
}

const ctxDe = (userId, roleName) => ({ get: () => ({ tenantId: T, userId, roleName }), requireTenantId: () => T });

function pedidos(Orders, trx, userId, rol, quotes = { ladders: async () => new Map(), priceLine: async () => ({ line_total: null, unit_price: null }) }) {
  const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
  const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: () => undefined };
  const push = { sendToCustomer: async () => undefined };
  const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
  return new Orders({ run: (fn) => fn(trx) }, ctxDe(userId, rol), pricing, {}, alerts, push, stock, quotes);
}

(async () => {
  let M;
  try {
    M = cargar();
  } catch (e) {
    noMedido(`no se pudieron cargar los módulos reales (${e.message.split('\n')[0]})`);
    console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      // `[DN.8]` Prod tiene `catalog.products.articulo` (llegó con la importación de Railway; ninguna
      // migración la crea) y la siembra y el resolvedor la usan: sin esto, en la base del CI esta suite
      // abortaba en la siembra y nunca medía nada. Se agrega DENTRO de esta transacción con el tipo de
      // la foto de prod, y se declara (`_lib/columnas-de-prod.js`).
      for (const c of await asegurarColumnasDeProd(trx, [['catalog', 'products', 'articulo']])) {
        console.log(`  ⚠️ la base no traía ${c.split(' ')[0]} (prod sí): agregada dentro de la transacción como ${c.split(' ').slice(1).join(' ')}`);
      }
      const faltan = (await trx.raw(
        `SELECT x FROM unnest(ARRAY['analytics.v_erp_stock_on_hand','analytics.ods_branch_checks','kepler_ods.kdil']) x
          WHERE to_regclass(x) IS NULL`,
      )).rows.map((r) => r.x);
      if (faltan.length) { noMedido(`la base local no tiene ${faltan.join(', ')}`); throw new Error(RB); }
      const user = await trx('public.users').whereNull('deleted_at').first('id');
      const marca = await trx('catalog.brands').whereRaw('COALESCE(is_commercial, true)').first('id');
      const lista = await trx('commercial.price_lists').where({ is_default: true }).whereNull('deleted_at').first('id');
      if (!user || !marca || !lista) { noMedido('la base local no tiene usuario, marca comercial o lista default'); throw new Error(RB); }

      // ── Siembra: 3 sucursales de una zona de prueba, 5 productos, kdil y la frescura ──
      const wh = async (code) => (await trx('commercial.warehouses').insert({
        tenant_id: T, code, kepler_code: code, name: `Prueba ${code}`, short_label: code, kind: 'central', active: true,
        purchase_zone: 'ZZ-ZONA-316', display_order: Number(code.slice(1)),
      }).returning('id'))[0].id;
      const Z1 = await wh('Z1'); const Z2 = await wh('Z2'); const Z3 = await wh('Z3');
      const prod = async (nombre, sku, articulo = null) => (await trx('catalog.products').insert({
        tenant_id: T, brand_id: marca.id, nombre, sku, articulo, activo: true,
      }).returning('id'))[0].id;
      const HAY = await prod('ZZ316 HAY', 'ZZ316A');
      const CERO = await prod('ZZ316 CERO', 'ZZ316B');
      const NADIE = await prod('ZZ316 NADIE', 'ZZ316C');
      const VIVO = await prod('ZZ316 VIVO', 'ZZ316D');
      const LEGADO = await prod('ZZ316 LEGADO', null, ' ZZ316D ');
      // [MCP.11] Una promoción de Kepler dada de alta como producto: sin registro en kdil (en Z1 sería
      // «no se maneja», que bloquea a un producto normal). Nombre y sku fuera de «ZZ316» para no tocar §3.
      const PROMO = await prod('2 ZZPROMO = GRATIS 1 MAS', 'ZZ317P');
      for (const p of [HAY, CERO, NADIE, VIVO, LEGADO, PROMO]) {
        await trx('commercial.product_prices').insert({ tenant_id: T, price_list_id: lista.id, product_id: p, price: 10, tax_rate: 0.16 });
      }
      const kd = (suc, sku, qty) => trx('kepler_ods.kdil').insert({
        sucursal: suc, c1: suc, c2: 1, c3: sku, c4: qty, c8: 0, c9: 0, c6: trx.fn.now(), c7: trx.fn.now(),
      });
      // Z1: HAY 14, CERO 0, VIVO 9 · Z2: CERO 7, HAY 3 · Z3 (vieja): CERO 0, NADIE 0. NADIE no está en Z1 ni Z2.
      await kd('Z1', 'ZZ316A', 14); await kd('Z1', 'ZZ316B', 0); await kd('Z1', 'ZZ316D', 9);
      await kd('Z2', 'ZZ316B', 7); await kd('Z2', 'ZZ316A', 3);
      await kd('Z3', 'ZZ316B', 0); await kd('Z3', 'ZZ316C', 0);
      const chk = (suc, hace) => trx.raw(
        `INSERT INTO analytics.ods_branch_checks (tenant_id, lane, sucursal, last_check_at, tables_checked, rows_shipped, last_error)
         VALUES (?, 'ods_live_hot', ?, now() - (? || ' hours')::interval, 30, 0, NULL)
         ON CONFLICT (tenant_id, lane, sucursal) DO UPDATE SET last_check_at = EXCLUDED.last_check_at, last_error = NULL`,
        [T, suc, String(hace)],
      );
      await chk('Z1', 0); await chk('Z2', 1); await chk('Z3', 10);
      const SUC = [{ id: Z1, code: 'Z1' }, { id: Z2, code: 'Z2' }, { id: Z3, code: 'Z3' }];

      const vista = (await trx.raw(
        `SELECT count(*)::int n FROM analytics.v_erp_stock_on_hand WHERE warehouse_id = ANY(?::uuid[])`, [[Z1, Z2, Z3]],
      )).rows[0].n;
      if (vista !== 7) { noMedido(`la vista local no ve la siembra de kdil (${vista} de 7 filas): su definición difiere`); throw new Error(RB); }

      console.log('\n[1] El resolvedor: los cuatro estados y el gemelo');
      const { estado } = await M.estado.estadoDeProductos(trx, SUC, [HAY, CERO, NADIE, LEGADO]);
      ok(estado(Z1, HAY).state === 'con_existencia' && estado(Z1, HAY).qty === 14, 'Z1 · HAY 14 → con_existencia');
      ok(estado(Z1, CERO).state === 'agotado', 'Z1 · CERO en 0 → agotado');
      ok(estado(Z1, NADIE).state === 'no_se_maneja', 'Z1 · NADIE sin registro → no_se_maneja');
      ok(estado(Z1, LEGADO).state === 'con_existencia' && estado(Z1, LEGADO).qty === 9 && estado(Z1, LEGADO).twin_product_id === VIVO,
        'Z1 · el LEGADO toma la existencia de su gemelo (9), no 0');
      ok(estado(Z3, CERO).state === 'sin_dato' && estado(Z3, NADIE).state === 'sin_dato',
        'NEGATIVA: Z3 con lectura de hace 10 h → sin_dato aunque la vista diga 0');

      console.log('\n[2] La zona');
      const zona = await M.zoneStock(trx, Z1);
      ok(zona.unmeasured_reason === null && zona.warehouses.map((w) => w.short).join() === 'Z1,Z2,Z3', `las 3 sucursales, la del vendedor primero (${zona.warehouses.map((w) => w.short)})`);
      ok(zona.warehouses.map((w) => w.stale).join() === 'false,false,true', 'Z3 viaja stale; Z1 y Z2 al día');
      ok(JSON.stringify(zona.stock[CERO]) === JSON.stringify([0, 7, null]), `CERO: [0, 7, null] (vino ${JSON.stringify(zona.stock[CERO])})`);
      ok(JSON.stringify(zona.stock[LEGADO]) === JSON.stringify(zona.stock[VIVO]) && zona.stock[LEGADO]?.[0] === 9, 'el legado viaja con la fila de su gemelo');
      ok(zona.stock[NADIE] === undefined, 'NADIE (0 sólo en la sucursal vieja) no viaja');

      console.log('\n[3] El catálogo con stock_state=1');
      let cat = null, sinEstado = null, ms = null;
      try {
        const t0 = Date.now();
        cat = await trx.transaction((sp) => new M.Pricing({ run: (a, b) => (typeof a === 'function' ? a : b)(sp) }, ctxDe(user.id, 'vendedor_ruta'), { ladders: async () => new Map() })
          .listPrices(lista.id, { warehouseId: Z1, stockState: true, search: 'ZZ316', pricedOnly: true, sort: 'product', pageSize: 100 }));
        ms = Date.now() - t0;
        sinEstado = await trx.transaction((sp) => new M.Pricing({ run: (a, b) => (typeof a === 'function' ? a : b)(sp) }, ctxDe(user.id, 'vendedor_ruta'), { ladders: async () => new Map() })
          .listPrices(lista.id, { warehouseId: Z1, search: 'ZZ316', pricedOnly: true, sort: 'product', pageSize: 100 }));
      } catch (e) {
        noMedido(`el catálogo no corrió contra la base local (${e.message.split('\n')[0]})`);
      }
      if (cat) {
        const filas = cat.data;
        const por = new Map(filas.map((f) => [f.product_id, f]));
        ok(filas.length === 5, `los 5 productos de la prueba (${filas.length})`);
        ok(por.get(HAY)?.stock_state === 'con_existencia' && Number(por.get(HAY)?.stock_available) === 14, 'HAY: con_existencia, 14 desde la vista canónica');
        ok(por.get(CERO)?.stock_state === 'agotado', 'CERO: agotado');
        ok(por.get(NADIE)?.stock_state === 'no_se_maneja' && por.get(NADIE)?.stock_available === null, 'NADIE: no_se_maneja');
        ok(por.get(LEGADO)?.stock_state === 'con_existencia' && por.get(LEGADO)?.stock_twin_product_id === VIVO && Number(por.get(LEGADO)?.stock_available) === 9,
          'LEGADO: la existencia del gemelo, con stock_twin_product_id');
        ok(typeof por.get(HAY)?.stock_checked_at === 'string', 'cada renglón dice de cuándo es la lectura');
        // Cruce de DOS implementaciones: el orden lo pone el SQL; el estado, la regla en TS.
        const estados = filas.map((f) => f.stock_state);
        const primeraNsm = estados.indexOf('no_se_maneja');
        ok(primeraNsm >= 0 && estados.slice(primeraNsm).every((s) => s === 'no_se_maneja'),
          `los no_se_maneja quedan AL FINAL (${estados.join(' · ')})`);
        const nombres = filas.slice(0, primeraNsm).map((f) => f.product_name);
        ok(JSON.stringify(nombres) === JSON.stringify([...nombres].sort()), 'dentro del grupo se respeta el orden pedido (por nombre)');
        ok(filas.every((f) => !('stock_medible' in f) && !('stock_qty' in f)), 'las columnas auxiliares no viajan');
        console.log(`    (catálogo local con stock_state: ${ms} ms — base local, no es la cifra de prod)`);
        const s0 = sinEstado.data[0];
        ok(sinEstado.data.length === 5 && !('stock_state' in s0), 'NEGATIVA: sin stock_state el renglón no trae estado (como antes)');
      }

      console.log('\n[4] [DN.7] La revisión en addLine del vendedor (ADR-115: ya no bloquea)');
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP316-CLI', name: 'Cliente prueba MCP.3.16', active: true, default_price_list_id: lista.id,
      }).returning('id');
      // `[DN.8]` La clave se SIEMBRA en roles de prueba (se revierten con la transacción) en vez de
      // depender de que la base traiga `vendedor_ruta` con ella: la del CI no la trae y por eso [4]–[6]
      // nunca se habían medido allí. Nada del servicio depende del NOMBRE del rol, sólo de la clave.
      const ROL_V = 'zz_mcp316_vendedor';
      const ROL_SIN = 'zz_mcp316_sin_clave';
      await trx('identity.role_permissions').insert([
        { tenant_id: T, role_name: ROL_V, permissions: JSON.stringify({ VENDOR_APP_ACCESS: true }) },
        { tenant_id: T, role_name: ROL_SIN, permissions: JSON.stringify({}) },
      ]);
      const vend = pedidos(M.Orders, trx, user.id, ROL_V);
      const tieneClave = (await trx.raw(
        `SELECT 1 FROM identity.role_permissions WHERE role_name = ? AND deleted_at IS NULL AND (permissions ->> 'VENDOR_APP_ACCESS') = 'true'`,
        [ROL_V],
      )).rows.length > 0;
      if (!tieneClave) {
        noMedido('no quedó sembrado el rol de prueba con VENDOR_APP_ACCESS: la revisión no se puede ejercer');
      } else {
        const o = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-02' });
        const e1 = await falla(() => vend.addLine(o.id, { product_id: CERO, quantity: 2 }));
        ok(e1 === null, `⭐ agotado en Z1 → se GUARDA, ya no hay 409 (${e1 ? (e1.getStatus ? e1.getStatus() : e1.message) : 'pasó'})`);
        const r1 = await trx('commercial.order_lines').where({ order_id: o.id, product_id: CERO }).first('id', 'quantity');
        ok(r1 && Number(r1.quantity) === 2, 'el renglón del agotado quedó en el pedido con su cantidad');
        const l1 = await vend.addLine(o.id, { product_id: NADIE, quantity: 1, source_warehouse_id: Z2 });
        const b1 = l1 && l1.stock_review;
        ok(l1 && l1.stock_state === 'no_se_maneja' && b1 && b1.warehouse_short === 'Z2' && b1.product_name === 'ZZ316 NADIE',
          `la respuesta trae el estado y el NOMBRE del producto (${l1 && l1.stock_state})`);
        const o1b = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-05' });
        const l1b = await vend.addLine(o1b.id, { product_id: CERO, quantity: 2 });
        const r1b = l1b && l1b.stock_review;
        ok(l1b && l1b.stock_state === 'agotado' && r1b && r1b.warehouse_short === 'Z1'
          && r1b.alternatives.length === 1 && r1b.alternatives[0].short === 'Z2' && r1b.alternatives[0].qty === 7,
          `agotado con la alternativa de la zona en la respuesta: «${r1b && r1b.message}»`);
        ok(r1b && r1b.message === 'Puede estar agotado en Z1 · Z2 tiene 7' && !/no se puede/i.test(r1b.message),
          `el mensaje exacto ya no dice «No se puede agregar» («${r1b && r1b.message}»)`);
        const l2 = await vend.addLine(o1b.id, { product_id: NADIE, quantity: 1 });
        const b2 = l2 && l2.stock_review;
        // [MCP.3.16] ADR-056: Z3 tiene la lectura vieja, así que NO se puede afirmar «tampoco hay en tu zona».
        ok(l2 && l2.stock_state === 'no_se_maneja' && b2 && b2.alternatives.length === 0
          && b2.message === 'Z1 no lo maneja · sin dato de Z3',
          `nadie al día lo tiene, pero Z3 no se midió → «${b2 && b2.message}»`);
        ok(b2 && !/tu zona/.test(b2.message), 'NEGATIVA: con una sucursal sin dato no se dice «tu zona»');
        const l3 = await vend.addLine(o1b.id, { product_id: HAY, quantity: 50 });
        ok(l3 && l3.product_id === HAY && l3.stock_state === 'con_existencia' && l3.stock_review.insuficiente === true,
          'con existencia (14) se agrega aunque pida 50, y dice que no alcanza (insuficiente)');
        const l4 = await vend.addLine(o1b.id, { product_id: NADIE, quantity: 1, source_warehouse_id: Z3 });
        ok(l4 && l4.stock_state === 'sin_dato' && /Sin dato/.test(l4.stock_review.message || ''),
          `NEGATIVA: de Z3 (lectura vieja) es sin_dato, nunca «con existencia» ni «agotado» («${l4 && l4.stock_review && l4.stock_review.message}»)`);
        const tele = pedidos(M.Orders, trx, user.id, ROL_SIN);
        const o5 = await tele.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-06' });
        const l5 = await tele.addLine(o5.id, { product_id: CERO, quantity: 1 });
        ok(l5 && l5.stock_state === null && l5.stock_review === null, 'NEGATIVA: un rol sin VENDOR_APP_ACCESS no se revisa (stock_state null)');
        // [MCP.3.16] El legado se guarda con SU id (la pantalla casa la fila por él); su existencia
        // sale del gemelo (9 en Z1).
        const l6 = await vend.addLine(o1b.id, { product_id: LEGADO, quantity: 1 });
        ok(l6 && l6.product_id === LEGADO && l6.stock_state === 'con_existencia',
          `el LEGADO se guarda con su propio id y la existencia de su gemelo (vino ${l6 && l6.product_id}, ${l6 && l6.stock_state})`);
        // [MCP.11] La promoción no es mercancía: se agrega y no se revisa.
        const l7 = await vend.addLine(o1b.id, { product_id: PROMO, quantity: 1 });
        ok(l7 && l7.product_id === PROMO && l7.stock_state === null, '[MCP.11] una promoción («= GRATIS») se agrega y no se revisa');
        // [DN.7] updateLine: mover el renglón a una sucursal en 0 se HACE y lo dice (antes: 409).
        const oz = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z2, requested_delivery_date: '2030-01-07' });
        const lz = await vend.addLine(oz.id, { product_id: CERO, quantity: 2 });
        ok(lz && lz.stock_state === 'con_existencia', `control: CERO en Z2 (7) tiene existencia (${lz && lz.stock_state})`);
        const ez = await falla(() => vend.updateLine(oz.id, lz.id, { quantity: 2, source_warehouse_id: Z1 }));
        const gz = await trx('commercial.order_lines').where({ id: lz.id }).first('source_warehouse_id');
        ok(ez === null && gz && gz.source_warehouse_id === Z1,
          `⭐ mover el renglón a Z1 (en 0) se HACE, ya no hay 409 (${ez ? (ez.getStatus ? ez.getStatus() : ez.message) : 'pasó'})`);
        const uz = await vend.updateLine(oz.id, lz.id, { quantity: 3 });
        ok(uz && uz.stock_state === null, 'ajustar la cantidad de un renglón que ya tenía algo no se revisa (stock_state null)');
        const ozb = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z2, requested_delivery_date: '2030-01-08' });
        const lzb = await vend.addLine(ozb.id, { product_id: CERO, quantity: 1 });
        const uzb = await vend.updateLine(ozb.id, lzb.id, { quantity: 1, source_warehouse_id: Z1 });
        ok(uzb && uzb.stock_state === 'agotado' && uzb.stock_review && uzb.stock_review.warehouse_short === 'Z1',
          `y la respuesta del cambio de sucursal dice «agotado» en Z1 (${uzb && uzb.stock_state})`);

        console.log('\n[5] replaceLines (lote de la sincronización offline) NO bloquea');
        const o2 = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-03' });
        const r7 = await vend.replaceLines(o2.id, { lines: [{ product_id: CERO, quantity: 1 }, { product_id: HAY, quantity: 2 }] });
        const g7 = await trx('commercial.order_lines').where({ order_id: o2.id }).pluck('product_id');
        ok(r7 && r7.added === 2 && g7.includes(CERO) && g7.includes(HAY),
          `el agotado del lote se guarda (no desaparece de un pedido que la sincronización va a colocar): added=${r7 && r7.added}, skipped=${JSON.stringify(r7 && r7.skipped)}`);

        console.log('\n[6] VEX.3 — el legado se cobra con la escalera de Kepler de su GEMELO');
        // Un motor que SÓLO conoce el sku del gemelo (ZZ316D) y cobra 23.20 con IVA (20 sin IVA). Si el
        // pedido no resuelve el gemelo, no hay escalera y cae al cálculo anterior (10): ése es el rojo.
        const pedidosSku = [];
        const motorGemelo = {
          ladders: async (_t, branch, skus) => { pedidosSku.push(...(skus || [])); return new Map((skus || []).filter((s) => s === 'ZZ316D').map((s) => [s, { rungs: {} }])); },
          priceLine: async (_t, a) => (a.sku === 'ZZ316D' ? { line_total: 23.2, unit_price: 20, tax_rate: 0.16 } : { line_total: null, unit_price: null }),
        };
        const vendMotor = pedidos(M.Orders, trx, user.id, ROL_V, motorGemelo);
        const o3 = await vendMotor.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-04' });
        const l8 = await vendMotor.addLine(o3.id, { product_id: LEGADO, quantity: 1 });
        const g8 = await trx('commercial.order_lines').where({ id: l8.id }).first('product_id', 'unit_price', 'line_total');
        ok(pedidosSku.includes('ZZ316D'), `la escalera se pidió con el sku del gemelo (pidió ${JSON.stringify(pedidosSku)})`);
        ok(g8 && g8.product_id === LEGADO && Number(g8.unit_price) === 20 && Number(g8.line_total) === 23.2,
          `el renglón GUARDADO del legado lleva el precio de Kepler del gemelo: unit ${g8 && g8.unit_price}, total ${g8 && g8.line_total} (sin gemelo serían 10 / 11.60)`);
        const l9 = await vendMotor.addLine(o3.id, { product_id: HAY, quantity: 1 });
        const g9 = await trx('commercial.order_lines').where({ id: l9.id }).first('unit_price');
        ok(g9 && Number(g9.unit_price) === 10, `NEGATIVA: un producto con su propio sku (ZZ316A) sin escalera cae al cálculo anterior (${g9 && g9.unit_price})`);
      }

      throw new Error(RB);
    });
  } catch (e) {
    if (!String(e.message).includes(RB)) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
