/* eslint-disable no-console */
/**
 * `[DN.6]` + `[DN.8]` (ADR-115, anexo A de la fase DN) — **El registro de lo que el cliente pidió y
 * puede no haber**, contra una base REAL.
 *
 * Regla 13 (CLAUDE.md): un endpoint que ESCRIBE no está probado hasta que una prueba lo ejerció contra
 * una base real con el payload de la pantalla. Aquí se carga por ts-node el `CommercialOrdersService`
 * REAL (con el resolvedor de existencia y el registro reales) y se recorre:
 *
 *   [1] La tabla `commercial.order_stock_notices`: la migración corre y es idempotente; cada CHECK y la
 *       llave vigente rechazan lo que deben, con el código exacto de Postgres.
 *   [2] RLS con el rol de la app (`app_runtime`): el tenant propio ve, otro tenant no ve ni inserta, y
 *       nadie borra (lo registrado no se borra, se reemplaza).
 *   [3] ⭐ El payload de la SINCRONIZACIÓN sin conexión (createDraft SIN fecha → PUT lines → place con
 *       la fecha): cada renglón queda con la copia del original y su estado; la promoción no.
 *   [4] En línea con presentación: la cantidad en base Y en su presentación.
 *   [5] Pedido agrupado (ADR-105): el renglón de otra sucursal queda con la raíz del grupo, el pedido de
 *       su parte y la sucursal de surtido; el mismo agendado dos veces no duplica.
 *   [6] Reabrir y reagendar: una fila VIGENTE por llave (la vieja queda reemplazada); un renglón que se
 *       quitó antes de reagendar conserva su fila.
 *   [7] `sin_dato` (lectura vieja) se guarda como tal, con su motivo: nunca como agotado (ADR-056).
 *   [8] Quedan fuera: un rol sin la clave del vendedor, la entrega a domicilio y lo que se agenda sin
 *       fecha (el asistente).
 *   [9] Durable: si el paso 2 muere, el pedido quedó agendado y el barrido declara `sin_dato`; si el
 *       paso 1 falla, el pedido se agenda igual.
 *
 * Sólo se sustituye la infraestructura ajena (motor de precios de Kepler, alertas, push, apartados).
 * El «después del commit» corre aquí en la MISMA transacción (en un SAVEPOINT): la prueba lo espera
 * explícitamente y afirma FILAS, no que `place()` respondió. Todo se revierte al final.
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). Con el `.env` de la máquina
 * de trabajo (prod en sólo lectura) aborta; la ejerce el job `pruebas-db` del CI o una base local,
 * con `DATABASE_URL_NEW` apuntando a esa base (localhost):
 *
 *   node database/tests/test-newdb-dn-registro-negado.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-dn-registro-negado', { url: process.env.DATABASE_URL_NEW });
const { noMedido, correr } = require('./_lib/no-medido');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const mig = require('../migrations-newdb/20261107175004_dn6_order_stock_notices.js');

const T = '00000000-0000-0000-0000-00000000d01c';
const OTRO = '11111111-2222-3333-4444-555555555555';
const RAIZ = path.resolve(__dirname, '..', '..');
const ROL_VENDEDOR = 'zz_dn_vendedor';
const ROL_SIN_CLAVE = 'zz_dn_sin_clave';
const BUILD = 'vendor@prueba.dn11a';

let pass = 0, fail = 0, nm = 0;
const ok = (cond, msg, detalle) => {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg, detalle === undefined ? '' : `→ ${JSON.stringify(detalle)}`); }
};
/** Un tramo que esta base no puede ejercer: se cuenta y se dice; nunca se pinta como ✓. */
const noMedidoTramo = (msg) => { nm++; console.log('  ⊘ NO MEDIDO —', msg); };
/**
 * Falta el entorno a mitad de la prueba: si ya hubo un ✗, la suite FALLÓ (exit 1), no «no se midió».
 */
