/**
 * MCP.10 — Revisión en caja de un pedido de preventa surtido, contra una base REAL.
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció
 * contra una base real, con el payload de la pantalla. Aquí se cargan por ts-node los servicios
 * REALES —el pedido (`CommercialOrdersService`), el surtido (`PresalePickingService`) y la revisión
 * (`PresaleReviewService`)— y se recorre el camino entero:
 *
 *   [0] La migración `20261029125146` se aplica DENTRO de la transacción (idempotente, con su
 *       prueba negativa del CHECK) y se revierte con todo lo demás.
 *   [1] Surtido con faltantes: el reporte guarda el `line_id` y, del renglón BORRADO, su copia
 *       (`restore`) para poder reponerlo.
 *   [2] La bandeja y el detalle de la caja: lo pedido sale del reporte, el borrado aparece al final.
 *   [3] Negativas: cobrar más de lo pedido (400) no escribe nada.
 *   [4] El cierre con el payload de la pantalla: «Ya se completó» sube el renglón recortado y REPONE
 *       el borrado; el total se recalcula y se cruza contra la suma de renglones (dos caminos);
 *       queda quién y cuándo; revisar dos veces es 409.
 *   [5] «No hay» sobre algo que el surtidor dio completo recorta el pedido; dejarlo vacío es 400.
 *
 * Sólo se sustituye la infraestructura ajena (motor de precios, alertas, push, stock, alcance). Todo
 * corre en UNA transacción que se revierte: no deja filas. Lo que la base no tiene con qué
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
  const d = (n) => path.join(__dirname, `.stub-mcp10-${n}.js`);
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), 'module.exports = { TenantKnexService: class {}, TenantContextService: class {}, ScopeService: class {}, isPlatformAdminRole: (r) => r === "superadmin" };'],
    '../commercial-pricing/commercial-pricing.service': [d('pricing'), 'module.exports = { CommercialPricingService: class {} };'],
    '../commercial-inventory/commercial-inventory.service': [d('inventory'), 'module.exports = { CommercialInventoryService: class {} };'],
    '../commercial-alerts/alerts.service': [d('alerts'), 'module.exports = { AlertsService: class {} };'],
    '../commercial-push/commercial-push.service': [d('push'), 'module.exports = { CommercialPushService: class {} };'],
    '../presale-control/presale-control.service': [d('presale'), 'module.exports = { PresaleControlService: class {} };'],
    './order-stock.service': [d('stock'), 'module.exports = { OrderStockService: class {} };'],
    '../commercial-quotes/quote-pricing.service': [d('quotes'), 'module.exports = { QuotePricingService: class {}, rungDeRotulo: () => "base" };'],
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
    migracion: require(path.join(RAIZ, 'database/migrations-newdb/20261029125146_presale_picks_revision_caja.js')),
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

      console.log('\n[0] La migración, dentro de la transacción');
      await trx.transaction((sp) => S.migracion.up(sp));
      const cols = (await trx.raw(
        `SELECT array_agg(column_name::text ORDER BY column_name) c FROM information_schema.columns
          WHERE table_schema = 'commercial' AND table_name = 'presale_picks' AND column_name IN ('review','reviewed_at','reviewed_by','reviewed_by_name')`,
      )).rows[0].c || [];
      ok(cols.length === 4, `presale_picks tiene las 4 columnas de la revisión (${cols.join(', ')})`);
      await trx.transaction((sp) => S.migracion.up(sp));
      ok(true, 'la migración corre dos veces sin fallar (idempotente)');

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
      const quotes = { ladders: async () => new Map(), priceLine: async () => ({ line_total: null, unit_price: null }) };
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

      // ── Datos ──
      const W = await trx('commercial.warehouses').where({ kepler_code: '02' }).whereNull('deleted_at').first('id');
      const gente = await trx('identity.users').where({ tenant_id: T }).whereNull('deleted_at').orderBy('username').limit(3).pluck('id');
      const prods = await trx('catalog.products').whereNotNull('sku').limit(3).pluck('id');
      if (!W || gente.length < 3 || prods.length < 3) {
        noMedido('la base no tiene la sucursal 02, 3 usuarios o 3 productos con sku');
        throw new Error(RB);
      }
      const [V, SURT, CAJA] = gente;
      const [p1, p2, p3] = prods;
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP10-CLI', name: 'Cliente prueba MCP.10', active: true, erp_customer_code: 'ZZ10', erp_source_branch: '02',
      }).returning('id');
      const pedido = async (renglones) => como(V, async () => {
        const o = await orders.createDraft({ customer_id: cli.id, warehouse_id: W.id, requested_delivery_date: '2030-01-02' });
        for (const r of renglones) await orders.addLine(o.id, r);
        await orders.place(o.id);
        return o.id;
      });
      const lineas = async (id) => trx('commercial.order_lines').where({ order_id: id }).orderBy('line_number').select('id', 'product_id', 'quantity', 'requested_quantity', 'line_total', 'unit_price');
      const surtir = async (id, picked) => {
        await como(SURT, () => picking.start(id));
        const ls = await lineas(id);
        return como(SURT, () => picking.finish(id, { lines: ls.map((l) => ({ line_id: l.id, picked: picked(l) })) }));
      };

      const A = await pedido([{ product_id: p1, quantity: 1 }, { product_id: p2, quantity: 3 }, { product_id: p3, quantity: 2 }]);
      const oA = await trx('commercial.orders').where({ id: A }).first('status', 'delivery_type', 'code');
      if (oA.status !== 'confirmed' || oA.delivery_type !== 'route') {
        noMedido(`el pedido de prueba quedó ${oA.status}/${oA.delivery_type}, no confirmed/route: la bandeja del surtidor no lo ve`);
        throw new Error(RB);
      }
      const [l1, l2, l3] = await lineas(A);

      console.log('\n[1] Surtido con faltantes: el reporte guarda con qué reponer');
      const fin = await surtir(A, (l) => (l.id === l2.id ? 2 : l.id === l3.id ? 0 : Number(l.quantity)));
      ok(fin.outcome === 'con_faltantes', `el surtido cierra con faltantes (${fin.outcome})`);
      ok(fin.report.adjusted[0]?.line_id === l2.id, 'el renglón recortado lleva su line_id');
      const copia = fin.report.removed[0]?.restore;
      ok(copia?.product_id === p3 && Number(copia?.quantity) === 2 && Number(copia?.unit_price) === Number(l3.unit_price),
        `el renglón borrado guarda su copia (producto, cantidad 2, precio ${l3.unit_price})`);
      ok((await lineas(A)).length === 2, 'el surtido sí borró el renglón que no hubo (como siempre)');

      console.log('\n[2] La bandeja y el detalle de la caja');
      const bandeja = await como(CAJA, () => review.inbox());
      const fila = bandeja.data.find((r) => r.order_id === A);
      ok(fila?.state === 'por_revisar' && fila?.pick_outcome === 'con_faltantes', 'el pedido aparece por revisar, con faltantes');
      const det = await como(CAJA, () => review.detail(A));
      const por = new Map(det.lines.map((l) => [l.key, l]));
      ok(por.get(l2.id)?.ordered === 3 && por.get(l2.id)?.picked === 2, 'mazapán: pedido 3 (del reporte), surtido 2 (del pedido)');
      ok(por.get('borrado:0')?.restorable === true && por.get('borrado:0')?.product_id === p3 && por.get('borrado:0')?.ordered === 2,
        'el borrado vuelve al final, reponible, con lo pedido');
      ok(det.lines.every((l) => 'stock' in l), 'cada renglón dice la existencia (o null si no se pudo leer)');

      console.log('\n[3] Negativas que no escriben');
      const total0 = Number((await trx('commercial.orders').where({ id: A }).first('total')).total);
      const n1 = await falla(CAJA, () => review.finish(A, { lines: [{ key: l1.id, final: 5 }, { key: l2.id, final: 2 }, { key: 'borrado:0', final: 0 }] }), 400, /no se cobra más de lo pedido/);
      ok(n1.ok, `cobrar más de lo pedido → 400 (${n1.msg})`);
      const n2 = await falla(CAJA, () => review.finish(A, { lines: [{ key: l1.id, final: 1 }] }), 400, /Falta revisar/);
      ok(n2.ok, `sin revisar todo → 400 (${n2.msg})`);
      const tras = await trx('commercial.presale_picks').where({ order_id: A }).first('reviewed_at');
      ok(!tras.reviewed_at && Number((await trx('commercial.orders').where({ id: A }).first('total')).total) === total0, 'nada quedó escrito');

      console.log('\n[4] El cierre con el payload de la pantalla');
      avisos.length = 0;
      const r = await como(CAJA, () => review.finish(A, { lines: [{ key: l1.id, final: 1 }, { key: l2.id, final: 3 }, { key: 'borrado:0', final: 2 }] }));
      const despues = await lineas(A);
      const de = (p) => despues.find((l) => l.product_id === p);
      ok(Number(de(p2)?.quantity) === 3, `el mazapán subió a 3 (vino ${de(p2)?.quantity})`);
      ok(Number(de(p3)?.quantity) === 2 && Number(de(p3)?.requested_quantity) === 2, 'el renglón borrado se REPUSO con 2 y su requested_quantity');
      const suma = +despues.reduce((s, l) => s + Number(l.line_total), 0).toFixed(2);
      const total = Number((await trx('commercial.orders').where({ id: A }).first('total')).total);
      ok(Math.abs(total - suma) < 0.005 && Math.abs(r.review.total_after - total) < 0.005,
        `el total del pedido (${total}) = la suma de sus renglones (${suma}) = lo que devolvió la revisión (${r.review.total_after})`);
      ok(r.review.total_after > r.review.total_before, `el total subió al completar (${r.review.total_before} → ${r.review.total_after})`);
      ok(JSON.stringify(r.review.lines.map((l) => l.resolution)) === '["bien","completo","completo"]', `resoluciones: ${r.review.lines.map((l) => l.resolution)}`);
      const pk = await trx('commercial.presale_picks').where({ order_id: A }).first('reviewed_by', 'reviewed_at', 'review');
      ok(pk.reviewed_by === CAJA && !!pk.reviewed_at && pk.review?.lines?.length === 3, 'queda quién revisó, cuándo y el detalle');
      const hist = await trx('commercial.order_status_history').where({ order_id: A }).whereRaw(`reason LIKE 'revisión en caja:%'`).count({ n: '*' }).first();
      ok(Number(hist.n) === 1, 'el historial del pedido registra la revisión');
      ok(avisos.some((a) => /La caja completó 2 productos/.test(a.title)), `la vendedora recibe el aviso (${avisos.map((a) => a.title).join(' | ') || 'ninguno'})`);
      const n3 = await falla(CAJA, () => review.finish(A, { lines: [{ key: l1.id, final: 1 }] }), 409, /ya lo revisó/);
      ok(n3.ok, `revisar dos veces → 409 (${n3.msg})`);
      const bandeja2 = await como(CAJA, () => review.inbox());
      ok(bandeja2.data.find((x) => x.order_id === A)?.state === 'revisado', 'en la bandeja pasa a «revisado»');

      console.log('\n[5] «No hay» sobre algo que el surtidor dio completo');
      const B = await pedido([{ product_id: p1, quantity: 2 }, { product_id: p2, quantity: 1 }]);
      await surtir(B, (l) => Number(l.quantity));
      const [b1, b2] = await lineas(B);
      const n4 = await falla(CAJA, () => review.finish(B, { lines: [{ key: b1.id, final: 0 }, { key: b2.id, final: 0 }] }), 400, /quedaría vacío/);
      ok(n4.ok, `dejar el pedido vacío → 400 (${n4.msg})`);
      const rB = await como(CAJA, () => review.finish(B, { lines: [{ key: b1.id, final: 1 }, { key: b2.id, final: 1 }] }));
      const bDespues = await lineas(B);
      ok(Number(bDespues.find((l) => l.id === b1.id)?.quantity) === 1, 'el renglón que dio completo el surtidor se recorta a 1');
      ok(rB.review.lines[0].resolution === 'no_hubo' && rB.review.total_after < rB.review.total_before, `no_hubo y el total baja (${rB.review.total_before} → ${rB.review.total_after})`);

      console.log('\n[6] Lo no revisado no caduca; lo de antes de la revisión no aparece');
      const C = await pedido([{ product_id: p1, quantity: 1 }]);
      await surtir(C, (l) => Number(l.quantity));
      // Se surtió hace 5 días y nadie lo revisó (se mueven las dos horas: el CHECK exige fin ≥ inicio).
      await trx.raw(`UPDATE commercial.presale_picks SET started_at = now() - interval '5 days 1 hour', finished_at = now() - interval '5 days' WHERE order_id = ?`, [C]);
      const D = await pedido([{ product_id: p2, quantity: 1 }]);
      await surtir(D, (l) => Number(l.quantity));
      // D es «de antes de la revisión» (lo que la migración marca así).
      await trx('commercial.presale_picks').where({ order_id: D }).update({ review_required: false });
      const nueva = await trx('commercial.presale_picks').where({ order_id: C }).first('review_required');
      ok(nueva.review_required === true, 'un surtido nuevo nace con review_required = true (default de la columna)');
      const b3 = await como(CAJA, () => review.inbox());
      ok(b3.data.find((x) => x.order_id === C)?.state === 'por_revisar', 'el de hace 5 días sigue por revisar (antes desaparecía a los 3)');
      ok(!b3.data.some((x) => x.order_id === D), 'el de antes de la revisión NO aparece');
      const mostrados = b3.data.filter((x) => x.state === 'por_revisar').length;
      ok(b3.pending === mostrados && b3.truncated === false,
        `el pendiente contado (${b3.pending}) = las filas por revisar de la lista (${mostrados}): dos caminos, el mismo número`);

      throw new Error(RB);
    });
  } catch (e) {
    if (e.message !== RB) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
