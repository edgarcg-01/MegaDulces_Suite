/**
 * MCP.18 — Justificantes de corregir, cancelar y quitar, contra una base REAL.
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció
 * contra una base real, con el payload de la pantalla. Se cargan por ts-node el CONTROLADOR real de
 * pedidos (el que recibe `{ reason_code, note }` de la app) y los servicios reales del pedido, el
 * surtido y la revisión en caja, y se recorre el camino entero:
 *
 *   [0] Arranque: la firma inyectada de `reopen`/`cancel` sigue siendo (String, Object).
 *   [1] «Corregir» con motivo: el pedido vuelve a borrador y la historia guarda «Etiqueta: nota».
 *   [2] Negativas que no escriben: motivo de otra lista, «Otro» sin nota, nota de más de 200.
 *   [3] D1: con el surtido empezado no se corrige (ni con `check_only`), y no se escribe nada.
 *   [4] El surtidor cierra con motivo por renglón; un motivo de la caja es 400 y no cierra; D4: un
 *       renglón que faltó sin motivo es 400 y no cierra.
 *   [5] La caja cierra con motivo donde deja menos de lo surtido; «Otro» sin nota es 400; D4: sin motivo es 400.
 *   [6] Los tres roles ven el porqué: vendedora (Mis pedidos), surtidor y caja (detalle).
 *   [7] Cancelar con motivo; D4 (obligatorio, 2026-11-11): sin motivo, o con el texto fijo de una app
 *       vieja, «Corregir» y cancelar lo agendado son 400 y no escriben nada.
 *
 * Se sustituye sólo la infraestructura ajena (motor de precios de Kepler, alertas, push, alcance, la
 * mesa de preventa). Todo corre en UNA transacción que se revierte: no deja filas.
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

function cargar() {
  const d = (n) => path.join(__dirname, `.stub-mcp18-${n}.js`);
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
    Ctrl: lib('commercial-orders/commercial-orders.controller.ts').CommercialOrdersController,
    Picking: lib('presale-picking/presale-picking.service.ts').PresalePickingService,
    Review: lib('presale-picking/presale-review.service.ts').PresaleReviewService,
  };
}

(async () => {
  let S;
  try {
    S = cargar();
  } catch (e) {
    noMedido(`no se pudieron cargar el controlador y los servicios reales (${e.message.split('\n')[0]})`);
    console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }

  console.log('\n[0] Arranque: la firma que Nest inyecta no cambió');
  const tipos = (m) => (Reflect.getMetadata('design:paramtypes', S.Ctrl.prototype, m) || []).map((t) => t && t.name);
  ok(JSON.stringify(tipos('reopen')) === '["String","Object"]', `reopen(id, body) → ${JSON.stringify(tipos('reopen'))}`);
  ok(JSON.stringify(tipos('cancel')) === '["String","Object"]', `cancel(id, body) → ${JSON.stringify(tipos('cancel'))}`);
  ok(JSON.stringify(tipos('modify')) === '["String","Object"]', `[MCP.21] modify(id, body) → ${JSON.stringify(tipos('modify'))}`);

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);
      const hayRevision = (await trx.raw(
        `SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = 'commercial' AND table_name = 'presale_picks' AND column_name = 'reviewed_at'`,
      )).rows[0].n === 1;
      if (!hayRevision) { noMedido('la base no tiene la migración de la revisión en caja (20261029125146)'); throw new Error(RB); }

      // ── Infraestructura (la misma de test-newdb-sustituto-surtido.js) ──
      const cur = { trx, userId: null };
      const tk = { run: (fn) => fn(cur.trx) };
      const tenantCtx = { get: () => ({ tenantId: T, userId: cur.userId, roleName: 'superadmin' }), requireTenantId: () => T };
      const scope = { warehouseIds: async () => null, readParam: async () => null };
      const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
      const avisos = [];
      const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: (_t, u, a) => avisos.push({ u, ...a }) };
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
      const orders = new S.Orders(tk, tenantCtx, pricing, {}, alerts, push, stock, quotes);
      const ctrl = new S.Ctrl(orders);
      // La mesa de preventa es ajena: para «Mis pedidos» basta con la fila del pedido de la vendedora.
      const mesa = { pedidos: [] };
      const presale = {
        pedidosParaGuias: async () => mesa.pedidos,
        candidatosParaCampo: async () => ({ candidates: [] }),
      };
      const picking = new S.Picking(tk, tenantCtx, scope, orders, presale, alerts, push);
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
      const prods = await trx('catalog.products').where({ activo: true }).whereNull('deleted_at').whereNotNull('sku')
        .whereRaw(`nombre !~* '=[[:space:]]*GRATIS'`).orderBy('sku').limit(3).select('id', 'sku', 'nombre');
      if (!W || gente.length < 3 || prods.length < 3) { noMedido('la base no tiene la sucursal 02, 3 usuarios o 3 productos'); throw new Error(RB); }
      const [V, SURT, CAJA] = gente;
      const [p1, p2, p3] = prods;
      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP18-CLI', name: 'Cliente prueba MCP.18', active: true, erp_customer_code: 'ZZ18', erp_source_branch: '02',
      }).returning('id');
      const [cli2] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP18-CL2', name: 'Cliente prueba MCP.18 dos', active: true, erp_customer_code: 'ZZ182', erp_source_branch: '02',
      }).returning('id');
      const pedido = async (cliente, renglones) => como(V, async () => {
        const o = await orders.createDraft({ customer_id: cliente, warehouse_id: W.id, requested_delivery_date: '2030-01-02' });
        for (const r of renglones) await orders.addLine(o.id, r);
        await orders.place(o.id);
        return o.id;
      });
      const estado = async (id) => (await trx('commercial.orders').where({ id }).first('status')).status;
      const historia = async (id) => trx('commercial.order_status_history').where({ order_id: id }).orderBy('changed_at').select('from_status', 'to_status', 'reason');
      // ⚠️ En una sola transacción todas las filas de la historia llevan la MISMA hora (CURRENT_TIMESTAMP) y el id es
      // un UUID: «la última» sale al azar. Se busca la fila por su transición. (En prod cada acción es su transacción.)
      const filaDe = (h, de, a) => h.filter((x) => x.to_status === a && (de === null || x.from_status === de));
      const lineas = async (id) => trx('commercial.order_lines').where({ order_id: id }).orderBy('line_number').select('id', 'product_id', 'quantity');

      const A = await pedido(cli.id, [{ product_id: p1.id, quantity: 2 }, { product_id: p2.id, quantity: 3 }, { product_id: p3.id, quantity: 2 }]);
      const oA = await trx('commercial.orders').where({ id: A }).first('status', 'delivery_type');
      if (oA.status !== 'confirmed' || oA.delivery_type !== 'route') {
        noMedido(`el pedido de prueba quedó ${oA.status}/${oA.delivery_type}, no confirmed/route`);
        throw new Error(RB);
      }

      console.log('\n[2] Negativas que no escriben (antes del «Corregir» bueno)');
      const h0 = (await historia(A)).length;
      for (const [que, body, re] of [
        ['un motivo de la lista de cancelar', { reason_code: 'duplicado' }, /no está en la lista/],
        ['«Otro motivo» sin nota', { reason_code: 'otro', note: '  ' }, /escribe cuál/],
        ['una nota de 201 caracteres', { reason_code: 'quitar', note: 'x'.repeat(201) }, /200/],
      ]) {
        const n = await falla(V, () => ctrl.reopen(A, body), 400, re);
        ok(n.ok, `${que} → 400 (${n.msg})`);
      }
      ok((await estado(A)) === 'confirmed' && (await historia(A)).length === h0, 'nada quedó escrito: sigue agendado y la historia no creció');

      console.log('\n[1] «Corregir» con motivo (payload de la app)');
      const chk = await como(V, () => ctrl.reopen(A, { check_only: true }));
      ok(chk && chk.id === A && (await estado(A)) === 'confirmed' && (await historia(A)).length === h0, '«¿se puede?» (check_only) contesta que sí y NO reabre ni escribe historia');
      await como(V, () => ctrl.reopen(A, { reason_code: 'agregar', note: '2 cajas de chicle' }));
      const hA = await historia(A);
      ok((await estado(A)) === 'draft', 'el pedido volvió a borrador');
      const reA = filaDe(hA, 'confirmed', 'draft');
      ok(reA.length === 1 && reA[0].reason === 'El cliente quiere agregar productos: 2 cajas de chicle',
        `la historia guarda «Etiqueta: nota» («${reA.map((x) => x.reason).join(' | ')}»)`);
      await como(V, () => orders.place(A));
      ok((await estado(A)) === 'confirmed', 'se reagenda como siempre');

      console.log('\n[3] D1: con el surtido empezado no se corrige');
      await como(SURT, () => picking.start(A));
      const h1 = (await historia(A)).length;
      const b1 = await falla(V, () => ctrl.reopen(A, { check_only: true }), 409, /Ya lo está surtiendo .* desde las \d\d:\d\d.*toma un pedido nuevo/);
      ok(b1.ok, `«¿se puede?» → 409 con quién, desde cuándo y qué hacer (${b1.msg})`);
      const b2 = await falla(V, () => ctrl.reopen(A, { reason_code: 'quitar' }), 409, /Ya lo está surtiendo/);
      ok(b2.ok, `«Corregir» con motivo → 409 (${b2.msg})`);
      ok((await estado(A)) === 'confirmed' && (await historia(A)).length === h1, 'nada quedó escrito: sigue agendado y en la bandeja del surtidor');

      console.log('\n[4] El surtidor cierra con motivo por renglón');
      const [a1, a2, a3] = await lineas(A);
      const marcado = (r1, r2 = { reason: 'no_localizado' }) => ({ lines: [
        { line_id: a1.id, picked: 0, ...r1 },
        { line_id: a2.id, picked: 2, ...r2 },                            // recortado: D2, motivo nuevo
        { line_id: a3.id, picked: 2, reason: 'danado' },                 // completo: el motivo se ignora
      ] });
      const nS = await falla(SURT, () => picking.finish(A, marcado({ reason: 'no_venia' })), 400, /no está en la lista/);
      ok(nS.ok, `un motivo de la lista de la caja → 400 (${nS.msg})`);
      const nS2 = await falla(SURT, () => picking.finish(A, marcado({ reason: 'otro' })), 400, /escribe cuál/);
      ok(nS2.ok, `«Otro motivo» sin nota → 400 (${nS2.msg})`);
      const nS3 = await falla(SURT, () => picking.finish(A, marcado({ reason: 'danado' }, {})), 400, /Falta el porqué .*vuelve a abrirla/);
      ok(nS3.ok, `D4: el recortado sin motivo (pantalla vieja) → 400 con el producto y cómo salir (${nS3.msg})`);
      ok(!(await trx('commercial.presale_picks').where({ order_id: A }).first('finished_at')).finished_at && (await lineas(A)).length === 3,
        'nada quedó escrito: sin cerrar y con sus 3 renglones');
      const fin = await como(SURT, () => picking.finish(A, marcado({ reason: 'danado', reason_note: 'caja mojada' })));
      ok(fin.report.removed[0].line_id === a1.id && fin.report.removed[0].reason === 'danado' && fin.report.removed[0].reason_note === 'caja mojada',
        'el renglón quitado guarda su motivo y su nota');
      ok(fin.report.adjusted[0].line_id === a2.id && fin.report.adjusted[0].reason === 'no_localizado', 'el recortado guarda su motivo (uno de los nuevos de D2)');
      const pk = await trx('commercial.presale_picks').where({ order_id: A }).first('report');
      ok(pk.report.removed[0].reason === 'danado', 'y queda guardado en presale_picks.report');

      console.log('\n[5] La caja cierra con motivo donde deja menos de lo surtido');
      const rev = await como(CAJA, () => review.detail(A));
      const porProd = new Map(rev.lines.map((l) => [l.product_id, l]));
      const kA3 = porProd.get(p3.id).key;
      const cuerpo = (r3) => ({ lines: rev.lines.map((l) => (l.key === kA3
        ? { key: l.key, final: 1, ...r3 }
        : { key: l.key, final: l.picked, ...(l.product_id === p2.id ? { reason: 'danado' } : {}) })) });
      const nC = await falla(CAJA, () => review.finish(A, cuerpo({ reason: 'otro' })), 400, /escribe cuál/);
      ok(nC.ok, `«Otro motivo» sin nota → 400 (${nC.msg})`);
      const nC2 = await falla(CAJA, () => review.finish(A, cuerpo({})), 400, /Falta el porqué/);
      ok(nC2.ok, `D4: lo que la caja deja de menos sin motivo → 400 (${nC2.msg})`);
      ok(!(await trx('commercial.presale_picks').where({ order_id: A }).first('reviewed_at')).reviewed_at, 'nada quedó escrito: sin revisar');
      const r = await como(CAJA, () => review.finish(A, cuerpo({ reason: 'lo_pidio_quitar' })));
      const l3 = r.review.lines.find((l) => l.key === kA3);
      const l2 = r.review.lines.find((l) => l.product_name === p2.nombre);
      ok(l3.final === 1 && l3.reason === 'lo_pidio_quitar', `la caja dejó 1 de 2 con motivo «${l3.reason}»`);
      ok(l2 && l2.reason === undefined, 'donde el faltante ya venía del surtido, la caja no le pone motivo');

      console.log('\n[6] Los tres roles ven el porqué');
      const txt = (j) => `${j.actor}/${j.action}/${j.product_name ?? '-'}/${j.reason ?? 'SIN MOTIVO'}`;
      const det = await como(SURT, () => picking.detail(A));
      const js = (det.justifications || []).map(txt);
      ok(js.includes('seller/reopened/-/El cliente quiere agregar productos: 2 cajas de chicle'), 'el surtidor ve por qué la vendedora corrigió');
      ok(js.includes(`picker/removed/${p1.nombre}/Dañado o caducado: caja mojada`), 'el surtidor ve su propio motivo');
      ok(js.includes(`picker/trimmed/${p2.nombre}/El sistema dice que hay, pero no lo encontré`), 'D5: el surtidor ve también lo recortado con su motivo');
      ok(js.includes(`cashier/not_in_cart/${p3.nombre}/Lo pidió quitar el vendedor o el cliente`), 'el surtidor ve el motivo de la caja');
      ok((rev.justifications || []).some((j) => j.actor === 'picker' && j.reason === 'Dañado o caducado: caja mojada')
        && (rev.justifications || []).some((j) => j.action === 'reopened'), 'la caja vio (antes de revisar) el motivo del surtidor y la corrección de la vendedora');
      const fila = await trx('commercial.orders as o').leftJoin('commercial.customers as c', 'c.id', 'o.customer_id').where('o.id', A)
        .first('o.id', 'o.code', 'o.status', 'o.created_at', 'o.total', 'c.name as customer_name', trx.raw(`to_char(o.requested_delivery_date, 'YYYY-MM-DD') AS requested_delivery_date`));
      mesa.pedidos = [{ ...fila, total: Number(fila.total), lines: 2, warehouse_name: 'Sucursal prueba', link: null, delivery: null, possible_documents: 0 }];
      const st = await como(V, () => picking.sellerStatus());
      const jv = (st.data[0]?.justifications || []).map(txt);
      ok(jv.length === 4 && jv[0].startsWith('seller/reopened') && jv.some((x) => x.startsWith('picker/removed')) && jv.some((x) => x.startsWith('cashier/not_in_cart')),
        `la vendedora ve los cuatro en Mis pedidos, en orden: ${jv.join(' | ')}`);

      console.log('\n[7] Cancelar con motivo; D4: sin motivo no se corrige ni se cancela lo agendado');
      const B = await pedido(cli2.id, [{ product_id: p1.id, quantity: 1 }]);
      const hB0 = (await historia(B)).length;
      const nR1 = await falla(V, () => ctrl.reopen(B, {}), 400, /Elige el motivo.*vuelve a abrirla/);
      ok(nR1.ok, `«Corregir» sin motivo (app vieja) → 400 y dice cómo salir (${nR1.msg})`);
      const nR2 = await falla(V, () => ctrl.reopen(B, { reason: 'reabierto para corregir' }), 400, /Elige el motivo/);
      ok(nR2.ok, '«Corregir» con el texto fijo de antes → 400 (no es el motivo de nadie)');
      const nK1 = await falla(V, () => ctrl.cancel(B, { reason: 'Cancelado por el vendedor' }), 400, /motivo de la cancelación/);
      ok(nK1.ok, `cancelar SU pedido agendado con el texto fijo → 400 (${nK1.msg})`);
      ok((await estado(B)) === 'confirmed' && (await historia(B)).length === hB0, 'nada quedó escrito: sigue agendado y la historia no creció');
      await como(V, () => ctrl.reopen(B, { reason_code: 'entrega' }));
      const hB = await historia(B);
      const reB = filaDe(hB, 'confirmed', 'draft');
      ok(reB.length === 1 && reB[0].reason === 'Cambiar las indicaciones o la forma de entrega', 'con motivo (uno de los nuevos de D2) sí se corrige');
      const nX = await falla(V, () => ctrl.cancel(B, { reason_code: 'agregar' }), 400, /no está en la lista/);
      ok(nX.ok && (await estado(B)) === 'draft', `cancelar con un motivo de «Corregir» → 400 y no cancela (${nX.msg})`);
      await como(V, () => ctrl.cancel(B, { reason_code: 'duplicado' }));
      const oB = await trx('commercial.orders').where({ id: B }).first('status', 'cancellation_reason');
      const hB2 = await historia(B);
      const caB = filaDe(hB2, null, 'cancelled');
      ok(oB.status === 'cancelled' && oB.cancellation_reason === 'Pedido duplicado' && caB.length === 1 && caB[0].reason === 'Pedido duplicado',
        'se cancela y el motivo queda en el pedido y en su historia');
      mesa.pedidos = [{ id: B, code: 'B', status: 'cancelled', created_at: new Date(), requested_delivery_date: '2030-01-02', customer_name: 'x', total: 0, lines: 1, warehouse_name: 'x', link: null, delivery: null, possible_documents: 0 }];
      const stB = await como(V, () => picking.sellerStatus());
      const jB = (stB.data[0]?.justifications || []).map(txt);
      ok(JSON.stringify(jB) === JSON.stringify(['seller/reopened/-/Cambiar las indicaciones o la forma de entrega', 'seller/cancelled/-/Pedido duplicado']),
        `la vendedora ve el motivo de cada cambio: ${jB.join(' | ')}`);

      console.log('\n[8] [MCP.21] Cancelar directo (sin reabrir) desde la app: un motivo, y D1');
      const C = await pedido(cli2.id, [{ product_id: p1.id, quantity: 1 }]);
      const hC0 = (await historia(C)).length;
      await como(SURT, () => picking.start(C));
      const nCa = await falla(V, () => ctrl.cancel(C, { reason_code: 'duplicado' }), 409, /ya no se cancela desde la app/);
      ok(nCa.ok && (await estado(C)) === 'confirmed' && (await historia(C)).length === hC0, `con el surtido empezado → 409 y no escribe nada (${nCa.msg})`);
      const E = await pedido(cli2.id, [{ product_id: p1.id, quantity: 1 }]);
      await como(V, () => ctrl.cancel(E, { reason_code: 'cliente_equivocado' }));
      const oE = await trx('commercial.orders').where({ id: E }).first('status', 'cancellation_reason');
      const hE = await historia(E);
      ok(oE.status === 'cancelled' && oE.cancellation_reason === 'Me equivoqué de cliente'
        && filaDe(hE, 'confirmed', 'cancelled').length === 1 && filaDe(hE, 'confirmed', 'draft').length === 0,
        'sin surtir: se cancela directo desde agendado, con UN motivo y sin pasar por borrador');

      console.log('\n[9] [MCP.21] Modificar desde la tarjeta: cantidades y quitar, en UNA transacción');
      const G = await pedido(cli2.id, [{ product_id: p1.id, quantity: 2 }, { product_id: p2.id, quantity: 1 }]);
      const [g1, g2] = await lineas(G);
      const foto = async () => JSON.stringify({ st: await estado(G), ls: await lineas(G), h: (await historia(G)).length });
      const antes = await foto();
      const nM1 = await falla(V, () => ctrl.modify(G, { changes: [{ line_id: g2.id, remove: true }] }), 400, /Elige el motivo/);
      ok(nM1.ok && (await foto()) === antes, `sin motivo → 400 y no escribe (${nM1.msg})`);
      const nM2 = await falla(V, () => ctrl.modify(G, { reason_code: 'quitar', changes: [{ line_id: g1.id, remove: true }, { line_id: g2.id, remove: true }] }), 400, /cancela el pedido/);
      ok(nM2.ok && (await foto()) === antes, `quitar todo → 400 que dice que se cancele, y no escribe (${nM2.msg})`);
      const nM3 = await falla(V, () => ctrl.modify(G, { reason_code: 'cantidad', changes: [{ line_id: g1.id, quantity: 0 }] }), 400, /mayor que 0/);
      ok(nM3.ok && (await foto()) === antes, `cantidad 0 → 400 (${nM3.msg})`);
      const nM4 = await falla(V, () => ctrl.modify(G, { reason_code: 'quitar', changes: [{ line_id: '00000000-0000-4000-8000-000000000000', remove: true }] }), 409, /ya no está en el pedido/);
      ok(nM4.ok && (await foto()) === antes, `un renglón que no es del pedido → 409 (${nM4.msg})`);
      // ⭐ Todo o nada: el primer cambio (quitar) sí se podría; el segundo (una unidad que nadie declara) truena
      // a la mitad. Si no fuera UNA transacción, el pedido quedaría en borrador y sin el renglón quitado.
      const nM5 = await como(V, () => ctrl.modify(G, { reason_code: 'cantidad', changes: [{ line_id: g2.id, remove: true }, { line_id: g1.id, quantity: 1, qty_unit: 'XQZ' }] })).then(() => ({ ok: false, msg: 'no falló' }), (e) => ({ ok: true, msg: String(e.message) }));
      ok(nM5.ok && (await foto()) === antes, `un cambio que falla a la mitad → nada queda escrito: sigue agendado y con sus 2 renglones (${nM5.msg.slice(0, 90)})`);
      const r9 = await como(V, () => ctrl.modify(G, { reason_code: 'cantidad', note: 'eran 3', changes: [{ line_id: g1.id, quantity: 3 }, { line_id: g2.id, remove: true }] }));
      const lsG = await lineas(G);
      const hG = await historia(G);
      const totG = Number((await trx('commercial.orders').where({ id: G }).first('total')).total);
      const sumG = +(await trx('commercial.order_lines').where({ order_id: G }).sum({ t: 'line_total' }).first()).t;
      ok((await estado(G)) === 'confirmed' && lsG.length === 1 && lsG[0].id === g1.id && Number(lsG[0].quantity) === 3,
        `queda agendado con 1 renglón de 3 (${lsG.map((l) => l.quantity).join(', ')})`);
      ok(Math.abs(totG - sumG) < 0.005 && Math.abs(Number(r9.total) - totG) < 0.005, `el total (${totG}) = la suma de sus renglones (${sumG}) = lo que devolvió`);
      ok(filaDe(hG, 'confirmed', 'draft').some((x) => x.reason === 'Me equivoqué de cantidad o unidad: eran 3') && filaDe(hG, null, 'confirmed').length === 2,
        'la historia guarda el motivo (el surtidor y la caja lo ven) y que se volvió a agendar (agendar = por aprobar → agendado)');
      // [MCP.21] Lo modificado desde la tarjeta llega igual que «Corregir»: el surtidor y la checadora de caja ven el porqué.
      const motivoG = 'seller/reopened/-/Me equivoqué de cantidad o unidad: eran 3';
      const dG = await como(SURT, () => picking.detail(G));
      ok((dG.justifications || []).map(txt).includes(motivoG), 'el surtidor ve por qué la vendedora lo modificó desde la tarjeta');
      await como(SURT, () => picking.start(G));
      await como(SURT, () => picking.finish(G, { lines: [{ line_id: g1.id, picked: 3 }] }));
      const rG = await como(CAJA, () => review.detail(G));
      ok((rG.justifications || []).map(txt).includes(motivoG), 'la checadora de caja también lo ve, antes de revisar');
      const H =await pedido(cli2.id, [{ product_id: p1.id, quantity: 2 }, { product_id: p2.id, quantity: 1 }]);
      const [hl1] = await lineas(H);
      await como(SURT, () => picking.start(H));
      const nM6 = await falla(V, () => ctrl.modify(H, { reason_code: 'cantidad', changes: [{ line_id: hl1.id, quantity: 1 }] }), 409, /Ya lo está surtiendo/);
      ok(nM6.ok && (await estado(H)) === 'confirmed' && Number((await lineas(H))[0].quantity) === 2, `D1: con el surtido empezado → 409 y no cambia nada (${nM6.msg.slice(0, 80)})`);
      const K = await pedido(cli.id, [{ product_id: p1.id, quantity: 2 }, { product_id: p3.id, quantity: 1 }]);
      const [k1] = await lineas(K);
      await como(V, () => ctrl.modify(K, { reason_code: 'agregar', changes: [{ line_id: k1.id, quantity: 4 }], keep_open: true }));
      ok((await estado(K)) === 'draft' && Number((await lineas(K))[0].quantity) === 4, 'keep_open: aplica el cambio y deja el borrador (mismo folio) para agregar en la captura');

      throw new Error(RB);
    });
  } catch (e) {
    if (e.message !== RB) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