const noMedidoTodo = (msg) => {
  if (fail) { console.log(`  ✗ (y además: ${msg})`); console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido\n`); process.exit(1); }
  noMedido(msg);
};
const RB = '__rb__';

/** Ejecuta `fn` en un SAVEPOINT y devuelve el código de error de Postgres (o null si no falló). */
async function codigoDe(trx, fn) {
  await trx.raw('SAVEPOINT dn_sp');
  try {
    await fn();
    await trx.raw('RELEASE SAVEPOINT dn_sp');
    return null;
  } catch (e) {
    await trx.raw('ROLLBACK TO SAVEPOINT dn_sp');
    return e.code || e.message;
  }
}

/** Carga los módulos REALES del pedido con dobles sólo para lo que no es existencia ni registro. */
function cargar() {
  const d = (n) => path.join(__dirname, `.stub-dn8-${n}.js`);
  const contrato = path.join(RAIZ, 'libs/contracts/src/http/stock-state.contract.ts').replace(/\\/g, '/');
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
    Orders: lib('commercial-orders/commercial-orders.service.ts').CommercialOrdersService,
    notices: lib('commercial-orders/order-stock-notices.ts'),
  };
}

/** Lo que `place()` deja corriendo «después del commit»: la prueba lo espera antes de afirmar. */
const despues = [];
const esperarDespues = async () => {
  await new Promise((r) => setImmediate(r));
  await Promise.all(despues.splice(0));
};

/**
 * El servicio REAL con dobles de infraestructura. `run(cb)` = la transacción de `place()` (la de la
 * prueba); `run(tenantId, cb)` = el paso 2, en un SAVEPOINT de la misma transacción (o caído a
 * propósito con `fallaDespues`).
 */
function servicio(Orders, trx, userId, rol, { fallaDespues = false } = {}) {
  const tk = {
    run: (a, b) => {
      const fn = typeof a === 'function' ? a : b;
      if (typeof a !== 'string') return fn(trx);
      const p = fallaDespues ? Promise.reject(new Error('paso 2 caído a propósito')) : trx.transaction((sp) => fn(sp));
      despues.push(p.catch(() => undefined));
      return p;
    },
  };
  const ctx = { get: () => ({ tenantId: T, userId, roleName: rol }), requireTenantId: () => T };
  const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0.16, min_purchase: 1, source: 'list' }) };
  const alerts = { emitLargeOrder: () => undefined, emitOrderConfirmed: () => undefined, emitTo: () => undefined };
  const push = { sendToCustomer: async () => undefined };
  const stock = { reserve: async () => undefined, release: async () => undefined, consume: async () => undefined };
  const quotes = { ladders: async () => new Map(), priceLine: async () => ({ line_total: null, unit_price: null }) };
  return new Orders(tk, ctx, pricing, {}, alerts, push, stock, quotes);
}

correr(async () => {
  console.log('\n[DN.6 + DN.8] El registro de lo negado al agendar, contra base real\n');
  let M;
  try {
    M = cargar();
  } catch (e) {
    noMedido(`no se pudieron cargar los módulos reales (${e.message.split('\n')[0]})`);
  }

  try {
    await knex.transaction(async (trx) => {
      if ((await trx.raw('show transaction_read_only')).rows[0].transaction_read_only === 'on') {
        noMedido('la conexión es de sólo lectura: no se puede sembrar ni escribir');
      }
      await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
      const faltan = (await trx.raw(
        `SELECT x FROM unnest(ARRAY['analytics.v_erp_stock_on_hand','analytics.ods_branch_checks','kepler_ods.kdil',
                                     'identity.role_permissions','commercial.orders']) x
          WHERE to_regclass(x) IS NULL`,
      )).rows.map((r) => r.x);
      if (faltan.length) noMedido(`la base no tiene ${faltan.join(', ')}`);
      const user = await trx('identity.users').whereNull('deleted_at').first('id');
      const marca = await trx('catalog.brands').whereRaw('COALESCE(is_commercial, true)').first('id');
      const lista = await trx('commercial.price_lists').where({ is_default: true }).whereNull('deleted_at').first('id');
      if (!user || !marca || !lista) noMedido('la base no tiene usuario, marca comercial o lista default');

      // ── [1] La tabla ─────────────────────────────────────────────────────────────────────
      console.log('[1] La tabla: migración, CHECKs y llave vigente');
      const existia = await trx.schema.withSchema('commercial').hasTable('order_stock_notices');
      if (!existia) await mig.up(trx);
      ok(await trx.schema.withSchema('commercial').hasTable('order_stock_notices'),
        `la tabla existe (${existia ? 'ya migrada' : 'up() aplicado en la transacción'})`);
      ok((await codigoDe(trx, () => mig.up(trx))) === null, 'up() es idempotente (segunda corrida sin error)');

      // ── Siembra: 3 sucursales de una zona de prueba, 4 productos, kdil y la frescura ──
      await trx('identity.role_permissions').insert([
        { tenant_id: T, role_name: ROL_VENDEDOR, permissions: JSON.stringify({ VENDOR_APP_ACCESS: true }) },
        { tenant_id: T, role_name: ROL_SIN_CLAVE, permissions: JSON.stringify({}) },
      ]);
      const wh = async (code, i) => (await trx('commercial.warehouses').insert({
        tenant_id: T, code, kepler_code: code, name: `Prueba DN ${code}`, short_label: code, kind: 'central', active: true,
        purchase_zone: 'ZZ-ZONA-DN', display_order: 90 + i,
      }).returning('id'))[0].id;
      const D1 = await wh('D1', 1); const D2 = await wh('D2', 2); const D3 = await wh('D3', 3);
      const prod = async (nombre, sku) => (await trx('catalog.products').insert({
        tenant_id: T, brand_id: marca.id, nombre, sku, activo: true,
      }).returning('id'))[0].id;
      const HAY = await prod('ZZDN HAY', 'ZZDNA');
      const CERO = await prod('ZZDN CERO', 'ZZDNB');
      const NADIE = await prod('ZZDN NADIE', 'ZZDNC');
      const PROMO = await prod('3 ZZDN = GRATIS', 'ZZDNP');
      for (const p of [HAY, CERO, NADIE, PROMO]) {
        await trx('commercial.product_prices').insert({ tenant_id: T, price_list_id: lista.id, product_id: p, price: 10, tax_rate: 0.16 });
      }
      const kd = (suc, sku, qty) => trx('kepler_ods.kdil').insert({
        sucursal: suc, c1: suc, c2: 1, c3: sku, c4: qty, c8: 0, c9: 0, c6: trx.fn.now(), c7: trx.fn.now(),
      });
      // D1: HAY 50, CERO 0 · D2: HAY 5, CERO 0 · D3 (lectura vieja): HAY 0. NADIE no está en ninguna.
      await kd('D1', 'ZZDNA', 50); await kd('D1', 'ZZDNB', 0);
      await kd('D2', 'ZZDNA', 5); await kd('D2', 'ZZDNB', 0);
      await kd('D3', 'ZZDNA', 0);
      const chk = (suc, hace) => trx.raw(
        `INSERT INTO analytics.ods_branch_checks (tenant_id, lane, sucursal, last_check_at, tables_checked, rows_shipped, last_error)
         VALUES (?, 'ods_live_hot', ?, now() - (? || ' hours')::interval, 30, 0, NULL)
         ON CONFLICT (tenant_id, lane, sucursal) DO UPDATE SET last_check_at = EXCLUDED.last_check_at, last_error = NULL`,
        [T, suc, String(hace)],
      );
      await chk('D1', 0); await chk('D2', 1); await chk('D3', 10);
      const vista = (await trx.raw(
        `SELECT count(*)::int n FROM analytics.v_erp_stock_on_hand WHERE warehouse_id = ANY(?::uuid[])`, [[D1, D2, D3]],
      )).rows[0].n;
      if (vista !== 5) noMedidoTodo(`la vista no ve la siembra de kdil (${vista} de 5 filas): su definición difiere en esta base`);
      const cliente = async (code, name) => (await trx('commercial.customers').insert({
        tenant_id: T, code, name, active: true, default_price_list_id: lista.id,
      }).returning('id'))[0];
      const cli = await cliente('ZZ-DN-CLI', 'Cliente prueba DN.8');
      const cli2 = await cliente('ZZ-DN-CLI2', 'Cliente prueba DN.8 (2)');
      // El del pedido agrupado: reabrir exige que el cliente no tenga OTRO borrador del mismo vendedor.
      const cli3 = await cliente('ZZ-DN-CLI3', 'Cliente prueba DN.8 (3)');

      // Una orden real para los CHECKs (la llave apunta a commercial.orders).
      const vend = servicio(M.Orders, trx, user.id, ROL_VENDEDOR);
      const ox = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      const filaX = (p) => ({ tenant_id: T, root_order_id: ox.id, order_id: ox.id, source_warehouse_id: D1, product_id: HAY, quantity: 1, ...p });
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({ stock_state: 'inventado' })))) === '23514',
        'stock_state fuera de la lista → 23514');
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({ decision: 'inventada' })))) === '23514',
        'decision fuera de la lista → 23514');
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({ context: 'portal' })))) === '23514',
        'context fuera de la lista → 23514');
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({})))) === null, 'control: una fila válida entra');
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({})))) === '23505',
        '⭐ dos filas VIGENTES con la misma llave (pedido, producto, sucursal) → 23505');
      ok((await codigoDe(trx, async () => {
        await trx('commercial.order_stock_notices').where({ root_order_id: ox.id }).update({ superseded_at: trx.fn.now() });
        await trx('commercial.order_stock_notices').insert(filaX({}));
      })) === null, 'control: reemplazada + nueva con la misma llave entran');
      // El par que distingue la llave por PEDIDO de la vieja por RAÍZ (la que contaba doble): con la
      // vieja, el primero entraría y el segundo daría 23505.
      const oy = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({ root_order_id: oy.id })))) === '23505',
        '⭐ mismo pedido con OTRA raíz → 23505 (la llave es el pedido, no la raíz)');
      ok((await codigoDe(trx, () => trx('commercial.order_stock_notices').insert(filaX({ order_id: oy.id })))) === null,
        '⭐ misma raíz en OTRO pedido del grupo → entra (dos demandas, no se pisan)');

      // ── [2] RLS con el rol de la app ────────────────────────────────────────────────────
      console.log('\n[2] RLS con app_runtime');
      // Cuántas ve el superusuario (que se salta RLS): la app, con su tenant, tiene que ver las mismas.
      const sembradas = Number((await trx.raw('SELECT count(*) AS n FROM commercial.order_stock_notices WHERE root_order_id = ?', [ox.id])).rows[0].n);
      const rls = await codigoDe(trx, async () => {
        await trx.raw('SET LOCAL ROLE app_runtime');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
        const propio = Number((await trx.raw('SELECT count(*) AS n FROM commercial.order_stock_notices WHERE root_order_id = ?', [ox.id])).rows[0].n);
        // Control: con SU tenant la app sí inserta; así el 42501 de abajo es RLS y no falta de permiso.
        const insPropio = await codigoDe(trx, () => trx.raw(
          `INSERT INTO commercial.order_stock_notices (tenant_id, root_order_id, order_id, source_warehouse_id, product_id, quantity)
           VALUES (public.current_tenant_id(), ?, ?, ?, ?, 1)`, [ox.id, ox.id, D2, NADIE]));
        ok(insPropio === null, 'control: app_runtime inserta con su propio tenant', insPropio);
        const ins = await codigoDe(trx, () => trx.raw(
          `INSERT INTO commercial.order_stock_notices (tenant_id, root_order_id, order_id, source_warehouse_id, product_id, quantity)
           VALUES (?, ?, ?, ?, ?, 1)`, [OTRO, ox.id, ox.id, D2, HAY]));
        const borrar = await codigoDe(trx, () => trx.raw('DELETE FROM commercial.order_stock_notices WHERE root_order_id = ?', [ox.id]));
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [OTRO]);
        const ajeno = Number((await trx.raw('SELECT count(*) AS n FROM commercial.order_stock_notices')).rows[0].n);
        await trx.raw('RESET ROLE');
        await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [T]);
        ok(sembradas > 0 && propio === sembradas, `control RLS: el tenant propio ve sus ${sembradas} filas`, propio);
        ok(ajeno === 0, '⭐ RLS: otro tenant ve CERO filas', ajeno);
        ok(ins === '42501', '❌ un INSERT con el tenant de otro lo rechaza RLS (42501)', ins);
        ok(borrar === '42501', 'sin DELETE para app_runtime (42501): lo registrado no se borra', borrar);
      });
      ok(rls === null, 'la prueba de RLS corrió (rol app_runtime disponible)', rls);

      const filasDe = (root) => trx('commercial.order_stock_notices').where({ root_order_id: root }).orderBy('created_at');
      const vigentesDe = async (root) => (await filasDe(root)).filter((f) => !f.superseded_at);
      const por = (fs_) => new Map(fs_.map((f) => [`${f.product_id}|${f.source_warehouse_id}`, f]));

      // ── [3] La sincronización sin conexión ───────────────────────────────────────────────
      console.log('\n[3] ⭐ El payload de la sincronización sin conexión');
      const o1 = await vend.createDraft({ client_uuid: '0d0d0d0d-0000-4000-8000-00000000dd01', customer_id: cli.id, warehouse_id: D1, delivery_type: 'route' });
      ok(!o1.requested_delivery_date, 'el borrador nace SIN fecha (como lo crea la sincronización)');
      const rep = await vend.replaceLines(o1.id, { lines: [
        { product_id: HAY, quantity: 2 }, { product_id: CERO, quantity: 1 }, { product_id: NADIE, quantity: 3 }, { product_id: PROMO, quantity: 1 },
      ] });
      ok(rep.added === 4, `los 4 renglones se guardan (added=${rep.added}, skipped=${JSON.stringify(rep.skipped)})`);
      const tomado1 = await vend.place(o1.id, { requested_delivery_date: '2030-02-01', client_build: BUILD });
      await esperarDespues();
      ok(tomado1.status === 'confirmed', 'el pedido queda agendado');
      const f1 = await vigentesDe(o1.id);
      const m1 = por(f1);
      ok(f1.length === 3, `3 filas: HAY, CERO y NADIE; la promoción no (vinieron ${f1.length})`);
      ok(m1.get(`${CERO}|${D1}`)?.stock_state === 'agotado' && m1.get(`${CERO}|${D1}`)?.decision === 'sin_aviso',
        '⭐ CERO agotado en D1 → 1 fila «sin_aviso» (nadie vio un aviso: lo registró el servidor)');
      ok(m1.get(`${NADIE}|${D1}`)?.stock_state === 'no_se_maneja', 'NADIE → no_se_maneja (DA3: aparte de agotado)');
      ok(m1.get(`${HAY}|${D1}`)?.stock_state === 'con_existencia' && Number(m1.get(`${HAY}|${D1}`)?.stock_qty) === 50,
        'HAY → con_existencia, 50 (es el denominador de la métrica)');
      ok(f1.every((f) => f.client_build === BUILD), `todas llevan la versión de la app (${BUILD})`);
      ok(f1.every((f) => f.qty_unit === null && f.unit_quantity === null && f.qty_factor === null),
        'sincronizado sin unidad → presentación en null: nunca se rellena con la base');
      ok(Number(m1.get(`${NADIE}|${D1}`)?.quantity) === 3 && Number(m1.get(`${CERO}|${D1}`)?.unit_price) > 0,
        'la copia del original: cantidad en base y precio de referencia');
      ok(f1.every((f) => f.root_order_id === o1.id && f.order_id === o1.id && f.order_line_id && f.customer_id === cli.id
        && f.seller_user_id === user.id && f.order_warehouse_id === D1 && f.requested_delivery_date !== null),
        'raíz, pedido, renglón, cliente, vendedor, sucursal del pedido y fecha de entrega (no nula)');
      ok(f1.every((f) => f.stock_checked_at !== null), 'cada fila dice de cuándo es la lectura de existencia');

      // ── [4] En línea con presentación ───────────────────────────────────────────────────
      console.log('\n[4] En línea, con presentación');
      const o4 = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      const conUnidad = await codigoDe(trx, () => vend.addLine(o4.id, { product_id: CERO, quantity: 2, qty_unit: 'CJA', qty_factor: 6 }));
      // Sólo la FALTA de la vista del resolvedor de unidad (42P01) es entorno; cualquier otro error es falla.
      if (conUnidad === '42P01') {
        noMedidoTramo('esta base no tiene analytics.v_product_box_factor: [4] no se puede ejercer');
      } else if (conUnidad !== null) {
        ok(false, 'agregar en CJA con qty_factor (pantalla) no debe fallar', conUnidad);
      } else {
        await vend.place(o4.id, { requested_delivery_date: '2030-02-02', client_build: BUILD });
        await esperarDespues();
        const f4 = (await vigentesDe(o4.id))[0];
        ok(f4 && Number(f4.quantity) === 12 && f4.qty_unit === 'CJA' && Number(f4.qty_factor) === 6 && Number(f4.unit_quantity) === 2,
          '⭐ la cantidad en BASE (12) y en su PRESENTACIÓN (2 CJA), sin sumar unidades distintas', f4 && [f4.quantity, f4.qty_unit, f4.qty_factor, f4.unit_quantity]);
        ok(f4 && f4.stock_state === 'agotado', 'y su estado (agotado en D1)');
      }

      // ── [5] Pedido agrupado ─────────────────────────────────────────────────────────────
      console.log('\n[5] Pedido agrupado (ADR-105): la raíz no cambia al separar');
      const o5 = await vend.createDraft({ customer_id: cli3.id, warehouse_id: D1 });
      await vend.addLine(o5.id, { product_id: HAY, quantity: 1 });
      const l5 = await vend.addLine(o5.id, { product_id: CERO, quantity: 4, source_warehouse_id: D2 });
      ok(l5 && l5.stock_state === 'agotado' && l5.stock_review?.warehouse_id === D2,
        '[DN.7] el renglón de D2 se guarda y dice «agotado» en D2 (antes: 409)', l5 && l5.stock_state);
      const t5 = await vend.place(o5.id, { requested_delivery_date: '2030-02-03', client_build: BUILD });
      await esperarDespues();
      const parte = await trx('commercial.orders').where({ group_id: o5.id }).whereNot('id', o5.id).first('id', 'warehouse_id');
      ok(t5.group_parts === 2 && parte && parte.warehouse_id === D2, 'el pedido se separó en dos partes (D1 y D2)');
      const f5 = por(await vigentesDe(o5.id));
      const cero5 = f5.get(`${CERO}|${D2}`);
      ok(cero5 && cero5.root_order_id === o5.id && cero5.order_id === parte?.id && cero5.stock_state === 'agotado',
        '⭐ CERO de D2: raíz = el principal, pedido = su parte, sucursal de surtido = D2, agotado');
      ok(f5.get(`${HAY}|${D1}`)?.order_id === o5.id, 'HAY de D1 queda con el principal');
      const antes5 = (await filasDe(o5.id)).length;
      await vend.place(o5.id, { requested_delivery_date: '2030-02-03', client_build: BUILD });
      await esperarDespues();
      ok((await filasDe(o5.id)).length === antes5, 'el mismo agendado enviado dos veces no duplica filas');

      // [5b] Lo que encontró la revisión adversarial: reabrir una PARTE y reagendarla con un renglón de
      // otra sucursal hace que `separarPorSucursal` le cambie el grupo. Con la llave por raíz, el renglón
      // que NO cambió quedaba vigente dos veces.
      console.log('\n[5b] Reabrir una PARTE y reagendarla con un renglón de otra sucursal: no cuenta doble');
      await vend.reopen(parte.id, 'prueba DN.8: corregir la parte');
      await vend.addLine(parte.id, { product_id: HAY, quantity: 2, source_warehouse_id: D1 });
      await vend.place(parte.id, { requested_delivery_date: '2030-02-03', client_build: BUILD });
      await esperarDespues();
      const grupo5 = await trx('commercial.order_stock_notices')
        .whereIn('order_id', trx('commercial.orders').where('group_id', o5.id).orWhere('group_id', parte.id).orWhere('id', o5.id).select('id'))
        .whereNull('superseded_at');
      const cero5b = grupo5.filter((f) => f.product_id === CERO && f.source_warehouse_id === D2);
      ok(cero5b.length === 1, `⭐ CERO de D2 (el renglón que NO cambió) sigue con UNA fila vigente (vinieron ${cero5b.length})`);
      ok(grupo5.every((f) => f.root_order_id === o5.id),
        '⭐ todas las filas del grupo conservan la raíz original aunque la parte cambió de grupo',
        grupo5.map((f) => f.root_order_id === o5.id));
      const hay5b = grupo5.filter((f) => f.product_id === HAY && f.source_warehouse_id === D1);
      ok(hay5b.length === 2 && new Set(hay5b.map((f) => f.order_id)).size === 2,
        'HAY de D1: la del principal y la nueva (otra parte) son dos demandas, dos filas (no se pisan)');

      // ── [6] Reabrir y reagendar ─────────────────────────────────────────────────────────
      console.log('\n[6] Reabrir y reagendar');
      await vend.reopen(o1.id, 'prueba DN.8');
      const lineaCero = await trx('commercial.order_lines').where({ order_id: o1.id, product_id: CERO }).first('id');
      await vend.removeLine(o1.id, lineaCero.id);
      await vend.place(o1.id, { requested_delivery_date: '2030-02-01', client_build: BUILD });
      await esperarDespues();
      const todas6 = await filasDe(o1.id);
      const vig6 = todas6.filter((f) => !f.superseded_at);
      // Lo que puede ponerse en rojo: las filas de [3] de HAY y NADIE quedaron REEMPLAZADAS (si el UPDATE
      // no las marcara, el INSERT caería en ON CONFLICT y la vigente seguiría siendo la vieja).
      const de3 = (prod) => m1.get(`${prod}|${D1}`);
      ok([HAY, NADIE].every((p) => todas6.find((f) => f.id === de3(p)?.id)?.superseded_at),
        '⭐ las filas del primer agendado de HAY y NADIE quedaron reemplazadas');
      ok([HAY, NADIE].every((p) => vig6.filter((f) => f.product_id === p).length === 1
        && vig6.find((f) => f.product_id === p).id !== de3(p)?.id),
        '⭐ y cada uno tiene UNA vigente nueva, con la lectura del segundo agendado (no se cuenta doble)');
      const cero6 = vig6.find((f) => f.product_id === CERO);
      ok(cero6 && !cero6.superseded_at && cero6.order_line_id === lineaCero.id && cero6.stock_state === 'agotado',
        '⭐ el renglón que se QUITÓ antes de reagendar conserva su fila con la copia del original');
      ok(!(await trx('commercial.order_lines').where({ id: lineaCero.id }).first('id')), 'control: ese renglón ya no existe en el pedido');

      // [6b] La rama del reemplazo POR RENGLÓN, sola: el renglón sigue siendo el mismo (mismo id) pero cambió
      // de sucursal, así que su llave nueva no coincide con la vieja. Sin esa rama, la demanda contaría doble.
      console.log('\n[6b] Reagendar con un renglón que cambió de sucursal (mismo renglón, otra llave)');
      const hayVieja = vig6.find((f) => f.product_id === HAY);
      await vend.reopen(o1.id, 'prueba DN.8: surtir HAY de D2');
      const lineaHay = await trx('commercial.order_lines').where({ order_id: o1.id, product_id: HAY }).first('id');
      await vend.updateLine(o1.id, lineaHay.id, { quantity: 2, source_warehouse_id: D2 });
      await vend.place(o1.id, { requested_delivery_date: '2030-02-01', client_build: BUILD });
      await esperarDespues();
      const parte6 = await trx('commercial.orders').where({ group_id: o1.id }).whereNot('id', o1.id).first('id');
      const hay6b = await trx('commercial.order_stock_notices').where({ product_id: HAY }).whereIn('order_id', [o1.id, parte6?.id].filter(Boolean)).whereNull('superseded_at');
      ok(parte6 && hay6b.length === 1 && hay6b[0].order_id === parte6.id && hay6b[0].source_warehouse_id === D2 && hay6b[0].order_line_id === lineaHay.id,
        '⭐ HAY queda con UNA sola fila vigente: la de la parte de D2, mismo renglón', hay6b.map((f) => [f.order_id === parte6?.id, f.source_warehouse_id === D2]));
      ok((await trx('commercial.order_stock_notices').where({ id: hayVieja.id }).first('superseded_at')).superseded_at !== null,
        'la fila de HAY en D1 quedó reemplazada (por el renglón, no por la llave)');
      ok(hay6b.every((f) => f.root_order_id === o1.id), 'y conserva la raíz del pedido');

      // [6c] La rama del reemplazo POR LLAVE, sola: `replaceLines` borra los renglones y los vuelve a crear con
      // id NUEVO (el lote de la sincronización y del sugerido): la fila vieja no coincide por renglón.
      console.log('\n[6c] Reagendar después de un lote (renglón nuevo, misma llave)');
      const nadieVieja = (await trx('commercial.order_stock_notices').where({ order_id: o1.id, product_id: NADIE }).whereNull('superseded_at'))[0];
      await vend.reopen(o1.id, 'prueba DN.8: rehacer el pedido');
      await vend.replaceLines(o1.id, { lines: [{ product_id: NADIE, quantity: 5 }] });
      await vend.place(o1.id, { requested_delivery_date: '2030-02-01', client_build: BUILD });
      await esperarDespues();
      const nadie6c = await trx('commercial.order_stock_notices').where({ order_id: o1.id, product_id: NADIE }).whereNull('superseded_at');
      ok(nadieVieja && nadie6c.length === 1 && nadie6c[0].id !== nadieVieja.id && Number(nadie6c[0].quantity) === 5
        && nadie6c[0].order_line_id !== nadieVieja.order_line_id,
        '⭐ NADIE queda con UNA vigente, la del renglón nuevo (5), y la del renglón anterior quedó reemplazada por la llave');

      // ── [7] sin_dato ────────────────────────────────────────────────────────────────────
      console.log('\n[7] sin_dato: lectura vieja');
      const o7 = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      await vend.addLine(o7.id, { product_id: HAY, quantity: 1, source_warehouse_id: D3 });
      await vend.place(o7.id, { requested_delivery_date: '2030-02-04', client_build: BUILD });
      await esperarDespues();
      const f7 = (await vigentesDe(o7.id)).find((f) => f.source_warehouse_id === D3);
      ok(f7 && f7.stock_state === 'sin_dato' && f7.stock_qty === null && typeof f7.stock_reason === 'string' && f7.stock_reason.length > 0,
        `⭐ D3 con lectura de hace 10 h → sin_dato con su motivo («${f7 && f7.stock_reason}»), aunque la vista diga 0`);

      // ── [8] Lo que queda fuera ──────────────────────────────────────────────────────────
      console.log('\n[8] Lo que queda fuera');
      const otro = servicio(M.Orders, trx, user.id, ROL_SIN_CLAVE);
      const o8a = await otro.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      await otro.addLine(o8a.id, { product_id: CERO, quantity: 1 });
      await otro.place(o8a.id, { requested_delivery_date: '2030-02-05' });
      await esperarDespues();
      ok((await filasDe(o8a.id)).length === 0, 'un rol SIN la clave del vendedor → 0 filas');
      const o8b = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1, delivery_type: 'home_delivery', requested_delivery_date: '2030-02-05' });
      await vend.addLine(o8b.id, { product_id: CERO, quantity: 1 });
      await vend.place(o8b.id, {});
      await esperarDespues();
      ok((await filasDe(o8b.id)).length === 0, 'entrega a domicilio → 0 filas (otro anexo)');
      const o8c = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      await vend.addLine(o8c.id, { product_id: CERO, quantity: 1 });
      await vend.place(o8c.id, {});
      await esperarDespues();
      ok((await filasDe(o8c.id)).length === 0, 'agendado SIN fecha (el asistente) → 0 filas (se declara aparte)');

      // ── [9] Durable ─────────────────────────────────────────────────────────────────────
      console.log('\n[9] Durable: el registro nunca tumba el agendado');
      const caido = servicio(M.Orders, trx, user.id, ROL_VENDEDOR, { fallaDespues: true });
      const o9 = await caido.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      await caido.addLine(o9.id, { product_id: CERO, quantity: 1 });
      const t9 = await caido.place(o9.id, { requested_delivery_date: '2030-02-06', client_build: BUILD });
      await esperarDespues();
      const f9 = await vigentesDe(o9.id);
      ok(t9.status === 'confirmed' && f9.length === 1 && f9[0].stock_state === 'pendiente',
        '⭐ el paso 2 murió: el pedido quedó agendado y la marca sigue «pendiente» (no se perdió)');
      ok((await M.notices.declararPendientesViejas(trx, M.notices.MINUTOS_PARA_DECLARAR)) === 0,
        'control: una marca recién hecha NO se barre');
      // El umbral (10 min) se prueba de los dos lados: 5 min no se barre, 20 sí. Dentro de una sola
      // transacción now() es fijo, así que «recién hecha» tiene edad 0: por eso hace falta el de 5 min.
      await trx('commercial.order_stock_notices').where({ id: f9[0].id }).update({ created_at: trx.raw(`now() - interval '5 minutes'`) });
      ok((await M.notices.declararPendientesViejas(trx, M.notices.MINUTOS_PARA_DECLARAR)) === 0,
        '⭐ una marca de hace 5 min (menos que el umbral) NO se barre');
      await trx('commercial.order_stock_notices').where({ id: f9[0].id }).update({ created_at: trx.raw(`now() - interval '20 minutes'`) });
      const barridas = await M.notices.declararPendientesViejas(trx, M.notices.MINUTOS_PARA_DECLARAR);
      const g9 = await trx('commercial.order_stock_notices').where({ id: f9[0].id }).first('stock_state', 'stock_reason');
      ok(barridas >= 1 && g9.stock_state === 'sin_dato' && g9.stock_reason === M.notices.MOTIVO_BARRIDO,
        `⭐ el barrido la declara sin_dato con su motivo, nunca 0 ni «había» (barridas: ${barridas})`);

      const o9b = await vend.createDraft({ customer_id: cli2.id, warehouse_id: D1 });
      await vend.addLine(o9b.id, { product_id: CERO, quantity: 1 });
      await trx.raw('ALTER TABLE commercial.order_stock_notices RENAME TO order_stock_notices_dn_caida');
      const e9b = await codigoDe(trx, () => vend.place(o9b.id, { requested_delivery_date: '2030-02-07', client_build: BUILD }));
      const s9b = await trx('commercial.orders').where({ id: o9b.id }).first('status');
      await trx.raw('ALTER TABLE commercial.order_stock_notices_dn_caida RENAME TO order_stock_notices');
      ok(e9b === null && s9b && s9b.status === 'confirmed',
        '⭐ con el paso 1 caído (la tabla no está) el pedido se agenda IGUAL: el registro nunca hace fallar place()', e9b);

      throw new Error(RB);
    });
  } catch (e) {
    if (!String(e.message).includes(RB)) { fail++; console.log('  ✗ error inesperado:', e.message); }
  }
  console.log(`\n  ${pass} ✓ · ${fail} ✗ · ${nm} no medido\n`);
  await knex.destroy();
  process.exit(fail ? 1 : (pass ? 0 : 2));
});
