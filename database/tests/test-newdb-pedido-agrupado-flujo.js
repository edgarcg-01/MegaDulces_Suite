/**
 * MCP.3.13 — Pedido agrupado: el FLUJO después de mandarlo (mesa, clave por sucursal, reparto,
 * liquidación y surtido de ruta), contra una base REAL.
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció
 * contra una base real. Todo el SQL nuevo de estos servicios sólo se había probado con dobles de
 * knex; aquí se cargan los servicios REALES (el TS del repo) y se recorre:
 *
 *   [1] Mesa (`PresaleControlService.list` / `detail`): las dos partes traen los datos del grupo
 *       (LATERAL), un pedido suelto trae nulos.
 *   [2] Clave por sucursal (`ligarClaveSucursal`, `POST /warehouse/presale/customer-branch-key`):
 *       sin clave ligada la parte de la otra sucursal se bloquea (`cliente_de_otra_sucursal`); con
 *       la clave ligada, no. Negativas: clave inexistente, sucursal de origen, clave de otro cliente.
 *   [3] Reparto (`LoadGuideService.campo` / `cargar` con `conPartesDeGrupo` + `completarGrupos`):
 *       el repartidor de la sucursal del principal ve la parte y, al pescar el principal, la parte
 *       se carga sola en la guía de SU sucursal. Negativa: el de la otra sucursal no puede pescar
 *       sólo la parte.
 *   [4] Liquidación (`previewLiquidacion` / `liquidar` con `conRecoleccion` y
 *       `bloqueoSucursalesLiquidacion`): la guía de recolección de otra sucursal se liquida en la
 *       caja del principal; la caja de la otra sucursal NO; una mezcla ajena se bloquea.
 *   [5] Surtido de ruta (`PresaleRouteService.routeStart` / `routeFinish` / `routes` con
 *       `seller_route_day_picks`; `PresalePickingService.leer` con `GRUPO_SELECT_SQL`): dos
 *       sucursales surten la MISMA ruta; la misma sucursal con otra persona → 409.
 *
 * Datos: usa las sucursales REALES 01 y 02 (zona La Piedad) y 05 (Zamora) porque la lógica de
 * sucursal necesita un `kepler_code` de 2 dígitos CON tickets en `analytics.erp_sale_tickets`
 * (`warehouses_kepler_code_uq` impide repetir el código en un almacén de prueba, y un código libre
 * no tiene tickets: daría `sucursal_sin_documentos` antes que lo que se quiere medir).
 *
 * Sólo se sustituye la infraestructura ajena (precios, alertas, push, stock, PDF, alcance): el alcance
 * se fija por llamada. Todo corre en UNA transacción que se revierte: no deja filas. Cada llamada a
 * un servicio va en su propio SAVEPOINT, para que una negativa que falle en SQL no envenene el resto.
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

/** Carga los servicios REALES con dobles para lo que no es del flujo. */
function cargarServicios() {
  const raiz = path.resolve(__dirname, '..', '..');
  const d = (n) => path.join(__dirname, `.stub-mcp313f-${n}.js`);
  const ts = (p) => JSON.stringify(path.join(raiz, p));
  // platform-core: las clases son sólo tokens de DI; `branchKeySql` y `branchName` son los REALES
  // (el SQL que se prueba los incrusta).
  const pc = `const st = require(${ts('libs/platform-core/src/lib/scope/scope.types.ts')});
const br = require(${ts('libs/platform-core/src/lib/constants/branches.ts')});
module.exports = { TenantKnexService: class {}, TenantContextService: class {}, ScopeService: class {},
  isPlatformAdminRole: (r) => r === "superadmin", branchKeySql: st.branchKeySql, branchName: br.branchName };`;
  const stubs = {
    '@megadulces/platform-core': [d('platform-core'), pc],
    '../commercial-pricing/commercial-pricing.service': [d('pricing'), 'module.exports = { CommercialPricingService: class {} };'],
    '../commercial-inventory/commercial-inventory.service': [d('inventory'), 'module.exports = { CommercialInventoryService: class {} };'],
    '../commercial-alerts/alerts.service': [d('alerts'), 'module.exports = { AlertsService: class {} };'],
    '../commercial-push/commercial-push.service': [d('push'), 'module.exports = { CommercialPushService: class {} };'],
    './order-stock.service': [d('stock'), 'module.exports = { OrderStockService: class {} };'],
    '../commercial-quotes/quote-pricing.service': [d('quotes'), 'module.exports = { QuotePricingService: class {}, rungDeRotulo: () => "base" };'],
    '../commercial-sales-documents/anexo-venta.service': [d('anexo'), 'module.exports = { AnexoVentaService: class {} };'],
  };
  for (const [, [f, src]] of Object.entries(stubs)) fs.writeFileSync(f, src);
  process.on('exit', () => { for (const [, [f]] of Object.entries(stubs)) { try { fs.unlinkSync(f); } catch { /* ya no está */ } } });
  const contracts = path.join(raiz, 'libs/contracts/src/index.ts');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (req, parent, ...rest) {
    if (req === '@megadulces/contracts') return contracts;
    if (req === '@megadulces/platform-core') return stubs[req][0];
    if (stubs[req] && parent && /[\\/]libs[\\/]commercial[\\/]/.test(parent.filename)) {
      // `./order-stock.service` sólo se sustituye para el servicio de pedidos.
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
  const lib = (p) => require(path.join(raiz, 'libs/commercial/src/lib', p));
  return {
    CommercialOrdersService: lib('commercial-orders/commercial-orders.service.ts').CommercialOrdersService,
    PresaleControlService: lib('presale-control/presale-control.service.ts').PresaleControlService,
    LoadGuideService: lib('presale-control/load-guide.service.ts').LoadGuideService,
    PresalePickingService: lib('presale-picking/presale-picking.service.ts').PresalePickingService,
    PresaleRouteService: lib('presale-picking/presale-route.service.ts').PresaleRouteService,
  };
}

(async () => {
  let S;
  try {
    S = cargarServicios();
  } catch (e) {
    noMedido(`no se pudieron cargar los servicios reales (${e.message.split('\n')[0]})`);
    console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
    await knex.destroy();
    process.exit(fail ? 1 : 0);
  }

  try {
    await knex.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${T}'`);

      // ── Infraestructura: la transacción vigente (savepoint), quién pide y su alcance ──
      const cur = { trx, userId: null };
      const tk = { run: (fn) => fn(cur.trx) };
      const tenantCtx = {
        get: () => ({ tenantId: T, userId: cur.userId, roleName: 'superadmin' }),
        requireTenantId: () => T,
      };
      // Alcance fijado por llamada: `__br` = llaves de sucursal (2 dígitos), `__wh` = ids de almacén.
      const scope = {
        readParam: async (q) => (q && '__br' in q ? q.__br : null),
        warehouseIds: async (q) => (q && '__wh' in q ? q.__wh : null),
      };
      const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
      const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: () => undefined };
      const push = { notifyCustomer: async () => undefined, sendToCustomer: async () => undefined, sendToUser: async () => undefined };
      const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
      const quotes = { ladders: async () => new Map(), priceLine: async () => ({ line_total: null, unit_price: null }) };
      const pdf = { renderPdf: async () => Buffer.from('%PDF-prueba') };

      const orders = new S.CommercialOrdersService(tk, tenantCtx, pricing, {}, alerts, push, stock, quotes);
      const presale = new S.PresaleControlService(tk, tenantCtx, scope);
      const guias = new S.LoadGuideService(tk, tenantCtx, scope, presale, pdf);
      const picking = new S.PresalePickingService(tk, tenantCtx, scope, orders, presale, alerts, push);
      const rutas = new S.PresaleRouteService(tk, tenantCtx, scope, picking, alerts, push);

      /** Corre `fn` como `userId` dentro de un SAVEPOINT: si falla, se revierte sólo eso. */
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
      /** La negativa: debe fallar con ese estado HTTP y ese mensaje. Devuelve el mensaje real. */
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
      const wh = async (k) => trx('commercial.warehouses').where({ kepler_code: k }).whereNull('deleted_at').first('id', 'purchase_zone');
      const W01 = await wh('01');
      const W02 = await wh('02');
      const W05 = await wh('05');
      const { rows: hoyRow } = await trx.raw(`SELECT to_char((now() AT TIME ZONE 'America/Mexico_City')::date, 'YYYY-MM-DD') AS hoy`);
      const hoy = hoyRow[0].hoy;
      const gente = await trx('identity.users as u')
        .where('u.tenant_id', T).whereNull('u.deleted_at')
        .whereNotExists(function () {
          this.select(1).from('commercial.seller_route_days as rd').whereRaw('rd.user_id = u.id').andWhere('rd.work_date', hoy);
        })
        .orderBy('u.username').limit(6).pluck('u.id');
      const prods = await trx('catalog.products').limit(3).pluck('id');
      const tickets = async (b) => (await trx.raw(
        `SELECT 1 FROM analytics.erp_sale_tickets WHERE tenant_id = ? AND sucursal = ? AND fecha > current_date - 30 LIMIT 1`, [T, b],
      )).rows.length > 0;
      if (!W01 || !W02 || !W05 || gente.length < 6 || prods.length < 3) {
        noMedido('la base no tiene las sucursales 01/02/05, 6 usuarios o 3 productos con qué armar el flujo');
        throw new Error(RB);
      }
      if (!W01.purchase_zone || W01.purchase_zone !== W02.purchase_zone || W05.purchase_zone === W01.purchase_zone) {
        noMedido(`las zonas locales no sirven (01=${W01.purchase_zone}, 02=${W02.purchase_zone}, 05=${W05.purchase_zone})`);
        throw new Error(RB);
      }
      const conTickets01 = await tickets('01');
      const conTickets02 = await tickets('02');
      const [V, A, A2, B, R, C] = gente; // vendedor, surtidor 01, otro surtidor 01, surtidor 02, repartidor, caja
      const [p1, p2, p3] = prods;

      const [cli] = await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP313F-CLI', name: 'Cliente prueba MCP.3.13 flujo', active: true,
        erp_customer_code: 'ZZ313', erp_source_branch: '01', sales_route: 'ZZ-R313',
      }).returning('id');
      const pedido = async (whId, renglones) => como(V, async () => {
        const o = await orders.createDraft({ customer_id: cli.id, warehouse_id: whId, requested_delivery_date: '2030-01-02' });
        for (const r of renglones) await orders.addLine(o.id, r);
        await orders.place(o.id);
        return o.id;
      });

      // El pedido agrupado (principal en 01 + parte en 02) y un pedido suelto en 01.
      const principal = await pedido(W01.id, [{ product_id: p1, quantity: 2 }, { product_id: p2, quantity: 3, source_warehouse_id: W02.id }]);
      const parteRow = await trx('commercial.orders').where({ group_id: principal }).whereNot({ id: principal }).first('id', 'warehouse_id');
      const suelto = await pedido(W01.id, [{ product_id: p3, quantity: 1 }]);
      if (!parteRow || parteRow.warehouse_id !== W02.id) {
        fail++;
        console.log('  ✗ el pedido no quedó agrupado (prerrequisito de todo lo demás)');
        throw new Error(RB);
      }
      const parte = parteRow.id;
      const codigo = (await trx('commercial.orders').where({ id: principal }).first('code')).code;

      // ─────────────────────────────────────────────────────────────── [1] ──
      console.log('\n[1] Mesa: las dos partes traen el grupo; un pedido suelto, nulos');
      const lista = await como(C, () => presale.list({ __br: ['01', '02'] }));
      const fp = lista.data.find((r) => r.id === principal);
      const fq = lista.data.find((r) => r.id === parte);
      const fs1 = lista.data.find((r) => r.id === suelto);
      ok(!!fp && !!fq && !!fs1, `list() trae el principal, la parte y el suelto (${lista.count} filas${lista.truncated ? ', TRUNCADA' : ''})`);
      for (const [nom, f, branch] of [['principal', fp, '01'], ['parte', fq, '02']]) {
        if (!f) continue;
        ok(f.group_id === principal && f.group_code === codigo && f.group_parts === 2,
          `${nom}: group_id/group_code/group_parts = principal/${codigo}/2 (vino ${f.group_code}/${f.group_parts})`);
        ok(JSON.stringify(f.group_branches) === '["01","02"]' && f.group_main_branch === '01',
          `${nom}: group_branches = [01,02] y group_main_branch = 01 (vino ${JSON.stringify(f.group_branches)}/${f.group_main_branch})`);
        ok(f.branch === branch, `${nom}: branch = ${branch} (vino ${f.branch})`);
      }
      if (fs1) {
        ok(fs1.group_id === null && fs1.group_code === null && fs1.group_parts === null && fs1.group_branches === null && fs1.group_main_branch === null,
          'suelto: todos los campos del grupo en null');
      }
      const soloMesa01 = await como(C, () => presale.list({ __br: ['01'] }));
      ok(!soloMesa01.data.some((r) => r.id === parte), 'la mesa de la 01 (sin conPartesDeGrupo) NO trae la parte de la 02');
      const det = await como(C, () => presale.detail(parte, { __br: ['02'] }));
      ok(det.order.group_code === codigo && det.order.group_parts === 2, 'detail() de la parte trae el grupo');
      // Una parte cancelada deja de contar en group_parts / group_branches.
      await como(C, async () => {
        await cur.trx('commercial.orders').where({ id: parte }).update({ status: 'cancelled' });
        const d2 = await presale.detail(principal, { __br: ['01'] });
        ok(d2.order.group_parts === 1 && JSON.stringify(d2.order.group_branches) === '["01"]',
          `con la parte cancelada, el principal cuenta 1 parte viva y sólo la 01 (vino ${d2.order.group_parts}/${JSON.stringify(d2.order.group_branches)})`);
        throw new Error('__sp__'); // se revierte sólo este savepoint: la parte vuelve a confirmada
      }).catch((e) => { if (e.message !== '__sp__') throw e; });

      // ─────────────────────────────────────────────────────────────── [2] ──
      console.log('\n[2] Clave del cliente en la otra sucursal');
      if (!conTickets01 || !conTickets02) {
        noMedido(`la base local no tiene tickets recientes de la 01 (${conTickets01}) o la 02 (${conTickets02}): el bloqueo no se puede distinguir de "sucursal_sin_documentos"`);
      } else {
        const sinClave = await como(C, () => presale.detail(parte, { __br: ['02'] }));
        ok(sinClave.order.link_block === 'cliente_de_otra_sucursal', `sin clave ligada, la parte de la 02 se bloquea (vino ${sinClave.order.link_block})`);
        ok(sinClave.order.customer_key_from_branch === false, 'sin clave ligada, customer_key_from_branch = false');
        const ctrl = await como(C, () => presale.detail(principal, { __br: ['01'] }));
        ok(ctrl.order.link_block === null, `control: el principal (sucursal de origen 01) no se bloquea (vino ${ctrl.order.link_block})`);
      }

      // Negativas de la liga (no dependen del catálogo).
      const body = (b, code) => ({ customer_id: cli.id, branch: b, erp_customer_code: code });
      let r = await falla(C, () => presale.ligarClaveSucursal(body('01', 'ZZ1'), { __br: ['01', '02'] }), 409, /sucursal de origen/);
      ok(r.ok, `NEGATIVA: ligar una clave en la sucursal de ORIGEN se rechaza (${r.msg})`);
      r = await falla(C, () => presale.ligarClaveSucursal(body('05', 'ZZ1'), { __br: ['05'] }), 404, /no tiene pedidos de preventa/);
      ok(r.ok, `NEGATIVA: sin pedido de preventa en esa sucursal se rechaza (${r.msg})`);
      r = await falla(C, () => presale.ligarClaveSucursal(body('02', 'ZZ1'), { __br: ['01'] }), 404, /no tiene pedidos de preventa/);
      ok(r.ok, `NEGATIVA: la parte de la 02 fuera del alcance de quien liga se rechaza (${r.msg})`);

      // Clave que ya es de OTRO cliente de la Suite en la 02.
      await trx('commercial.customers').insert({
        tenant_id: T, code: 'ZZ-MCP313F-OTRO', name: 'Otro cliente MCP.3.13', active: true, erp_customer_code: 'ZZ314', erp_source_branch: '02',
      });
      r = await falla(C, () => presale.ligarClaveSucursal(body('02', 'zz314'), { __br: ['02'] }), 409, /ya es de Otro cliente/);
      ok(r.ok, `NEGATIVA: una clave que ya es de otro cliente en la 02 se rechaza (${r.msg})`);

      // La clave que se liga: una del catálogo de la 02 que no sea de nadie en la Suite.
      const { rows: cat } = await trx.raw(
        `SELECT btrim(m.cliente_code) AS code, m.nombre FROM analytics.v_customer_master m
          WHERE m.fuente_sucursal = '02' AND btrim(m.cliente_code) ~ '^[A-Za-z0-9-]+$'
            AND NOT EXISTS (SELECT 1 FROM commercial.customers x
                             WHERE btrim(x.erp_source_branch) = '02' AND ltrim(btrim(x.erp_customer_code), '0') = ltrim(btrim(m.cliente_code), '0'))
          ORDER BY 1 LIMIT 2`,
      );
      let ligada = null;
      if (!conTickets02) {
        noMedido('la 02 no publica tickets en la base local: ligarClaveSucursal respondería 409 "no publica tickets"');
      } else if (cat.length < 2) {
        noMedido('el catálogo de clientes de la 02 (analytics.v_customer_master) no tiene 2 claves libres para verificar la liga');
      } else {
        r = await falla(C, () => presale.ligarClaveSucursal(body('02', 'NOEXISTE313'), { __br: ['02'] }), 400, /no existe en el Kepler/);
        ok(r.ok, `NEGATIVA: una clave que no está en el catálogo ni en los tickets de la 02 se rechaza (${r.msg})`);
        const res = await como(C, () => presale.ligarClaveSucursal(body('02', ` ${cat[0].code.toLowerCase()} `), { __br: ['02'] }));
        ok(res.ok && res.erp_customer_code === cat[0].code && res.verified_by === 'catalogo' && res.replaced_code === null,
          `liga la clave ${cat[0].code} verificada contra el catálogo de la 02 (verified_by=${res.verified_by})`);
        const vivas = await trx('commercial.customer_branch_keys').where({ customer_id: cli.id, branch: '02' }).whereNull('deleted_at').select('erp_customer_code', 'created_by');
        ok(vivas.length === 1 && vivas[0].erp_customer_code === cat[0].code && vivas[0].created_by === C, 'queda UNA clave viva, con autor');
        const otraVez = await como(C, () => presale.ligarClaveSucursal(body('02', cat[0].code), { __br: ['02'] }));
        const n1 = await trx('commercial.customer_branch_keys').where({ customer_id: cli.id }).count('* as n').first();
        ok(otraVez.replaced_code === null && Number(n1.n) === 1, 'ligar la MISMA clave otra vez es idempotente (no crea fila)');
        const cambio = await como(C, () => presale.ligarClaveSucursal(body('02', cat[1].code), { __br: ['02'] }));
        const todas = await trx('commercial.customer_branch_keys').where({ customer_id: cli.id, branch: '02' }).orderBy('created_at').select('erp_customer_code', 'deleted_at', 'deleted_by');
        ok(cambio.replaced_code === cat[0].code && todas.length === 2 && todas.filter((t) => !t.deleted_at).length === 1
          && todas.some((t) => t.erp_customer_code === cat[0].code && t.deleted_at && t.deleted_by === C),
          'ligar OTRA clave da de baja la anterior (deleted_at + deleted_by), no la pisa');
        ligada = cat[1].code;

        const conClave = await como(C, () => presale.detail(parte, { __br: ['02'] }));
        ok(conClave.order.link_block === null, `con la clave ligada, la parte de la 02 YA NO se bloquea (vino ${conClave.order.link_block})`);
        ok(conClave.order.customer_erp_code === ligada.replace(/^0+/, '') && conClave.order.customer_key_from_branch === true,
          `la parte se cobra con la clave de la 02 (${conClave.order.customer_erp_code}) y lo declara`);
        const princ = await como(C, () => presale.detail(principal, { __br: ['01'] }));
        ok(princ.order.customer_erp_code === 'ZZ313' && princ.order.customer_key_from_branch === false,
          'el principal (01) sigue con la clave de origen: la de la 02 no se le pega');
      }
      // La de la tickets: el camino "verificada por tickets" sólo corre si la clave no está en el catálogo.
      noMedido('verified_by = "tickets" (clave fuera del catálogo pero con tickets): el catálogo local de la 02 es sintético (12 filas) y no hay un ticket con una clave ajena a él sin inventar datos del ODS');

      // ─────────────────────────────────────────────────────────────── [3] ──
      console.log('\n[3] Reparto: el repartidor de la 01 recoge la parte de la 02');
      const rider = { repartidor: true, god: false };
      const campo01 = await como(R, () => guias.campo({ __br: ['01'] }, rider));
      ok(campo01.available.some((p) => p.id === principal) && campo01.available.some((p) => p.id === parte),
        'campo() de la 01 (conPartesDeGrupo) trae el principal Y la parte de la 02');
      const campo05 = await como(R, () => guias.campo({ __br: ['05'] }, rider));
      ok(!campo05.available.some((p) => p.id === principal || p.id === parte), 'control: el repartidor de la 05 no ve ninguna parte');
      r = await falla(R, () => guias.cargar([parte], { __br: ['02'] }, rider), 409, /se surte también en otra sucursal \(su pedido principal\)/);
      ok(r.ok, `NEGATIVA: el repartidor de la 02 no puede pescar sólo la parte (el principal no le toca) (${r.msg})`);
      const tras = await como(R, () => guias.cargar([principal], { __br: ['01'] }, rider));
      const cargados = await trx('commercial.load_guide_orders as lgo')
        .join('commercial.load_guides as g', 'g.id', 'lgo.guide_id')
        .whereIn('lgo.order_id', [principal, parte]).andWhere('lgo.status', 'cargado')
        .select('lgo.order_id', 'g.id as guide_id', 'g.branch', 'g.rider_user_id', 'g.sales_route');
      const gP = cargados.find((x) => x.order_id === principal);
      const gQ = cargados.find((x) => x.order_id === parte);
      ok(cargados.length === 2, 'pescar SÓLO el principal carga también la parte (completarGrupos)');
      ok(gP?.branch === '01' && gQ?.branch === '02' && gP?.guide_id !== gQ?.guide_id,
        `cada parte va en la guía de SU sucursal (principal→${gP?.branch}, parte→${gQ?.branch})`);
      ok(gP?.rider_user_id === R && gQ?.rider_user_id === R, 'las dos guías son del mismo repartidor');
      ok(tras.mine.some((g) => g.id === gQ?.guide_id && g.orders.some((o) => o.order_id === parte && o.group_code === codigo)),
        'su lista "mías" trae la guía de recolección con la parte y su group_code');
      r = await falla(R, () => guias.cargar([principal], { __br: ['01'] }, rider), 409, /Ya van en una guía/);
      ok(r.ok, `NEGATIVA: pescar otra vez lo ya cargado se rechaza (${r.msg})`);

      // ─────────────────────────────────────────────────────────────── [4] ──
      console.log('\n[4] Liquidación: la guía de recolección se liquida en la caja del principal');
      const caja = { repartidor: false, god: false };
      const G01 = gP?.guide_id;
      const G02 = gQ?.guide_id;
      if (!G01 || !G02) {
        noMedido('sin las dos guías del bloque 3 no hay qué liquidar');
      } else {
        // Imprime cada caja la suya (la de recolección no la ve la caja 01 para imprimir: no es su papel).
        await como(C, () => guias.imprimir(G01, { __br: ['01'] }, caja));
        r = await falla(C, () => guias.imprimir(G02, { __br: ['01'] }, caja), 404, /Guía no encontrada/);
        ok(r.ok, `la caja 01 no imprime la guía de la 02 (imprimir no usa conRecoleccion) (${r.msg})`);
        await como(C, () => guias.imprimir(G02, { __br: ['02'] }, caja));
        const lst = await como(C, () => guias.listar({ __br: ['01'] }, caja));
        const rec = lst.data.find((g) => g.id === G02);
        ok(!!rec && rec.liquidation_branch === '01' && rec.liquidates_here === true && rec.collection_only === true,
          `listar() de la caja 01 trae la guía de recolección de la 02 (liquidation_branch=${rec?.liquidation_branch}, collection_only=${rec?.collection_only})`);
        const lst02 = await como(C, () => guias.listar({ __br: ['02'] }, caja));
        const rec02 = lst02.data.find((g) => g.id === G02);
        ok(!!rec02 && rec02.liquidates_here === false, 'la caja 02 también la ve, pero liquidates_here = false');

        // Regresan sin entregarse (entregar exige un ticket de Kepler del cliente; ver NO MEDIDO abajo).
        for (const oid of [principal, parte]) {
          await como(R, () => guias.noEntregado({ order_id: oid, reason: 'Cliente cerrado (prueba)' }, { __br: ['01'] }, rider));
        }
        const pv = await como(C, () => guias.previewLiquidacion({ guide_ids: [G01, G02] }, { __br: ['01'] }, caja));
        ok(pv.blocked_reason === null && pv.branch === '01', `preview 01+recolección 02 en la caja 01: sin bloqueo, branch 01 (vino ${pv.blocked_reason ?? 'null'})`);
        ok((pv.by_branch ?? []).map((b) => b.branch).join() === '01,02', `by_branch = 01,02 con la caja primero (vino ${(pv.by_branch ?? []).map((b) => b.branch).join()})`);
        const pvSola = await como(C, () => guias.previewLiquidacion({ guide_ids: [G02] }, { __br: ['01'] }, caja));
        ok(pvSola.blocked_reason === null && pvSola.branch === '01', 'la guía de recolección SOLA también se liquida en la caja 01');
        const pv02 = await como(C, () => guias.previewLiquidacion({ guide_ids: [G02] }, { __br: ['02'] }, caja));
        ok(/se liquida en la caja de la sucursal 01/.test(pv02.blocked_reason ?? ''),
          `NEGATIVA: la caja 02 NO liquida la recolección de un grupo de la 01 (${pv02.blocked_reason})`);

        // Mezcla ajena: una guía de la 02 con un pedido SUELTO de la 02 junto a la de la 01.
        const suelto02 = await pedido(W02.id, [{ product_id: p3, quantity: 1 }]);
        await como(R, () => guias.cargar([suelto02], { __br: ['02'] }, rider));
        const g2b = (await trx('commercial.load_guide_orders').where({ order_id: suelto02, status: 'cargado' }).first('guide_id')).guide_id;
        ok(g2b !== G02, 'el suelto de la 02 va en otra guía (la de recolección ya está impresa)');
        await como(C, () => guias.imprimir(g2b, { __br: ['02'] }, caja));
        await como(R, () => guias.noEntregado({ order_id: suelto02, reason: 'Cliente cerrado (prueba)' }, { __br: ['02'] }, rider));
        const mezcla = await como(C, () => guias.previewLiquidacion({ guide_ids: [G01, g2b] }, { __br: ['01', '02'] }, caja));
        ok(/distintas sucursales/.test(mezcla.blocked_reason ?? ''), `NEGATIVA: 01 + una guía suelta de la 02 se bloquea (${mezcla.blocked_reason})`);
        r = await falla(C, () => guias.liquidar({
          guide_ids: [G01, g2b], cash_breakdown: {}, notes: '', expected_declared_cash: 0, expected_declared_transfer: 0,
        }, { __br: ['01', '02'] }, caja), 409, /distintas sucursales/);
        ok(r.ok, `NEGATIVA: liquidar esa mezcla se rechaza (${r.msg})`);
        r = await falla(C, () => guias.liquidar({
          guide_ids: [G02], cash_breakdown: {}, notes: '', expected_declared_cash: 0, expected_declared_transfer: 0,
        }, { __br: ['02'] }, caja), 409, /se liquida en la caja de la sucursal 01/);
        ok(r.ok, `NEGATIVA: la caja 02 no puede liquidar la recolección (${r.msg})`);

        const liq = await como(C, () => guias.liquidar({
          guide_ids: [G01, G02], cash_breakdown: {}, notes: '', expected_declared_cash: 0, expected_declared_transfer: 0,
        }, { __br: ['01'] }, caja));
        const fila = await trx('commercial.load_guide_liquidations').where({ id: liq.liquidacion.id }).first('branch', 'snapshot');
        const cerradas = await trx('commercial.load_guides').whereIn('id', [G01, G02]).select('status', 'liquidation_id');
        ok(fila?.branch === '01', `liquidar() escribe la liquidación en la caja 01 (vino ${fila?.branch})`);
        ok(cerradas.length === 2 && cerradas.every((g) => g.status === 'liquidada' && g.liquidation_id === liq.liquidacion.id),
          'las dos guías (01 y recolección 02) quedan liquidadas con esa liquidación');
        const snap = typeof fila?.snapshot === 'string' ? JSON.parse(fila.snapshot) : fila?.snapshot;
        ok(Array.isArray(snap?.por_sucursal) && snap.por_sucursal.map((b) => b.sucursal).join() === '01,02',
          'el comprobante trae el desglose por sucursal (01, 02)');
        ok(liq.liquidacion.guide_folios.length === 2, 'leerLiquidaciones devuelve los 2 folios de guía');
      }
      noMedido('entregar() con cobro: exige un ticket de Kepler del cliente en el ODS (candidato por cliente y sucursal) y la base local no tiene uno para un cliente de prueba sin inventar filas del ODS; la liquidación se midió con pedidos no entregados (importes en 0)');

      // ─────────────────────────────────────────────────────────────── [5] ──
      console.log('\n[5] Surtido de ruta por sucursal (seller_route_day_picks)');
      const leerFila = async (id) => (await como(A, () => picking.leer(cur.trx, { almacenes: null, orderId: id, incluirRutas: true })))[0];
      const lp = await leerFila(parte);
      const lPrin = await leerFila(principal);
      const lS = await leerFila(suelto);
      ok(lp?.group_code === codigo && Number(lp?.group_parts) === 2 && Array.isArray(lp?.group_other_warehouses) && lp.group_other_warehouses.length === 1,
        `picking.leer (GRUPO_SELECT_SQL) en la parte: group_code, 2 partes y 1 sucursal más (${JSON.stringify(lp?.group_other_warehouses)})`);
      ok(lPrin?.group_code === codigo && JSON.stringify(lPrin?.group_other_warehouses) !== JSON.stringify(lp?.group_other_warehouses),
        'en el principal, group_other_warehouses nombra la OTRA sucursal (la 02), no la suya');
      ok(lS && lS.group_code === null && lS.group_parts === null && Array.isArray(lS.group_other_warehouses) && lS.group_other_warehouses.length === 0,
        'pedido suelto: group_code/group_parts null y group_other_warehouses []');

      const [rd] = await trx('commercial.seller_route_days').insert({
        tenant_id: T, user_id: V, work_date: hoy, kind: 'ruta',
        started_at: trx.raw(`now() - interval '1 hour'`), finished_at: trx.raw(`now() + interval '10 minutes'`),
        finished_how: 'vendedor', created_by: V, updated_by: V,
      }).returning('id');
      const ruta = rd.id;
      const enRuta = await trx.raw(
        `SELECT count(*)::int AS n FROM commercial.seller_route_days rd JOIN commercial.orders o ON ${'rd.tenant_id = o.tenant_id AND rd.user_id = o.user_id AND o.confirmed_at >= rd.started_at AND o.confirmed_at <= rd.finished_at'}
          WHERE rd.id = ? AND o.id = ANY(?::uuid[])`, [ruta, [principal, parte, suelto]],
      );
      ok(enRuta.rows[0].n === 3, 'prerrequisito: los 3 pedidos caen en la ventana de la ruta');

      r = await falla(A, () => rutas.routeStart(ruta, {}), 409, /pedidos de 2 sucursales/);
      ok(r.ok, `NEGATIVA: modo dios (sin recorte) con pedidos de 2 sucursales se rechaza (${r.msg})`);
      const sA = await como(A, () => rutas.routeStart(ruta, { __wh: [W01.id] }));
      ok(sA.state === 'surtiendo' && sA.pick_started?.user_id === A, `el surtidor de la 01 empieza su parte (state=${sA.state})`);
      ok((sA.group_other_warehouses ?? []).length === 1, 'la fila de la ruta avisa que otra sucursal surte otra parte');
      r = await falla(A2, () => rutas.routeStart(ruta, { __wh: [W01.id] }), 409, /Ya la está surtiendo/);
      ok(r.ok, `NEGATIVA: otra persona en la MISMA sucursal (01) recibe 409 (${r.msg})`);
      const sB = await como(B, () => rutas.routeStart(ruta, { __wh: [W02.id] }));
      ok(sB.state === 'surtiendo' && sB.pick_started?.user_id === B, 'control positivo: el surtidor de la 02 empieza SU parte de la misma ruta (sin 409)');
      const again = await como(A, () => rutas.routeStart(ruta, { __wh: [W01.id] }));
      ok(again.pick_started?.user_id === A, 'routeStart es idempotente para la misma persona');
      let picks = await trx('commercial.seller_route_day_picks').where({ route_day_id: ruta }).select('warehouse_id', 'pick_started_by', 'pick_finished_at');
      ok(picks.length === 2 && picks.some((p) => p.warehouse_id === W01.id && p.pick_started_by === A) && picks.some((p) => p.warehouse_id === W02.id && p.pick_started_by === B),
        `seller_route_day_picks: 2 filas, una por sucursal con su surtidor (vino ${picks.length})`);
      const legacy = await trx('commercial.seller_route_days').where({ id: ruta }).first('pick_started_by');
      ok(legacy.pick_started_by === null, 'seller_route_days.pick_* ya no se escribe (dueño único)');
      const pp = await trx('commercial.presale_picks').whereIn('order_id', [principal, parte, suelto]).select('order_id', 'started_by');
      ok(pp.length === 3 && pp.find((p) => p.order_id === parte)?.started_by === B && pp.find((p) => p.order_id === principal)?.started_by === A,
        'cada pedido abre su presale_picks con el surtidor de SU sucursal');

      // Cierre: cada uno marca lo encontrado completo.
      const terminar = async (u, w) => {
        const d = await como(u, () => rutas.routeDetail(ruta, { __wh: [w] }));
        return como(u, () => rutas.routeFinish(ruta, { products: d.products.map((p) => ({ product_id: p.product_id, picked: p.qty })) }, { __wh: [w] }));
      };
      r = await falla(A2, () => rutas.routeFinish(ruta, { products: [] }, { __wh: [W01.id] }), 403, /sólo esa persona la puede cerrar/);
      ok(r.ok, `NEGATIVA: otra persona de la 01 no cierra la parte de A (${r.msg})`);
      const fA = await terminar(A, W01.id);
      ok(fA.bags.length === 2 && fA.bags.every((b) => b.outcome === 'completo'), `A cierra la parte de la 01 (2 pedidos completos, vino ${fA.bags.length})`);
      const bagP = fA.bags.find((b) => b.order_id === principal);
      ok(bagP?.group_code === codigo && bagP?.group_parts === 2, 'la bolsa del principal trae group_code y group_parts');
      const vistaB = await como(B, () => rutas.routes({ __wh: [W02.id] }));
      const filaB = vistaB.data.find((x) => x.route_day_id === ruta);
      ok(filaB?.state === 'surtiendo', `con la 01 cerrada, la 02 ve la ruta "surtiendo", NO "surtida" (vino ${filaB?.state})`);
      const vistaA = await como(A, () => rutas.routes({ __wh: [W01.id] }));
      ok(vistaA.data.find((x) => x.route_day_id === ruta)?.state === 'surtida', 'la 01 ve su parte "surtida"');
      r = await falla(A, () => rutas.routeStart(ruta, { __wh: [W01.id] }), 409, /Tu sucursal ya surtió su parte/);
      ok(r.ok, `NEGATIVA: volver a empezar la parte ya cerrada de la 01 → 409 (${r.msg})`);
      const fB = await terminar(B, W02.id);
      ok(fB.bags.some((b) => b.order_id === parte) && !fB.bags.some((b) => b.order_id === principal || b.order_id === suelto), 'B cierra lo de la 02 (la parte, sin el principal ni el suelto de la 01)');
      picks = await trx('commercial.seller_route_day_picks').where({ route_day_id: ruta }).select('warehouse_id', 'pick_finished_by', 'pick_finished_at');
      ok(picks.length === 2 && picks.every((p) => p.pick_finished_at) && picks.find((p) => p.warehouse_id === W02.id)?.pick_finished_by === B,
        'las 2 filas de seller_route_day_picks quedan cerradas, cada una por su surtidor');
      const ppF = await trx('commercial.presale_picks').whereIn('order_id', [principal, parte, suelto]).whereNotNull('finished_at').count('* as n').first();
      ok(Number(ppF.n) === 3, 'los 3 presale_picks quedan terminados');

      throw new Error(RB);
    });
  } catch (e) {
    if (!String(e.message).includes(RB)) { fail++; console.log('  ✗ error inesperado:', e.stack || e.message); }
  }
  console.log(`\n${pass} ✓ · ${fail} ✗ · ${nm} no medido`);
  await knex.destroy();
  process.exit(fail ? 1 : 0);
})();
