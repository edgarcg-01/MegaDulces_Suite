/**
 * MV.2 — Monitoreo vecinal (vendedores), contra una base REAL.
 *
 * Servicios REALES por ts-node (pedido, monitoreo de visitas y el monitoreo vecinal de vendedores):
 * se siembran visitas de hoy (con pedido, sin venta con motivo, abierta), un pedido levantado con el
 * servicio del pedido, la meta de su catorcena y puntos de ubicación, y se lee el resumen y el detalle.
 * Se mide el CAMBIO contra lo que ya había hoy. Lo cobrado en Kepler sale de una vista del ODS que la
 * base local no tiene: entonces se DECLARA no medido (y el avance contra la meta debe ser null).
 * Negativas: otra ruta, otra sucursal, sin sucursal, periodo en el futuro, id inválido.
 *
 * Todo corre en UNA transacción que se revierte: no deja filas.
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

function cargar() {
  const d = (n) => path.join(__dirname, `.stub-mv2-${n}.js`);
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), 'module.exports = { TenantKnexService: class {}, TenantContextService: class {}, ScopeService: class {}, isPlatformAdminRole: (r) => r === "superadmin" };'],
    '../commercial-pricing/commercial-pricing.service': [d('pricing'), 'module.exports = { CommercialPricingService: class {} };'],
    '../commercial-inventory/commercial-inventory.service': [d('inventory'), 'module.exports = { CommercialInventoryService: class {} };'],
    '../commercial-alerts/alerts.service': [d('alerts'), 'module.exports = { AlertsService: class {} };'],
    '../commercial-push/commercial-push.service': [d('push'), 'module.exports = { CommercialPushService: class {} };'],
    '../presale-control/presale-control.service': [d('presale'), 'module.exports = { PresaleControlService: class {} };'],
    './order-stock.service': [d('stock'), 'module.exports = { OrderStockService: class {} };'],
    // El rótulo de la caja del stub de abajo es CJA: con eso se elige el peldaño, como el real.
    '../commercial-quotes/quote-pricing.service': [d('quotes'), 'module.exports = { QuotePricingService: class {}, rungDeRotulo: (l, led) => (led && led.rungs.box && led.rungs.box.label === String(l || "").toUpperCase() ? "box" : "base") };'],
  };
  for (const [, [f, src]] of Object.entries(stubs)) fs.writeFileSync(f, src);
  process.on('exit', () => { for (const [, [f]] of Object.entries(stubs)) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } });
  const contracts = path.join(RAIZ, 'libs/contracts/src/index.ts');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, parent, ...rest) {
    if (req === '@megadulces/contracts') return contracts;
    if (req === '@megadulces/platform-core') return stubs[req][0];
    if (stubs[req] && parent && /[\\/]libs[\\/]commercial[\\/]/.test(parent.filename)) {
      if (req !== './order-stock.service' || /commercial-orders\.service\.ts$/.test(parent.filename)) return stubs[req][0];
    }
    return orig.call(this, req, parent, ...rest);
  };
  require('ts-node').register({
    transpileOnly: true, skipProject: true,
    compilerOptions: {
      module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node',
      experimentalDecorators: true, emitDecoratorMetadata: true, ignoreDeprecations: '6.0',
    },
  });
  const lib = (p) => require(path.join(RAIZ, 'libs/commercial/src/lib', p));
  return {
    Orders: lib('commercial-orders/commercial-orders.service.ts').CommercialOrdersService,
    Picking: lib('presale-picking/presale-picking.service.ts').PresalePickingService,
    Review: lib('presale-picking/presale-review.service.ts').PresaleReviewService,
    Visitas: lib('commercial-vendor-routes/visit-monitor.service.ts').VisitMonitorService,
    Vendedores: lib('commercial-vendor-routes/vecinal-vendors-monitor.service.ts').VecinalVendorsMonitorService,
  };
}

(async () => {
  let S;
  try {
    S = cargar();
  } catch (e) {
    noMedido(`no se pudieron cargar los servicios reales (${e.message.split('\n')[0]})`);
    console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const hayRevision = (await trx.raw(
        `SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'commercial' AND table_name = 'presale_picks' AND column_name = 'reviewed_at'`,
      )).rows[0].n === 1;
      if (!hayRevision) {
        noMedido('la base no tiene la migración de la revisión en caja (20261029125146)');
        throw new Error(RB);
      }

      // ── Infraestructura ──
      const cur = { trx, userId: null };
      const tk = { run: (fn) => fn(cur.trx) };
      const tenantCtx = { get: () => ({ tenantId: T, userId: cur.userId, roleName: 'superadmin' }), requireTenantId: () => T };
      const alcance = { v: null };
      const scope = { warehouseIds: async () => alcance.v, readParam: async () => null };
      const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
      const avisos = [];
      const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: (_t, u, a) => avisos.push({ u, ...a }) };
      const push = { notifyCustomer: async () => undefined, sendToCustomer: async () => undefined, sendToUser: async () => undefined };
      const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
      // El motor de Kepler simulado: PZA a $20 y CJA de 12 a $200 (IVA incluido). Los SKU de
      // `sinPrecio` no tienen escalera en la sucursal (así se ve un producto sin precio).
      const sinPrecio = new Set();
      const escalera = () => ({ name: null, unit_base: 'PZA', rungs: {
        base: { rung: 'base', label: 'PZA', price: 20, size: 1, volume: null },
        pack: { rung: 'pack', label: null, price: null, size: null, volume: null },
        box: { rung: 'box', label: 'CJA', price: 200, size: 12, volume: null },
      } });
      const quotes = {
        ladders: async (_k, _b, skus) => new Map((skus || []).filter((s) => !sinPrecio.has(s)).map((s) => [s, escalera()])),
        priceLine: async (_k, { sku, quantity, rung }) => (sinPrecio.has(sku)
          ? { line_total: null, unit_price: null, tax_rate: 0.16 }
          : { line_total: +(quantity * (rung === 'box' ? 200 : 20)).toFixed(2), unit_price: rung === 'box' ? 200 : 20, tax_rate: 0.16 }),
      };
      const orders = new S.Orders(tk, tenantCtx, pricing, {}, alerts, push, stock, quotes);
      const picking = new S.Picking(tk, tenantCtx, scope, orders, {}, alerts, push);
      const review = new S.Review(tk, scope, orders, picking);
      const monitor = new S.Vendedores(tk, tenantCtx, scope, new S.Visitas(tk, tenantCtx));

      const como = async (userId, fn) => {
        const antes = cur.userId;
        cur.userId = userId;
        try {
          return await trx.transaction(async (sp) => {
            cur.trx = sp;
            try { return await fn(); } finally { cur.trx = trx; }
          });
        } finally {
          cur.userId = antes;
        }
      };
      const falla = async (userId, fn, status, re) => {
        try {
          await como(userId, fn);
          return { ok: false, msg: 'no falló' };
        } catch (e) {
          const st = typeof e.getStatus === 'function' ? e.getStatus() : null;
          return { ok: st === status && re.test(e.message), msg: `${st ?? 'sin estado'}: ${e.message}` };
        }
      };

      // ── Datos: el vendedor de prueba con ruta vecinal todos los días (1V003) ──
      const V = (await trx('identity.users').where({ username: 'vendedor_demo2' }).first('id'))?.id;
      const YO = (await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').orderBy('username').first('id'))?.id;
      const W = await trx('commercial.warehouses').where({ kepler_code: '02' }).whereNull('deleted_at').first('id');
      const ruta = (await trx.raw(`SELECT value FROM trade.catalogs WHERE catalog_id = 'rutas' AND route_kind = 'vecinal' AND deleted_at IS NULL LIMIT 1`)).rows[0]?.value;
      const prods = await trx('catalog.products').where({ activo: true }).whereNull('deleted_at').whereNotNull('sku')
        .whereRaw(`nombre !~* '=[[:space:]]*GRATIS'`).whereRaw(`nombre !~* 'DEVOLUC|DESCUENTO'`).orderBy('sku').limit(2).select('id', 'sku', 'nombre');
      if (!V || !YO || !W || !ruta || prods.length < 2) {
        noMedido('la base no tiene vendedor_demo2, la sucursal 02, una ruta vecinal o 2 productos');
        throw new Error(RB);
      }
      const hoy = (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS d`)).rows[0].d;
      const q = { from: hoy, to: hoy };
      const cli = async (n) => (await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MV2-' + n, name: 'Cliente MV.2 ' + n, active: true, sales_route: ruta, erp_customer_code: 'ZZMV2' + n, erp_source_branch: '02',
      }).returning('id'))[0].id;
      const [cA, cB, cC, cD] = [await cli('A'), await cli('B'), await cli('C'), await cli('D')];
      // Visitas de hoy: A con pedido (7 min), B sin venta con motivo (3 min), C abierta.
      const vis = (c, ini, fin, extra = {}) => trx('commercial.vendor_visits').insert({
        tenant_id: T, user_id: V, customer_id: c, visited_at: trx.raw(`now() - (? || ' minutes')::interval`, [ini]),
        ended_at: fin == null ? null : trx.raw(`now() - (? || ' minutes')::interval`, [fin]), latitude: 20.35, longitude: -102.03, ...extra,
      });
      const antes = (await como(YO, () => monitor.vendors(q))).rows.find((r) => r.user_id === V);
      await vis(cA, 60, 53, { had_order: true });
      await vis(cB, 40, 37, { no_sale_reason: 'cerrado' });
      await vis(cC, 10, null);
      // D: cerró la visita sin venta y SIN decir por qué.
      await vis(cD, 25, 21);
      // El pedido que levantó en A (servicio real del pedido, como lo hace la app).
      const oA = await como(V, async () => {
        const o = await orders.createDraft({ customer_id: cA, warehouse_id: W.id, requested_delivery_date: '2030-01-02' });
        await orders.addLine(o.id, { product_id: prods[0].id, quantity: 2 });
        await orders.addLine(o.id, { product_id: prods[1].id, quantity: 1 });
        await orders.place(o.id);
        return o.id;
      });
      const totalA = Number((await trx('commercial.orders').where({ id: oA }).first('total')).total);
      // La meta de su catorcena y tres puntos de ubicación.
      const ini = (await trx.raw(`SELECT to_char(?::date - ((?::date - '2026-10-17'::date) % 14), 'YYYY-MM-DD') AS s`, [hoy, hoy])).rows[0].s;
      await trx('commercial.vendor_targets').where({ user_id: V, period_start: ini }).del();
      await trx('commercial.vendor_targets').insert({ tenant_id: T, user_id: V, period_start: ini, amount: 12000 });
      for (const m of [50, 30, 5]) {
        await trx.raw(`INSERT INTO public.route_location_pings (tenant_id, user_id, client_uuid, captured_at, lat, lng, accuracy_m, source)
                       VALUES (?, ?, gen_random_uuid(), now() - (? || ' minutes')::interval, 20.35, -102.03, 8, 'foreground')`, [T, V, m]);
      }

      console.log('\n[1] El resumen del vendedor');
      const r = (await como(YO, () => monitor.vendors(q))).rows.find((x) => x.user_id === V);
      const d = (k) => Number(r?.[k] ?? 0) - Number(antes?.[k] ?? 0);
      ok(!!r && r.routes.includes(ruta) && r.days_on_route === 1, `aparece con su ruta vecinal del día (${r?.routes?.join(', ')})`);
      ok(d('visits') === 4 && d('with_order') === 1 && d('no_sale_with_reason') === 1 && d('no_sale_without_reason') === 1 && d('open_visits') === 1,
        `visitas +4: 1 con pedido, 1 sin venta con motivo, 1 sin venta SIN motivo, 1 abierta (${d('visits')}, ${d('with_order')}, ${d('no_sale_with_reason')}, ${d('no_sale_without_reason')}, ${d('open_visits')})`);
      ok(d('orders') === 1 && Math.abs(d('ordered_total') - totalA) < 0.005, `levantó 1 pedido por $${totalA} (lo de la app)`);
      const sabado = new Date(`${hoy}T12:00:00Z`).getUTCDay() === 0;
      if (sabado) noMedido('hoy es domingo: la meta del día es 0 por regla');
      else ok(r.target === 1000, `meta del día = 12,000 ÷ 12 días con actividad = ${r.target}`);
      if (r.charged === null) {
        noMedido(`lo cobrado en Kepler no se pudo medir en esta base: «${r.charged_unmeasured_reason}»`);
        ok(r.progress_pct === null, 'sin cobrado medido, el avance contra la meta es null (no 0 %)');
      } else ok(r.charged >= 0, `cobrado en Kepler: ${r.charged}`);
      ok(r.gps_points - Number(antes?.gps_points ?? 0) === 3 && !!r.gps_last_at, `trae su ubicación: +3 puntos, el último a las ${r.gps_last_at}`);
      ok(r.planned_customers !== null && r.planned_customers >= 3, `en un día, los clientes de su ruta salen del monitoreo de visitas (${r.planned_customers})`);
      ok(!!r.first_at && !!r.last_at && r.first_at <= r.last_at, 'primera y última actividad');

      console.log('\n[2] El detalle: cada cliente, qué se le levantó y cuánto tiempo');
      const det = await como(YO, () => monitor.vendorDetail(V, q));
      const va = det.visits.find((x) => x.customer_id === cA);
      const vb = det.visits.find((x) => x.customer_id === cB);
      const vc = det.visits.find((x) => x.customer_id === cC);
      ok(va?.status === 'con_pedido' && va?.minutes === 7 && va?.orders.length === 1 && Math.abs(va.ordered_total - totalA) < 0.005, 'A: con pedido, 7 min con él, su pedido y total');
      ok(va?.orders[0].lines.length === 2 && va.orders[0].lines.some((l) => l.product_name === prods[0].nombre && l.quantity === 2 && l.sku === prods[0].sku),
        'A: los productos que le levantó, con cantidad y SKU');
      ok(vb?.status === 'sin_pedido' && vb?.no_sale_reason === 'cerrado' && vb?.minutes === 3, 'B: sin venta, motivo «cerrado», 3 min');
      ok(vc?.status === 'abierta' && vc?.minutes === null, 'C: abierta, sin tiempo inventado');
      const vd = det.visits.find((x) => x.customer_id === cD);
      ok(vd?.status === 'sin_pedido' && vd?.no_sale_reason === null && vd?.minutes === 4, 'D: sin venta y sin motivo, 4 min');
      if (va?.charged === null) noMedido('lo que Kepler le cobró a cada cliente: sin la vista en esta base');
      ok(det.target === r.target && det.charged === r.charged, 'el detalle dice la misma meta y el mismo cobrado que la fila (un solo cálculo)');
      ok(det.gps.points.length >= 3 && det.gps.points.every((p, i, a) => i === 0 || a[i - 1].at <= p.at), 'el recorrido trae sus puntos, en orden');

      console.log('\n[3] Filtros, alcance y negativas');
      const otraRuta = await como(YO, () => monitor.vendors({ ...q, route: 'RUTA QUE NO EXISTE' }));
      ok(!otraRuta.rows.some((x) => x.user_id === V), 'filtrar por otra ruta lo saca');
      const suRuta = await como(YO, () => monitor.vendors({ ...q, route: ruta }));
      ok(suRuta.rows.some((x) => x.user_id === V) && suRuta.route_options.includes(ruta), 'filtrar por su ruta lo deja, y su ruta está en el selector');
      alcance.v = ['00000000-0000-0000-0000-000000000000'];
      const ajena = await como(YO, () => monitor.vendors(q));
      ok(!ajena.rows.some((x) => x.user_id === V), 'con OTRA sucursal en el alcance no aparece');
      const n0 = await falla(YO, () => monitor.vendorDetail(V, q), 404, /alcance/);
      ok(n0.ok, `y su detalle no se abre (${n0.msg})`);
      alcance.v = [];
      ok((await como(YO, () => monitor.vendors(q))).scope === 'ninguno', 'sin sucursal en el alcance: «ninguno»');
      alcance.v = null;
      const n1 = await falla(YO, () => monitor.vendors({ from: '2031-01-01' }), 400, /después de hoy/);
      ok(n1.ok, `periodo en el futuro → 400 (${n1.msg})`);
      const n2 = await falla(YO, () => monitor.vendorDetail('x', q), 400, /inválido/);
      ok(n2.ok, `id inválido → 400 (${n2.msg})`);

      throw new Error(RB);
    });
  } catch (e) {
    if (e.message !== RB) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
