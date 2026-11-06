/**
 * MCP.13 — El surtidor cambia lo que faltó por otro producto, contra una base REAL.
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció
 * contra una base real, con el payload de la pantalla. Se cargan por ts-node los servicios REALES
 * —el pedido (`CommercialOrdersService`), el surtido (`PresalePickingService`) y la revisión en caja
 * (`PresaleReviewService`)— y se recorre el camino entero:
 *
 *   [1] Faltó 1 de 2: el original queda con lo que hubo y entra el sustituto con SU precio; el
 *       total se cruza contra la suma de renglones (dos caminos) y el reporte lo registra.
 *   [2] El surtidor y la caja lo ven: «en lugar de», y la caja NO pide completar el original.
 *   [3] La caja cierra con el payload de la pantalla y el total no se mueve.
 *   [4] No hubo nada del único renglón, pero se cambió: el pedido se surte (no queda vacío).
 *   [5] Negativas que no escriben: mismo producto, promoción, ya en el pedido, unidad que no
 *       existe, cambio sobre lo que sí hubo, sustituto sin precio de Kepler.
 *   [6] Las sugerencias corren su SQL real: ni el original, ni lo que ya está, ni promociones.
 *
 * Se sustituye sólo la infraestructura ajena (motor de precios de Kepler, alertas, push, alcance).
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
  const d = (n) => path.join(__dirname, `.stub-mcp13-${n}.js`);
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
      const scope = { warehouseIds: async () => null, readParam: async () => null };
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

      // ── Datos: tres productos vivos del mismo proveedor (así hay sugerencias que medir) ──
      const W = await trx('commercial.warehouses').where({ kepler_code: '02' }).whereNull('deleted_at').first('id');
      const gente = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').orderBy('username').limit(3).pluck('id');
      const prov = (await trx.raw(
        `SELECT supplier_id FROM catalog.products WHERE supplier_id IS NOT NULL AND sku IS NOT NULL AND activo AND deleted_at IS NULL
           AND nombre !~* '=[[:space:]]*GRATIS' GROUP BY supplier_id HAVING count(*) >= 8 ORDER BY count(*) DESC LIMIT 1`,
      )).rows[0];
      const prods = prov ? await trx('catalog.products')
        .where({ supplier_id: prov.supplier_id, activo: true }).whereNull('deleted_at').whereNotNull('sku')
        .whereRaw(`nombre !~* '=[[:space:]]*GRATIS'`).orderBy('sku').limit(4).select('id', 'sku', 'nombre') : [];
      const promo = await trx('catalog.products').where({ activo: true }).whereNull('deleted_at').whereNotNull('sku')
        .whereRaw(`nombre ~* '=[[:space:]]*GRATIS'`).first('id', 'nombre');
      if (!W || gente.length < 3 || prods.length < 4) {
        noMedido('la base no tiene la sucursal 02, 3 usuarios o 4 productos de un mismo proveedor');
        throw new Error(RB);
      }
      const [V, SURT, CAJA] = gente;
      const [p1, p2, p3, p4] = prods;
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP13-CLI', name: 'Cliente prueba MCP.13', active: true, erp_customer_code: 'ZZ13', erp_source_branch: '02',
      }).returning('id');
      const pedido = async (renglones) => como(V, async () => {
        const o = await orders.createDraft({ customer_id: cli.id, warehouse_id: W.id, requested_delivery_date: '2030-01-02' });
        for (const r of renglones) await orders.addLine(o.id, r);
        await orders.place(o.id);
        return o.id;
      });
      const lineas = async (id) => trx('commercial.order_lines').where({ order_id: id }).orderBy('line_number')
        .select('id', 'product_id', 'quantity', 'requested_quantity', 'line_total', 'qty_unit', 'qty_factor', 'qty_factor_source', 'notes');
      const totalDe = async (id) => Number((await trx('commercial.orders').where({ id }).first('total')).total);
      const sumaDe = async (id) => +(await lineas(id)).reduce((s, l) => s + Number(l.line_total), 0).toFixed(2);

      const A = await pedido([{ product_id: p1.id, quantity: 1 }, { product_id: p2.id, quantity: 2 }]);
      const oA = await trx('commercial.orders').where({ id: A }).first('status', 'delivery_type');
      if (oA.status !== 'confirmed' || oA.delivery_type !== 'route') {
        noMedido(`el pedido de prueba quedó ${oA.status}/${oA.delivery_type}, no confirmed/route: la bandeja del surtidor no lo ve`);
        throw new Error(RB);
      }
      const [a1, a2] = await lineas(A);
      await como(SURT, () => picking.start(A));

      console.log('\n[5] Negativas que no escriben (antes del cierre bueno)');
      const marcado = (sub, picked2 = 1) => ({ lines: [{ line_id: a1.id, picked: 1 }, { line_id: a2.id, picked: picked2, substitute: sub }] });
      const negativas = [
        ['el mismo producto', { product_id: p2.id, quantity: 1, unit: 'PZA' }, 1, /mismo producto/],
        ['uno que ya viene en el pedido', { product_id: p1.id, quantity: 1, unit: 'PZA' }, 1, /ya viene en este pedido/],
        ['una unidad que Kepler no declara', { product_id: p3.id, quantity: 1, unit: 'BTO' }, 1, /no se vende en BTO/],
        ['un cambio sobre lo que sí hubo', { product_id: p3.id, quantity: 1, unit: 'PZA' }, 2, /hubo todo/],
      ];
      if (promo) negativas.push(['una promoción', { product_id: promo.id, quantity: 1, unit: 'PZA' }, 1, /promoción/]);
      else noMedido('la base no tiene un producto de promoción («= GRATIS») para la negativa');
      for (const [que, sub, picked2, re] of negativas) {
        const n = await falla(SURT, () => picking.finish(A, marcado(sub, picked2)), 400, re);
        ok(n.ok, `cambiar por ${que} → 400 (${n.msg})`);
      }
      sinPrecio.add(String(p3.sku).trim());
      const nP = await falla(SURT, () => picking.finish(A, marcado({ product_id: p3.id, quantity: 1, unit: 'PZA' })), 400, /no tiene precio|no se vende/);
      ok(nP.ok, `un sustituto sin precio de Kepler → 400 (${nP.msg})`);
      sinPrecio.clear();
      const pkA0 = await trx('commercial.presale_picks').where({ order_id: A }).first('finished_at');
      ok(!pkA0.finished_at && (await lineas(A)).length === 2 && (await totalDe(A)) === (await sumaDe(A)), 'nada quedó escrito: el pedido sigue abierto, con sus 2 renglones');

      console.log('\n[1] Faltó 1 de 2: entra el sustituto con su precio');
      const total0 = await totalDe(A);
      // El payload de la pantalla: «Cambiar por otro producto» → elegir → 1 CJA.
      const fin = await como(SURT, () => picking.finish(A, marcado({ product_id: p3.id, quantity: 1, unit: 'CJA' })));
      const ls = await lineas(A);
      const nuevo = ls.find((l) => l.product_id === p3.id);
      ok(fin.outcome === 'con_faltantes', `cierra con faltantes (${fin.outcome})`);
      ok(Number(ls.find((l) => l.id === a2.id)?.quantity) === 1, 'el original quedó con lo que sí hubo (1)');
      ok(!!nuevo && Number(nuevo.quantity) === 12 && nuevo.qty_unit === 'CJA' && Number(nuevo.qty_factor) === 12 && nuevo.qty_factor_source === 'kepler_ladder',
        `el sustituto entró como 1 CJA = 12 piezas, con su sello (${nuevo?.quantity} ${nuevo?.qty_unit}×${nuevo?.qty_factor}, ${nuevo?.qty_factor_source})`);
      ok(Number(nuevo?.requested_quantity) === 12, 'su «pedido» es lo que se puso (la caja lo revisa contra eso)');
      ok(Number(nuevo?.line_total) === 200, `se cobra a SU precio de Kepler: $${nuevo?.line_total} (1 CJA a $200)`);
      ok(/En lugar de «/.test(nuevo?.notes ?? ''), `el renglón dice en lugar de qué va («${nuevo?.notes}»)`);
      const t1 = await totalDe(A);
      ok(Math.abs(t1 - (await sumaDe(A))) < 0.005 && Math.abs(fin.report.total_after - t1) < 0.005,
        `el total del pedido (${t1}) = la suma de renglones = lo que dice el reporte (${fin.report.total_after})`);
      ok(Math.abs(fin.report.total_before - total0) < 0.005, `el total de antes es el del pedido original (${fin.report.total_before} = ${total0})`);
      const sub = fin.report.substituted?.[0];
      ok(fin.report.substituted?.length === 1 && sub.line_id === nuevo?.id && sub.for_line_id === a2.id && sub.product_id === p3.id && sub.quantity === 1 && sub.unit === 'CJA',
        'el reporte registra qué se cambió, por qué, cuánto y el renglón nuevo');
      const pk = await trx('commercial.presale_picks').where({ order_id: A }).first('report');
      ok(pk.report?.substituted?.[0]?.line_id === nuevo?.id, 'y queda guardado en presale_picks.report');
      ok(avisos.some((a) => /1 cambiado por otro/.test(a.title)), `la vendedora lo sabe desde el aviso (${avisos.map((a) => a.title).join(' | ') || 'ninguno'})`);
      const hist = await trx('commercial.order_status_history').where({ order_id: A }).whereRaw(`reason LIKE '%cambió 1 por otro producto%'`).count({ n: '*' }).first();
      ok(Number(hist.n) === 1, 'el historial del pedido registra el cambio');

      console.log('\n[2] El surtidor y la caja lo ven');
      const det = await como(SURT, () => picking.detail(A));
      ok(det.lines.find((l) => l.line_id === nuevo?.id)?.substitutes?.product_name === p2.nombre, `el surtidor ve «en lugar de ${p2.nombre}»`);
      const rev = await como(CAJA, () => review.detail(A));
      const porKey = new Map(rev.lines.map((l) => [l.key, l]));
      ok(porKey.get(a2.id)?.ordered === 1 && porKey.get(a2.id)?.picked === 1, 'la caja NO pide completar el original: ya está cubierto (pedido 1, surtido 1)');
      ok(porKey.get(nuevo?.id)?.substitutes_for === p2.nombre && porKey.get(nuevo?.id)?.ordered === 1, 'el sustituto le dice a la caja en lugar de qué va');
      ok(!rev.lines.some((l) => l.key.startsWith('borrado:')), 'no aparece ningún borrado que reponer');

      console.log('\n[3] La caja cierra con el payload de la pantalla');
      const r = await como(CAJA, () => review.finish(A, { lines: rev.lines.map((l) => ({ key: l.key, final: l.ordered })) }));
      ok(Math.abs(r.review.total_after - t1) < 0.005, `«Está bien» en todo: el total no se mueve (${r.review.total_before} → ${r.review.total_after})`);
      ok(r.review.lines.every((l) => l.resolution === 'bien'), `resoluciones: ${r.review.lines.map((l) => l.resolution)}`);

      console.log('\n[4] No hubo nada del único renglón, pero se cambió');
      const B = await pedido([{ product_id: p1.id, quantity: 2 }]);
      const [b1] = await lineas(B);
      await como(SURT, () => picking.start(B));
      const finB = await como(SURT, () => picking.finish(B, { lines: [{ line_id: b1.id, picked: 0, substitute: { product_id: p4.id, quantity: 2, unit: 'PZA' } }] }));
      const lsB = await lineas(B);
      ok(lsB.length === 1 && lsB[0].product_id === p4.id && Number(lsB[0].quantity) === 2, 'el original se quitó y quedó el sustituto (2 PZA): el pedido no quedó vacío');
      ok(finB.report.removed[0]?.line_id === b1.id && finB.report.substituted?.[0]?.for_line_id === b1.id, 'el reporte dice que se quitó y por qué se cambió');
      const revB = await como(CAJA, () => review.detail(B));
      ok(revB.lines.length === 1 && revB.lines[0].substitutes_for === p1.nombre, 'la caja ve sólo el sustituto, con «en lugar de»');

      console.log('\n[6] Las sugerencias corren su SQL real');
      const C = await pedido([{ product_id: p1.id, quantity: 1 }, { product_id: p2.id, quantity: 1 }]);
      const [c1] = await lineas(C);
      const sug = await como(SURT, () => picking.substitutes(C, c1.id, ''));
      ok(sug.for_line_id === c1.id && sug.for_product_name === p1.nombre, `responde para el renglón pedido (${sug.data.length} sugerencias)`);
      if (!sug.data.length) noMedido('no hubo sugerencias para medir su contenido');
      ok(sug.data.length <= 12, 'nunca más de 12');
      ok(!sug.data.some((x) => x.product_id === p1.id || x.product_id === p2.id), 'ni el original ni lo que ya viene en el pedido');
      ok(!sug.data.some((x) => /=\s*GRATIS/i.test(x.product_name)), 'ninguna promoción');
      ok(sug.data.every((x) => x.units.length > 0 && x.units.every((u) => u.price != null)), 'todas con al menos una unidad con precio');
      ok(sug.data.every((x) => x.stock_state === 'con_existencia' || x.stock_state === 'sin_dato'), 'ninguna agotada ni «no se maneja»');
      ok(sug.data.some((x) => x.match === 'proveedor' || x.match === 'nombre_y_proveedor'), 'sugiere del mismo proveedor');
      const busca = await como(SURT, () => picking.substitutes(C, c1.id, String(p3.sku)));
      ok(busca.data.some((x) => x.product_id === p3.id && x.match === 'busqueda'), `buscar por SKU (${p3.sku}) lo encuentra`);
      const nB = await falla(SURT, () => picking.substitutes(C, a1.id, ''), 404, /no es de este pedido/);
      ok(nB.ok, `un renglón de otro pedido → 404 (${nB.msg})`);

      throw new Error(RB);
    });
  } catch (e) {
    if (e.message !== RB) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
