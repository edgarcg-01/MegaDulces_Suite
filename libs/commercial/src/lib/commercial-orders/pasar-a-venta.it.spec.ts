/**
 * `[MCP.34]` Prueba de INTEGRACIÓN — «Pasar a venta» con el código REAL del servicio contra Postgres real, como
 * `app_runtime` (RLS, grants, FKs y CHECKs de verdad). Regla 13: un camino que escribe no está probado hasta
 * ejercerlo contra una base real con el payload de la pantalla (el de `VendorQuoteService.pasarAVenta`:
 * `{ requested_delivery_date, dry_run? }`).
 *
 *   · la vista previa (`dry_run`) arma el pedido y NO deja nada: ni pedido, ni renglones, ni la cotización tocada;
 *   · pasar a venta deja un pedido `confirmed` con el día elegido y los renglones propios (sin regalos), y la
 *     cotización `accepted` con su `order_id` (el CHECK `order_only_when_accepted` lo exige así);
 *   · el segundo toque devuelve EL MISMO pedido (`ya_existia`), no hace otro;
 *   · negativas: la de otro vendedor (403), la de telemarketing (409), una fecha pasada (400), y en ninguna queda
 *     nada escrito.
 *
 * El precio lo pone el motor del pedido; aquí el almacén de prueba no tiene sucursal de Kepler, así que cae al
 * cálculo anterior (`resolvePriceForQty`), que se sustituye por un precio fijo: lo que se prueba es la
 * transacción y lo que queda escrito, no la tarifa (ésa la prueban las suites del motor).
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`). Sin la
 * variable se salta y lo DICE. Todo dentro de una transacción que se revierte; cada llamada en su SAVEPOINT.
 */
import knexFactory, { type Knex } from 'knex';
import { CommercialOrdersService } from './commercial-orders.service';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const DIA = (d: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date(Date.now() + d * 86_400_000));

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[MCP.34] NO MEDIDO: sin TP_IT_DB la prueba de integración de «Pasar a venta» no corre.');

async function status(fn: () => Promise<unknown>): Promise<number | string> {
  try {
    await fn();
    return 200;
  } catch (e) {
    const x = e as { getStatus?: () => number; code?: string; message: string };
    return typeof x.getStatus === 'function' ? x.getStatus() : (x.code ?? x.message);
  }
}

