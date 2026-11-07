/**
 * MV.1 — Monitoreo vecinal (surtidores y cajeras), contra una base REAL.
 *
 * Se cargan por ts-node los servicios REALES del pedido, el surtido, la revisión en caja y el
 * monitoreo, y se recorre: surtir dos pedidos (uno con un cambio por otro producto), revisar uno, y
 * leer el monitoreo. Se mide el CAMBIO contra lo que ya había hoy en la base, y lo «debió cobrarse»
 * se cruza contra la suma directa en SQL (dos implementaciones, el mismo número). Negativas: periodo
 * en el futuro o al revés, id inválido, y el alcance (sin sucursal / otra sucursal).
 *
 * Todo corre en UNA transacción que se revierte: no deja filas. Lo que la base no tiene con qué
 * comprobarse reporta NO MEDIDO (ADR-056), nunca verde.
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
  const d = (n) => path.join(__dirname, `.stub-mv1-${n}.js`);
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
    Monitor: lib('presale-picking/vecinal-monitor.service.ts').VecinalMonitorService,
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
      const monitor = new S.Monitor(tk, scope);

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

      // ── Datos ──
      const W = await trx('commercial.warehouses').where({ kepler_code: '02' }).whereNull('deleted_at').first('id', 'code');
      const gente = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').orderBy('username').limit(3).pluck('id');
      const prods = await trx('catalog.products').where({ activo: true }).whereNull('deleted_at').whereNotNull('sku')
        .whereRaw(`nombre !~* '=[[:space:]]*GRATIS'`).orderBy('sku').limit(4).select('id', 'sku', 'nombre');
      if (!W || gente.length < 3 || prods.length < 4) {
        noMedido('la base no tiene la sucursal 02, 3 usuarios o 4 productos');
        throw new Error(RB);
      }
      const [V, SURT, CAJA] = gente;
      const [p1, p2, p3, p4] = prods;
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MV1-CLI', name: 'Cliente prueba MV.1', active: true, erp_customer_code: 'ZZMV', erp_source_branch: '02',
      }).returning('id');
      const pedido = async (renglones) => como(V, async () => {
        const o = await orders.createDraft({ customer_id: cli.id, warehouse_id: W.id, requested_delivery_date: '2030-01-02' });
        for (const r of renglones) await orders.addLine(o.id, r);
        await orders.place(o.id);
        return o.id;
      });
      const lineas = async (id) => trx('commercial.order_lines').where({ order_id: id }).orderBy('line_number').select('id', 'product_id', 'quantity');
      const hoy = (await trx.raw(`SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS d`)).rows[0].d;
      const q = { from: hoy, to: hoy };
      const fila = (rows, id) => rows.find((r) => r.user_id === id) ?? null;

      // Lo que ya había hoy (otros pedidos de la base local): se mide el CAMBIO, no el absoluto.
      const s0 = fila((await como(CAJA, () => monitor.pickers(q))).rows, SURT);
      const c0 = await como(CAJA, () => monitor.cashiers(q));
      const caja0 = fila(c0.rows, CAJA);
      const d = (a, b, k) => Number(a?.[k] ?? 0) - Number(b?.[k] ?? 0);

      console.log('\n[1] Se surten dos pedidos: uno con faltante cambiado por otro, uno completo');
      const A = await pedido([{ product_id: p1.id, quantity: 1 }, { product_id: p2.id, quantity: 2 }]);
      const [a1, a2] = await lineas(A);
      await como(SURT, () => picking.start(A));
      await como(SURT, () => picking.finish(A, { lines: [{ line_id: a1.id, picked: 1 }, { line_id: a2.id, picked: 1, substitute: { product_id: p3.id, quantity: 1, unit: 'PZA' } }] }));
      const B = await pedido([{ product_id: p4.id, quantity: 3 }]);
      const [b1] = await lineas(B);
      await como(SURT, () => picking.start(B));
      await como(SURT, () => picking.finish(B, { lines: [{ line_id: b1.id, picked: 2 }] }));
      const s1 = fila((await como(CAJA, () => monitor.pickers(q))).rows, SURT);
      ok(d(s1, s0, 'taken') === 2 && d(s1, s0, 'finished') === 2, `el surtidor suma 2 tomados y 2 terminados (${d(s1, s0, 'taken')}, ${d(s1, s0, 'finished')})`);
      ok(d(s1, s0, 'with_shortage') === 2, `los dos con faltante (${d(s1, s0, 'with_shortage')})`);
      ok(d(s1, s0, 'substituted') === 1, `uno con cambio por otro producto (${d(s1, s0, 'substituted')})`);
      ok(s1.avg_minutes !== null && s1.avg_minutes >= 0, `trae su tiempo promedio (${s1.avg_minutes} min)`);

      const det = await como(CAJA, () => monitor.pickerOrders(SURT, q));
      const oA = det.data.find((o) => o.order_id === A);
      ok(!!oA && oA.customer_name === 'Cliente prueba MV.1' && oA.outcome === 'con_faltantes', 'el detalle trae el pedido, su cliente y cómo salió');
      const orig = oA?.lines.find((l) => l.product_name === p2.nombre);
      const sust = oA?.lines.find((l) => l.product_name === p3.nombre);
      ok(orig?.ordered === 2 && orig?.picked === 1 && orig?.substitute?.product_name === p3.nombre, `el original dice pedido 2 · surtido 1 · cambiado por ${p3.nombre}`);
      ok(sust?.substitutes_for === p2.nombre && sust?.sku === p3.sku, 'el sustituto dice en lugar de qué va, con su SKU');
      ok(oA?.lines.every((l) => l.final === null), 'sin revisar todavía: final = null (no un cero)');

      console.log('\n[2] La caja revisa uno (completa lo que faltó); el otro queda por revisar');
      const rev = await como(CAJA, () => review.detail(B));
      const r = await como(CAJA, () => review.finish(B, { lines: rev.lines.map((l) => ({ key: l.key, final: l.ordered })) }));
      const c1 = await como(CAJA, () => monitor.cashiers(q));
      const caja1 = fila(c1.rows, CAJA);
      ok(d(caja1, caja0, 'reviewed') === 1, `la cajera suma 1 revisado (${d(caja1, caja0, 'reviewed')})`);
      ok(Math.abs(d(caja1, caja0, 'should_charge') - r.review.total_after) < 0.005, `«debió cobrarse» sube justo el total que dejó la revisión ($${r.review.total_after})`);
      ok(d(caja1, caja0, 'completed_lines') === 1, `completó 1 producto (${d(caja1, caja0, 'completed_lines')})`);
      ok(caja1.avg_review_minutes === null, 'lo que tardó en revisar se declara no medido (null)');
      ok(c1.pending.count - c0.pending.count === 1, `queda 1 más por revisar (A) (${c0.pending.count} → ${c1.pending.count})`);
      // Dos caminos, el mismo número: lo debido de la cajera hoy, contra la suma directa en SQL.
      const directo = (await trx.raw(
        `SELECT coalesce(sum((pp.review->>'total_after')::numeric), 0)::float8 AS t FROM commercial.presale_picks pp
          JOIN commercial.orders o ON o.id = pp.order_id
         WHERE pp.reviewed_by = ? AND (pp.reviewed_at AT TIME ZONE 'America/Mexico_City')::date = ?::date
           AND o.delivery_type = 'route' AND o.deleted_at IS NULL`, [CAJA, hoy])).rows[0].t;
      ok(Math.abs(Number(directo) - caja1.should_charge) < 0.005, `el monitoreo (${caja1.should_charge}) = la suma directa en SQL (${Number(directo)})`);
      const s2 = fila((await como(CAJA, () => monitor.pickers(q))).rows, SURT);
      ok(d(s2, s0, 'adjusted_by_cashier') === 1, 'al surtidor se le cuenta 1 pedido ajustado por la caja');
      const dc = await como(CAJA, () => monitor.cashierOrders(CAJA, q));
      const oB = dc.data.find((o) => o.order_id === B);
      ok(oB?.lines[0]?.picked === 2 && oB?.lines[0]?.final === 3 && oB?.lines[0]?.sku === p4.sku, 'el detalle de la cajera: surtido 2 → quedó 3, con SKU');
      ok(Math.abs((oB?.should_charge ?? -1) - r.review.total_after) < 0.005 && oB?.wait_minutes !== null, 'con lo que debió cobrarse y su espera');

      console.log('\n[3] Negativas y alcance');
      const n1 = await falla(CAJA, () => monitor.pickers({ from: '2030-01-01' }), 400, /después de hoy/);
      ok(n1.ok, `un periodo en el futuro → 400 (${n1.msg})`);
      const n2 = await falla(CAJA, () => monitor.cashiers({ from: hoy, to: '2020-01-01' }), 400, /antes/);
      ok(n2.ok, `un periodo al revés → 400 (${n2.msg})`);
      const n3 = await falla(CAJA, () => monitor.pickerOrders('no-es-uuid', q), 400, /inválido/);
      ok(n3.ok, `un id que no es uuid → 400 (${n3.msg})`);
      alcance.v = [];
      const sin = await como(CAJA, () => monitor.pickers(q));
      ok(sin.scope === 'ninguno' && sin.rows.length === 0, 'sin sucursal en el alcance: «ninguno» y nada');
      alcance.v = ['00000000-0000-0000-0000-000000000000'];
      const otra = await como(CAJA, () => monitor.cashiers(q));
      ok(!fila(otra.rows, CAJA) && otra.scope === 'propios', 'con OTRA sucursal en el alcance no se ve lo de la 02');
      alcance.v = null;

      throw new Error(RB);
    });
  } catch (e) {
    if (e.message !== RB) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
