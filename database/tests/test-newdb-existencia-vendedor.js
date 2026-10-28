/**
 * MCP.3.16 — Existencia en la toma de pedido del vendedor: estado por sucursal, gemelo del legado,
 * frescura del carril y BLOQUEO al agregar.
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
 *   4. addLine del vendedor: agotado → 409 con alternativas; nadie al día lo tiene pero una sucursal
 *      está vieja → 409 que NO dice «no hay en tu zona» y nombra la que falta; con existencia pasa;
 *      `sin_dato` (sucursal vieja) NO bloquea; un rol sin VENDOR_APP_ACCESS no se bloquea; el legado
 *      se guarda con SU id (la existencia es la del gemelo).
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
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), 'module.exports = { TenantKnexService: class {}, TenantContextService: class {}, isPlatformAdminRole: (r) => r === "superadmin" || r === "admin" };'],
    '@megadulces/contracts': [d('contracts'), `module.exports = { ...require(${JSON.stringify(contrato)}), INVOICE_ISSUER_PORT: "INVOICE_ISSUER_PORT" };`],
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

function pedidos(Orders, trx, userId, rol) {
  const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
  const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: () => undefined };
  const push = { sendToCustomer: async () => undefined };
  const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
  const quotes = { ladders: async () => new Map(), priceLine: async () => ({ line_total: null, unit_price: null }) };
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
      for (const p of [HAY, CERO, NADIE, VIVO, LEGADO]) {
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

      console.log('\n[4] El bloqueo en addLine del vendedor');
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP316-CLI', name: 'Cliente prueba MCP.3.16', active: true, default_price_list_id: lista.id,
      }).returning('id');
      const vend = pedidos(M.Orders, trx, user.id, 'vendedor_ruta');
      const tieneClave = (await trx.raw(
        `SELECT 1 FROM identity.role_permissions WHERE role_name = 'vendedor_ruta' AND deleted_at IS NULL AND (permissions ->> 'VENDOR_APP_ACCESS') = 'true'`,
      )).rows.length > 0;
      if (!tieneClave) {
        noMedido('en la base local el rol vendedor_ruta no tiene VENDOR_APP_ACCESS: el bloqueo no se puede ejercer');
      } else {
        const o = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-02' });
        const e1 = await falla(() => vend.addLine(o.id, { product_id: CERO, quantity: 2 }));
        const b1 = e1 && e1.getResponse ? e1.getResponse() : null;
        ok(e1 && e1.getStatus && e1.getStatus() === 409, `agotado en Z1 → 409 (vino ${e1 ? (e1.getStatus ? e1.getStatus() : e1.message) : 'sin error'})`);
        ok(b1 && b1.code === 'SIN_EXISTENCIA' && b1.state === 'agotado' && b1.warehouse_short === 'Z1'
          && b1.alternatives.length === 1 && b1.alternatives[0].short === 'Z2' && b1.alternatives[0].qty === 7,
          `con la alternativa de la zona: «${b1 && b1.message}»`);
        ok(b1 && b1.message === 'No se puede agregar: no hay existencias en Z1 · Z2 tiene 7' && b1.product_name === 'ZZ316 CERO',
          `el mensaje exacto (el de la pantalla) y el NOMBRE en product_name («${b1 && b1.message}»)`);
        const e2 = await falla(() => vend.addLine(o.id, { product_id: NADIE, quantity: 1 }));
        const b2 = e2 && e2.getResponse ? e2.getResponse() : null;
        // [MCP.3.16] ADR-056: Z3 tiene la lectura vieja, así que NO se puede afirmar «no hay en tu zona».
        ok(b2 && b2.state === 'no_se_maneja' && b2.alternatives.length === 0
          && b2.message === 'No se puede agregar: no hay existencias en Z1 · sin dato de Z3',
          `nadie al día lo tiene, pero Z3 no se midió → «${b2 && b2.message}»`);
        ok(b2 && !/tu zona/.test(b2.message), 'NEGATIVA: con una sucursal sin dato no se dice «no hay en tu zona»');
        const l3 = await vend.addLine(o.id, { product_id: HAY, quantity: 50 });
        ok(l3 && l3.product_id === HAY, 'NEGATIVA: con existencia (14) se agrega aunque pida 50');
        const e4 = await falla(() => vend.addLine(o.id, { product_id: NADIE, quantity: 1, source_warehouse_id: Z3 }));
        ok(e4 === null, `NEGATIVA: de Z3 (lectura vieja → sin_dato) NO se bloquea (${e4 ? e4.message : 'pasó'})`);
        const tele = pedidos(M.Orders, trx, user.id, 'telemarketing');
        const e5 = await falla(() => tele.addLine(o.id, { product_id: CERO, quantity: 1 }));
        ok(e5 === null, `NEGATIVA: un rol sin VENDOR_APP_ACCESS no se bloquea (${e5 ? e5.message : 'pasó'})`);
        // [MCP.3.16] El legado se guarda con SU id (la pantalla casa la fila por él); su existencia
        // sale del gemelo (9 en Z1), así que pasa.
        const l6 = await vend.addLine(o.id, { product_id: LEGADO, quantity: 1 });
        ok(l6 && l6.product_id === LEGADO, `el LEGADO se guarda con su propio id, no el del gemelo (vino ${l6 && l6.product_id})`);
        const guardados = await trx('commercial.order_lines').where({ order_id: o.id }).pluck('product_id');
        ok(guardados.filter((p) => p === CERO).length === 1,
          'el agotado sólo entró por el rol sin la clave, nunca por el vendedor');

        console.log('\n[5] replaceLines (lote de la sincronización offline) NO bloquea');
        const o2 = await vend.createDraft({ customer_id: cli.id, warehouse_id: Z1, requested_delivery_date: '2030-01-03' });
        const r7 = await vend.replaceLines(o2.id, { lines: [{ product_id: CERO, quantity: 1 }, { product_id: HAY, quantity: 2 }] });
        const g7 = await trx('commercial.order_lines').where({ order_id: o2.id }).pluck('product_id');
        ok(r7 && r7.added === 2 && g7.includes(CERO) && g7.includes(HAY),
          `el agotado del lote se guarda (no desaparece de un pedido que la sincronización va a colocar): added=${r7 && r7.added}, skipped=${JSON.stringify(r7 && r7.skipped)}`);
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
