/**
 * MCP.19 — Recuento del día del vendedor, contra una base REAL.
 *
 * Servicios REALES por ts-node: el pedido (levantar, corregir, cancelar), el surtido, el monitoreo de
 * visitas y el recuento. Se recorre el día como pasa en la calle y en el almacén:
 *
 *   [0] Arranque: la firma que Nest inyecta al servicio y al controlador (#414 tiró la API con el CI verde).
 *   [1] El vendedor levanta 2 pedidos, deja 1 borrador, cancela 1 con motivo; el surtidor surte uno
 *       completo y otro con faltantes; visita a 2 clientes de su ruta (uno con pedido, uno «cerrado»).
 *   [2] Su recuento cambia exactamente en eso, y cada número se puede recorrer (la lista suma lo mismo).
 *   [3] «Mis pedidos» y el recuento dicen lo mismo de cada pedido (es el mismo armado).
 *   [4] Su supervisor ve EXACTAMENTE el mismo recuento.
 *   [5] Negativas: alguien que no es su supervisor (403), id inválido, fecha inválida y fecha futura (400).
 *   [6] El día de ayer no trae lo de hoy.
 *   [7] [MCP.20] «Mis pedidos» por día: el de hoy trae lo levantado hoy (lo mismo que el recuento), ayer no;
 *       un día futuro o que no existe es 400; «visto» marca sólo los pedidos que se mandan.
 *
 * Se mide el CAMBIO contra lo que ya había hoy en la base local. Lo que es infraestructura ajena (motor
 * de precios de Kepler, alertas, push, la mesa de preventa del ODS) se sustituye. Todo corre en UNA
 * transacción que se revierte: no deja filas.
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const cfg = require('../knexfile-newdb.js').development;
const T = '00000000-0000-0000-0000-00000000d01c';
const RAIZ = path.resolve(__dirname, '..', '..');

// ⛔ Destino seguro: sólo la base local de Docker.
const destino = (() => {
  const c = cfg.connection;
  if (c && c.connectionString) return new URL(c.connectionString).hostname;
  return c && c.host;
})();
if (!['127.0.0.1', 'localhost'].includes(String(destino))) {
  console.error(`⛔ DATABASE_URL_NEW apunta a «${destino}», no a la base local. No se corre.`);
  process.exit(2);
}
const knex = require('knex')(cfg);

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };
const noMedido = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
const RB = '__rb__';
const r2 = (n) => Math.round(n * 100) / 100;

function cargar() {
  const d = (n) => path.join(__dirname, `.stub-mcp19-${n}.js`);
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), `module.exports = {
      TenantKnexService: class {}, TenantContextService: class {}, ScopeService: class {},
      isPlatformAdminRole: (r) => r === "superadmin",
      RolesGuard: class {}, RequireAuthGuard: class {},
      RequirePermissions: () => () => undefined, RequireAnyPermission: () => () => undefined,
      Permission: new Proxy({}, { get: (_t, k) => String(k) }),
    };`],
    '../commercial-pricing/commercial-pricing.service': [d('pricing'), 'module.exports = { CommercialPricingService: class {} };'],
    '../commercial-inventory/commercial-inventory.service': [d('inventory'), 'module.exports = { CommercialInventoryService: class {} };'],
    '../commercial-alerts/alerts.service': [d('alerts'), 'module.exports = { AlertsService: class {} };'],
    '../commercial-push/commercial-push.service': [d('push'), 'module.exports = { CommercialPushService: class {} };'],
    '../presale-control/presale-control.service': [d('presale'), 'module.exports = { PresaleControlService: class {} };'],
    './order-stock.service': [d('stock'), 'module.exports = { OrderStockService: class {} };'],
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
    Visitas: lib('commercial-vendor-routes/visit-monitor.service.ts').VisitMonitorService,
    Recuento: lib('presale-picking/recuento-dia.service.ts').SellerDayRecapService,
    Ctrl: lib('presale-picking/recuento-dia.controller.ts').SellerDayRecapController,
    // [MCP.20] Si el controlador de «Mis pedidos» no carga aquí (pide más dependencias), su firma queda NO MEDIDA.
    SellerCtrl: (() => { try { return lib('presale-picking/presale-picking.controller.ts').PresaleSellerStatusController; } catch (e) { return e; } })(),
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

  console.log('\n[0] Arranque: lo que Nest inyecta');
  const nombres = (xs) => (xs || []).map((t) => t && t.name);
  const ctor = nombres(Reflect.getMetadata('design:paramtypes', S.Recuento));
  ok(JSON.stringify(ctor) === '["TenantKnexService","TenantContextService","PresalePickingService","VisitMonitorService"]',
    `el servicio recibe ${JSON.stringify(ctor)} (ninguno undefined: no hay ciclo de importación)`);
  ok(JSON.stringify(nombres(Reflect.getMetadata('design:paramtypes', S.Ctrl))) === '["SellerDayRecapService"]', 'el controlador recibe el servicio');
  const met = nombres(Reflect.getMetadata('design:paramtypes', S.Ctrl.prototype, 'recap'));
  ok(JSON.stringify(met) === '["String","String"]', `recap(date, user_id) → ${JSON.stringify(met)}`);
  if (S.SellerCtrl instanceof Error) {
    noMedido(`[MCP.20] no cargó el controlador de «Mis pedidos» (${S.SellerCtrl.message.split('\n')[0]}): su firma no se midió`);
  } else {
    const st = nombres(Reflect.getMetadata('design:paramtypes', S.SellerCtrl.prototype, 'status'));
    ok(JSON.stringify(st) === '["String"]', `[MCP.20] status(date) → ${JSON.stringify(st)}`);
    const se = nombres(Reflect.getMetadata('design:paramtypes', S.SellerCtrl.prototype, 'seen'));
    ok(JSON.stringify(se) === '["Object"]', `[MCP.20] seen(body) → ${JSON.stringify(se)}`);
  }

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // ── Infraestructura ──
      const cur = { trx, userId: null };
      const rolDe = new Map();
      const tk = { run: (fn) => fn(cur.trx) };
      const tenantCtx = { get: () => ({ tenantId: T, userId: cur.userId, roleName: rolDe.get(cur.userId) || 'vendedor_ruta' }), requireTenantId: () => T };
      const scope = { warehouseIds: async () => null, readParam: async () => null };
      const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
      const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: () => undefined };
      const push = { notifyCustomer: async () => undefined, sendToCustomer: async () => undefined, sendToUser: async () => undefined };
      const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
      const escalera = () => ({ name: null, unit_base: 'PZA', rungs: {
        base: { rung: 'base', label: 'PZA', price: 20, size: 1, volume: null },
        pack: { rung: 'pack', label: null, price: null, size: null, volume: null },
        box: { rung: 'box', label: 'CJA', price: 200, size: 12, volume: null },
      } });
      const quotes = {
        ladders: async (_k, _b, skus) => new Map((skus || []).map((s) => [s, escalera()])),
        priceLine: async (_k, { quantity, rung }) => ({ line_total: +(quantity * (rung === 'box' ? 200 : 20)).toFixed(2), unit_price: rung === 'box' ? 200 : 20, tax_rate: 0.16 }),
      };
      // La mesa de preventa vive en el ODS: aquí se lee la fila del pedido de la base, por id o por autor.
      const presale = {
        pedidosParaGuias: async (t, f) => {
          const q = t('commercial.orders as o').leftJoin('commercial.customers as c', 'c.id', 'o.customer_id')
            .whereIn('o.status', ['confirmed', 'fulfilled', 'cancelled']).whereNull('o.deleted_at');
          if (f.orderIds) q.whereIn('o.id', f.orderIds);
          if (f.autorId) q.where('o.user_id', f.autorId);
          const rows = await q.select('o.id', 'o.code', 'o.status', 'o.created_at', 'o.total', 'c.name as customer_name',
            t.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS requested_delivery_date`),
            t.raw('(SELECT count(*)::int FROM commercial.order_lines l WHERE l.order_id = o.id) AS lines'));
          return rows.map((r) => ({ ...r, total: Number(r.total), warehouse_name: 'Sucursal prueba', link: null, delivery: null, possible_documents: 0 }));
        },
        candidatosParaCampo: async () => ({ candidates: [] }),
      };
      const orders = new S.Orders(tk, tenantCtx, pricing, {}, alerts, push, stock, quotes);
      const picking = new S.Picking(tk, tenantCtx, scope, orders, presale, alerts, push);
      const visitas = new S.Visitas(tk, tenantCtx);
      const recuento = new S.Recuento(tk, tenantCtx, picking, visitas);
      const ctrl = new S.Ctrl(recuento);

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

      // ── Gente y datos: el vendedor de prueba, su supervisor y alguien ajeno ──
      const v = await trx('identity.users').where({ username: 'vendedor_demo2' }).first('id', 'supervisor_id');
      const W = await trx('commercial.warehouses').where({ kepler_code: '02' }).whereNull('deleted_at').first('id');
      const prods = await trx('catalog.products').where({ activo: true }).whereNull('deleted_at').whereNotNull('sku')
        .whereRaw(`nombre !~* '=[[:space:]]*GRATIS'`).whereRaw(`nombre !~* 'DEVOLUC|DESCUENTO'`).orderBy('sku').limit(2).select('id');
      if (!v || !v.supervisor_id || !W || prods.length < 2) {
        noMedido('la base no tiene vendedor_demo2 con supervisor, la sucursal 02 o 2 productos');
        throw new Error(RB);
      }
      const V = v.id;
      const SUP = v.supervisor_id;
      const AJENO = (await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').whereNotIn('id', [V, SUP])
        .whereRaw('id NOT IN (SELECT id FROM identity.users WHERE supervisor_id IS NOT NULL AND id = ?)', [V]).orderBy('username').first('id'))?.id;
      const SURT = AJENO;
      rolDe.set(V, 'vendedor_ruta').set(SUP, 'supervisor_ventas').set(AJENO, 'vendedor_ruta');
      const hoy = (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS d`)).rows[0].d;
      const ayer = (await trx.raw(`SELECT ((now() AT TIME ZONE 'America/Mexico_City')::date - 1)::text AS d`)).rows[0].d;

      // Su ruta de hoy la dice el monitoreo (la misma regla que usa el recuento).
      const mon = await como(V, () => visitas.monitor(hoy, V));
      const ruta = mon.vendors.find((x) => x.user_id === V)?.routes?.[0] ?? null;

      const antes = await como(V, () => ctrl.recap(undefined, undefined));
      const cli = async (n) => (await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP19-' + n, name: 'Cliente MCP.19 ' + n, active: true, sales_route: ruta, erp_customer_code: 'ZZ19' + n, erp_source_branch: '02',
      }).returning('id'))[0].id;
      const [cA, cB, cC] = [await cli('A'), await cli('B'), await cli('C')];
      const levantar = (c, renglones, mandar = true) => como(V, async () => {
        const o = await orders.createDraft({ customer_id: c, warehouse_id: W.id, requested_delivery_date: hoy });
        for (const r of renglones) await orders.addLine(o.id, r);
        if (mandar) await orders.place(o.id);
        return o.id;
      });
      const total = async (id) => Number((await trx('commercial.orders').where({ id }).first('total')).total);
      const lineas = async (id) => trx('commercial.order_lines').where({ order_id: id }).orderBy('line_number').select('id', 'quantity');

      console.log('\n[1] Un día en la calle y en el almacén');
      const A = await levantar(cA, [{ product_id: prods[0].id, quantity: 2 }, { product_id: prods[1].id, quantity: 1 }]);
      const B = await levantar(cA, [{ product_id: prods[0].id, quantity: 3 }, { product_id: prods[1].id, quantity: 2 }]);
      const C = await levantar(cB, [{ product_id: prods[0].id, quantity: 1 }], false);
      // D va con el cliente A: el monitoreo cuenta «con pedido» también a un cliente cuyo pedido se canceló
      // (sólo excluye borradores), y B tiene que quedar «sin venta · cerrado».
      const D = await levantar(cA, [{ product_id: prods[1].id, quantity: 1 }]);
      await como(V, () => orders.cancel(D, 'Pedido duplicado'));
      ok((await trx('commercial.orders').whereIn('id', [A, B, C, D]).orderByRaw('array_position(?::uuid[], id)', [[A, B, C, D]]).pluck('status')).join() === 'confirmed,confirmed,draft,cancelled',
        'levantó A y B, dejó C en borrador y canceló D');
      await como(SURT, () => picking.start(A));
      await como(SURT, async () => picking.finish(A, { lines: (await lineas(A)).map((l) => ({ line_id: l.id, picked: Number(l.quantity) })) }));
      await como(SURT, () => picking.start(B));
      const [b1, b2] = await lineas(B);
      const finB = await como(SURT, () => picking.finish(B, { lines: [{ line_id: b1.id, picked: Number(b1.quantity) }, { line_id: b2.id, picked: 0, reason: 'sin_existencia' }] })); // [MCP.18] D4: el faltante lleva su motivo
      const bajoB = r2(finB.report.total_before - finB.report.total_after);
      ok(finB.outcome === 'con_faltantes' && bajoB > 0, `el surtidor surtió A completo y B con faltantes (bajó $${bajoB})`);
      if (ruta) {
        const vis = (c, extra) => trx('commercial.vendor_visits').insert({
          tenant_id: T, user_id: V, customer_id: c, visited_at: trx.raw(`now() - interval '30 minutes'`), ended_at: trx.raw(`now() - interval '25 minutes'`),
          latitude: 20.35, longitude: -102.03, ...extra,
        });
        await vis(cA, { had_order: true });
        await vis(cB, { no_sale_reason: 'cerrado' });
      }

      console.log('\n[2] Su recuento cambia exactamente en eso');
      const r = await como(V, () => ctrl.recap(undefined, undefined));
      ok(r.date === hoy && r.user_id === V, `es su día (${r.date})`);
      ok(r.orders.count - antes.orders.count === 2, `levantados: +2 (${antes.orders.count} → ${r.orders.count}); el borrador y el cancelado no cuentan`);
      ok(r2(r.orders.total - antes.orders.total) === r2((await total(A)) + (await total(B))), `lo levantado sube lo de A + B ($${r2(r.orders.total - antes.orders.total)})`);
      ok(r2(r.orders_list.reduce((s, o) => s + o.total, 0)) === r.orders.total && r.orders_list.length === r.orders.count,
        `el número se recorre: la lista tiene ${r.orders_list.length} y suma $${r.orders.total}`);
      const de = (id) => r.orders_list.find((o) => o.order_id === id);
      ok(de(A)?.pick === 'completo' && de(B)?.pick === 'con_faltantes', 'A completo, B con faltantes');
      ok(r.picking && r.picking.completo - antes.picking.completo === 1 && r.picking.con_faltantes - antes.picking.con_faltantes === 1,
        'los conteos del surtido suben 1 y 1');
      ok(r.picking && r2(r.picking.removed_total - antes.picking.removed_total) === bajoB, `«se quitaron» sube $${bajoB}`);
      ok(r.pending.drafts.some((o) => o.order_id === C), 'el borrador C está en «Pendiente»');
      ok(r.cancelled.some((o) => o.order_id === D && o.reason === 'Pedido duplicado'), 'D está en «Cancelados» con su motivo');
      if (ruta) {
        const va = antes.visits, vr = r.visits;
        ok(vr && va && vr.route_customers - va.route_customers === 3, `su ruta tiene 3 clientes más (${va?.route_customers} → ${vr?.route_customers})`);
        ok(vr && va && vr.visited_on_route - va.visited_on_route === 2, 'visitó 2 más de su ruta');
        ok(vr && vr.not_visited.some((c) => c.customer_id === cC), 'el cliente C, sin visita, está en «Pendiente»');
        ok(vr && (vr.no_sale_reasons.find((m) => m.reason === 'cerrado')?.count ?? 0) - (va?.no_sale_reasons.find((m) => m.reason === 'cerrado')?.count ?? 0) === 1,
          'el motivo «cerrado» suma 1');
      } else {
        noMedido('vendedor_demo2 no tiene ruta hoy en la base local: no se midieron visitas');
        ok(r.visits === null && !!r.visits_unmeasured_reason, `sin ruta, las visitas se declaran («${r.visits_unmeasured_reason}»), no salen en cero`);
      }

      console.log('\n[3] «Mis pedidos» y el recuento dicen lo mismo');
      const st = await como(V, () => picking.sellerStatus());
      const sA = st.data.find((x) => x.order_id === A), sB = st.data.find((x) => x.order_id === B);
      ok(sA?.finished?.outcome === de(A)?.pick && sB?.finished?.outcome === de(B)?.pick, 'el estado de A y B coincide en las dos pantallas');

      console.log('\n[4] Su supervisor ve el mismo recuento');
      const rs = await como(SUP, () => ctrl.recap(undefined, V));
      const huella = (x) => JSON.stringify({ o: x.orders, p: x.picking, v: x.visits, d: x.pending, c: x.cancelled, l: x.orders_list });
      ok(rs.user_id === V && huella(rs) === huella(r), 'el supervisor recibe exactamente lo mismo que el vendedor');

      console.log('\n[5] Negativas');
      const n1 = await falla(AJENO, () => ctrl.recap(undefined, V), 403, /no es de tu equipo/);
      ok(n1.ok, `alguien que no es su supervisor → 403 (${n1.msg})`);
      const n2 = await falla(V, () => ctrl.recap(undefined, 'no-es-un-id'), 400, /user_id/);
      ok(n2.ok, `id inválido → 400 (${n2.msg})`);
      const n3 = await falla(V, () => ctrl.recap('2026-13-45', undefined), 400, /YYYY-MM-DD/);
      ok(n3.ok, `fecha inválida → 400 (${n3.msg})`);
      const n4 = await falla(V, () => ctrl.recap('2099-01-01', undefined), 400, /todavía no llega/);
      ok(n4.ok, `fecha futura → 400 (${n4.msg})`);

      console.log('\n[6] El día de ayer no trae lo de hoy');
      const ry = await como(V, () => ctrl.recap(ayer, undefined));
      ok(ry.date === ayer && ![A, B].some((id) => ry.orders_list.some((o) => o.order_id === id)) && !ry.pending.drafts.some((o) => o.order_id === C),
        `el recuento del ${ayer} no tiene A, B ni C`);

      console.log('\n[7] [MCP.20] «Mis pedidos» por día');
      const sh = await como(V, () => picking.sellerStatus(hoy));
      const idsHoy = new Set(sh.data.map((x) => x.order_id));
      ok(sh.date === hoy && idsHoy.has(A) && idsHoy.has(B), `el día de hoy trae A y B (${idsHoy.size} pedidos)`);
      ok(r.orders_list.every((o) => idsHoy.has(o.order_id)), `todo lo que el recuento cuenta como levantado está en la lista del día (${r.orders_list.length})`);
      const sy = await como(V, () => picking.sellerStatus(ayer));
      ok(sy.date === ayer && !sy.data.some((x) => [A, B].includes(x.order_id)), 'el día de ayer no trae A ni B');
      ok(Array.isArray(sh.unseen_days) && sh.unseen_days.includes(hoy), `hoy sale entre los días con reporte sin ver (${JSON.stringify(sh.unseen_days)})`);
      const nD1 = await falla(V, () => picking.sellerStatus('2099-01-01'), 400, /todavía no llega/);
      ok(nD1.ok, `un día futuro → 400 (${nD1.msg})`);
      const nD2 = await falla(V, () => picking.sellerStatus('2026-02-30'), 400, /AAAA-MM-DD/);
      ok(nD2.ok, `un día que no existe → 400 (${nD2.msg})`);
      const sinDia = await como(V, () => picking.sellerStatus());
      ok(sinDia.date === undefined && sinDia.unseen_days === undefined, 'sin día (apps de antes) responde como siempre');
      const visto = async (id) => (await trx('commercial.presale_picks').where({ order_id: id }).first('seller_seen_at'))?.seller_seen_at ?? null;
      const nS = await falla(V, () => picking.sellerSeen(['no-es-un-id']), 400, /order_ids/);
      ok(nS.ok && (await visto(A)) === null, `un id inválido → 400 y no marca nada (${nS.msg})`);
      await como(V, () => picking.sellerSeen([A]));
      ok((await visto(A)) !== null && (await visto(B)) === null, '«visto» con [A] marca A y deja B como nuevo');

      throw new Error(RB);
    });
  } catch (e) {
    if (e.message !== RB) { fail++; console.log('  ✗ error:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