suite('[MCP.34] pasar una cotización a venta, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};
  let sesion = '';
  const ctx = { get: () => ({ userId: sesion, roleName: 'vendedor_ruta', tenantId: M }), requireTenantId: () => M };
  const tk = { run: <T>(fn: (t: Knex.Transaction) => Promise<T>) => trx.transaction((sp) => fn(sp)) };
  // Lo que no participa: cualquier método es un no-op asíncrono.
  const noop = new Proxy({}, { get: () => async () => undefined }) as never;
  const pricing = { resolvePriceForQty: async () => ({ price: 10, tax_rate: 0, source: 'it' }) };
  const pedidos = new CommercialOrdersService(tk as never, ctx as never, pricing as never, noop, noop, noop, noop, noop);

  const pasar = (quote: string, body: Record<string, unknown>) => pedidos.pasarCotizacionAVenta(quote, body);
  const pedidosDe = () => trx('commercial.orders').where({ customer_id: ids['cliente'] }).select('id', 'status');

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    // ── Siembra, como el dueño ──────────────────────────────────────────────────────────────────────
    const { role_name } = await trx('identity.users').where({ tenant_id: M }).whereNotNull('role_name').first('role_name');
    const usuario = async (username: string, nombre: string) =>
      (await trx('identity.users').insert({ tenant_id: M, username, nombre, role_name, status: 'invited' }).returning('id'))[0].id;
    ids['yo'] = await usuario('it_mcp34_yo', 'VENDEDORA IT MCP34');
    ids['otro'] = await usuario('it_mcp34_otro', 'OTRO IT MCP34');
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: 'IT-M34', name: 'IT MCP34 almacén' }).returning('id');
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT MCP34 marca' }).returning('id');
    const prod = async (nombre: string, sku: string) =>
      (await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre, sku }).returning('id'))[0].id;
    ids['gomitas'] = await prod('GOMITAS IT34', 'IT34GOM');
    ids['chicle'] = await prod('CHICLE IT34', 'IT34CHI');
    ids['cliente'] = (await trx('commercial.customers').insert({ tenant_id: M, code: 'IT34CLI', name: 'Abarrotes IT34' }).returning('id'))[0].id;
    const cotizacion = async (k: string, code: string, user_id: string, origin = 'route_visit') => {
      const [q] = await trx('commercial.quotes').insert({
        tenant_id: M, code, customer_id: ids['cliente'], origin, user_id, warehouse_id: w.id, status: 'draft',
        valid_until: DIA(7), total: 75,
      }).returning('id');
      ids[k] = q.id;
      await trx('commercial.quote_lines').insert([
        { tenant_id: M, quote_id: q.id, line_number: 1, product_id: ids['gomitas'], quantity: 3, unit_price: 20, line_subtotal: 60, line_total: 60 },
        { tenant_id: M, quote_id: q.id, line_number: 2, product_id: ids['chicle'], quantity: 1, unit_price: 15, line_subtotal: 15, line_total: 15 },
        // Regalo del motor de la cotización: el pedido calcula los suyos, no pasa.
        { tenant_id: M, quote_id: q.id, line_number: 3, product_id: ids['chicle'], quantity: 1, unit_price: 0, parent_line_number: 2, price_source: 'free_goods' },
        // Renglón sin producto del catálogo: se nombra, no pasa.
        { tenant_id: M, quote_id: q.id, line_number: 4, product_id: null, requested_text: 'paletas de tamarindo', quantity: 2 },
      ]);
    };
    await cotizacion('Q', 'IT34-COT-1', ids['yo']);
    await cotizacion('QOTRO', 'IT34-COT-2', ids['otro']);
    await cotizacion('QTLMK', 'IT34-COT-3', ids['yo'], 'telemarketing');
    // ── De aquí en adelante, como la app ────────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
    sesion = ids['yo'];
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('la vista previa da el total de HOY y no deja NADA escrito', async () => {
    const r = await pasar(ids['Q'], { requested_delivery_date: DIA(1), dry_run: true });
    expect(r.dry_run).toBe(true);
    expect(r.quote_total).toBe(75);
    expect(r.order_total).toBe(40); // 3 × 10 + 1 × 10 con el precio fijo de la prueba
    expect(r.sin_producto).toEqual(['paletas de tamarindo']);
    expect(await pedidosDe()).toEqual([]);
    const q = await trx('commercial.quotes').where({ id: ids['Q'] }).first('status', 'order_id');
    expect(q).toEqual({ status: 'draft', order_id: null });
  });

  it('pasar a venta: pedido confirmado con el día elegido, sin el regalo; la cotización aceptada y ligada', async () => {
    const r = await pasar(ids['Q'], { requested_delivery_date: DIA(2) });
    expect(r.ya_existia).toBe(false);
    const o = await trx('commercial.orders').where({ id: r.order_id })
      .first('status', 'user_id', trx.raw(`to_char(requested_delivery_date, 'YYYY-MM-DD') AS dia`));
    expect(o).toEqual({ status: 'confirmed', user_id: ids['yo'], dia: DIA(2) });
    const ls = await trx('commercial.order_lines').where({ order_id: r.order_id }).orderBy('line_number').select('product_id', 'quantity');
    expect(ls.map((l) => [l.product_id, Number(l.quantity)])).toEqual([[ids['gomitas'], 3], [ids['chicle'], 1]]);
    const q = await trx('commercial.quotes').where({ id: ids['Q'] }).first('status', 'order_id', 'accepted_at');
    expect(q.status).toBe('accepted');
    expect(q.order_id).toBe(r.order_id);
    expect(q.accepted_at).not.toBeNull();
  });

  it('el segundo toque devuelve EL MISMO pedido y no hace otro', async () => {
    const antes = (await pedidosDe()).length;
    const r = await pasar(ids['Q'], { requested_delivery_date: DIA(3) });
    expect(r.ya_existia).toBe(true);
    expect(r.requested_delivery_date).toBe(DIA(2)); // el día del pedido que ya existía, no el nuevo
    expect((await pedidosDe()).length).toBe(antes);
  });

  it('negativas: de otro vendedor 403, de telemarketing 409, fecha pasada 400 — y nada escrito', async () => {
    const antes = (await pedidosDe()).length;
    expect(await status(() => pasar(ids['QOTRO'], { requested_delivery_date: DIA(1) }))).toBe(403);
    expect(await status(() => pasar(ids['QTLMK'], { requested_delivery_date: DIA(1) }))).toBe(409);
    expect(await status(() => pasar(ids['QOTRO'], { requested_delivery_date: DIA(-1) }))).toBe(400);
    expect((await pedidosDe()).length).toBe(antes);
    const qs = await trx('commercial.quotes').whereIn('id', [ids['QOTRO'], ids['QTLMK']]).pluck('status');
    expect(qs).toEqual(['draft', 'draft']);
  });
});
