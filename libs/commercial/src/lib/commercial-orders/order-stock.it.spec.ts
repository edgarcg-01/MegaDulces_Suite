/**
 * `[CANON.7.4b]` Prueba de INTEGRACIÓN de `OrderStockService` —el código REAL que aparta, entrega y libera— contra
 * Postgres real, como `app_runtime` (RLS y grants de verdad). Regla 13: un camino que escribe no está probado hasta
 * ejercerlo contra una base real.
 *
 * Lo que fija: la existencia sale del ODS (se siembra `kepler_ods.kdil`, SIN renglón en la copia `commercial.stock`),
 * el apartado sale del libro de movimientos, la copia no se toca, liberar topa en lo que apartó ESA referencia,
 * entregar o cancelar sacan al pedido del apartado sin escribir nada, y el candado es por (almacén, producto).
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`). Sin la
 * variable se salta y lo DICE. TODO dentro de una transacción que se revierte; cada intento que debe fallar va en su
 * propio SAVEPOINT.
 */
import knexFactory, { type Knex } from 'knex';
import { OrderStockService } from './order-stock.service';
import {
  EXISTENCIA_ODS_CON_APARTADO_SQL,
  existenciaYApartado,
} from '../commercial-inventory/stock-state';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const SUC = '97';
const SKU = 'IT74B01';
const SKU2 = 'IT74B02';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[CANON.7.4b] NO MEDIDO: sin TP_IT_DB la prueba de integración de los pedidos no corre.');

/** El código HTTP de la excepción de Nest (o el código SQL) de lo que falló dentro de un SAVEPOINT; 200 si NO falló. */
async function status(trx: Knex.Transaction, fn: (sp: Knex.Transaction) => Promise<unknown>): Promise<number | string> {
  try {
    await trx.transaction(async (sp) => { await fn(sp); });
    return 200;
  } catch (e) {
    const x = e as { getStatus?: () => number; code?: string; message: string };
    return typeof x.getStatus === 'function' ? x.getStatus() : (x.code ?? x.message);
  }
}

suite('[CANON.7.4b] apartar, entregar y liberar: ODS + libro de movimientos, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let otra: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};
  let user = '';
  const svc = new OrderStockService({ get: () => ({ userId: user }) } as never);

  const pedido = async (code: string, status = 'draft'): Promise<string> => {
    const [o] = await trx('commercial.orders')
      .insert({ tenant_id: M, code, customer_id: ids['cliente'], user_id: user, warehouse_id: ids['w'], status })
      .returning('id');
    return o.id;
  };
  const movs = (ref: string) =>
    trx('commercial.stock_movements').where({ reference_id: ref }).orderBy('created_at').select('movement_type', 'quantity');
  const copia = async () =>
    Number((await trx('commercial.stock').where({ warehouse_id: ids['w'] }).count<{ n: string }[]>({ n: '*' }))[0].n);
  const ea = (p = ids['p']) => existenciaYApartado(trx, ids['w'], p);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    otra = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    // ── Siembra, como el dueño ──────────────────────────────────────────────────────────────────────
    user = (await trx('public.users').where({ tenant_id: M }).first('id')).id;
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: `IT-${SUC}`, name: 'IT 7.4b almacén', kepler_code: SUC }).returning('id');
    ids['w'] = w.id;
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT 7.4b marca' }).returning('id');
    // p: el de casi todas las pruebas · p2: sin existencia · pr/pc/pl: uno por operación para la prueba del candado
    // (cada una toca SÓLO su producto, para que el candado que tomó otra operación no la tape).
    const productos = [['p', SKU, 10], ['p2', SKU2, 0], ['pr', 'IT74B0R', 5], ['pc', 'IT74B0C', 5], ['pl', 'IT74B0L', 5]] as const;
    for (const [k, sku] of productos) {
      const [p] = await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre: `IT 7.4b ${sku}`, sku }).returning('id');
      ids[k] = p.id;
    }
    const [c] = await trx('commercial.customers').insert({ tenant_id: M, code: 'IT74B', name: 'IT 7.4b cliente' }).returning('id');
    ids['cliente'] = c.id;
    // La existencia de Kepler. Ningún renglón en la copia.
    for (const [, sku, qty] of productos) {
      await trx.raw(`INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, ?, ?, 0, 0, now(), now())`, [SUC, SUC, sku, qty]);
    }
    // ── De aquí en adelante, como la app ────────────────────────────────────────────────────────────
    await trx.raw('SET LOCAL ROLE app_runtime');
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
    if (otra) await otra.destroy();
  });

  it('control: la vista ve las 10 piezas de Kepler y la copia NO tiene renglón', async () => {
    expect(await ea()).toEqual({ existencia: 10, apartado: 0 });
    expect(await copia()).toBe(0);
  });

  it('aparta contra el ODS aunque la copia no tenga renglón (antes: 409 «no existe registro de stock»), y no la toca', async () => {
    ids['A'] = await pedido('IT74B-A');
    expect(await status(trx, (sp) => svc.reserve(sp, ids['w'], ids['p'], 6, ids['A']))).toBe(200);
    expect(await movs(ids['A'])).toEqual([{ movement_type: 'reserve', quantity: '6.000' }]);
    expect(await ea()).toEqual({ existencia: 10, apartado: 6 });
    expect(await copia()).toBe(0);
  });

  it('NEGATIVA: no se aparta más de lo disponible (10 − 6 = 4 < 5) y no queda nada escrito', async () => {
    ids['B'] = await pedido('IT74B-B');
    expect(await status(trx, (sp) => svc.reserve(sp, ids['w'], ids['p'], 5, ids['B']))).toBe(409);
    expect(await movs(ids['B'])).toEqual([]);
    expect(await status(trx, (sp) => svc.reserve(sp, ids['w'], ids['p'], 4, ids['B']))).toBe(200);
    expect(await ea()).toEqual({ existencia: 10, apartado: 10 });
  });

  it('NEGATIVA: sin existencia en Kepler no se aparta (la vista da 0)', async () => {
    expect(await status(trx, (sp) => svc.reserve(sp, ids['w'], ids['p2'], 1, ids['B']))).toBe(409);
  });

  it('dos renglones del mismo producto en el pedido que se está confirmando (aún en draft) se validan juntos', async () => {
    ids['C'] = await pedido('IT74B-C');
    expect(await status(trx, (sp) => svc.reserve(sp, ids['w'], ids['p'], 1, ids['C']))).toBe(409);
  });

  it('la existencia con apartado (portada de Almacén, detalle de pedido) dice lo mismo que valida reserve()', async () => {
    const { rows } = await trx.raw(
      `SELECT s.quantity::float8 AS q, s.reserved_quantity::float8 AS r FROM ${EXISTENCIA_ODS_CON_APARTADO_SQL} s
        WHERE s.warehouse_id = ANY(?::uuid[]) AND s.product_id = ANY(?::uuid[])`,
      [[ids['w']], [ids['p']]],
    );
    expect(rows).toEqual([{ q: 10, r: 10 }]);
  });

  it('liberar topa en lo que ESA referencia apartó: B libera 4 aunque pida 100; C, que no apartó, no libera lo de A', async () => {
    await svc.release(trx, ids['w'], ids['p'], 100, ids['B']);
    expect((await movs(ids['B'])).at(-1)).toEqual({ movement_type: 'release', quantity: '4.000' });
    await svc.release(trx, ids['w'], ids['p'], 5, ids['C']);
    expect(await movs(ids['C'])).toEqual([{ movement_type: 'release', quantity: '0.000' }]);
    expect(await ea()).toEqual({ existencia: 10, apartado: 6 });
  });

  it('cancelar o entregar saca al pedido del apartado sin escribir ningún movimiento más', async () => {
    await trx('commercial.orders').where({ id: ids['A'] }).update({ status: 'cancelled' });
    expect(await ea()).toEqual({ existencia: 10, apartado: 0 });
    ids['E'] = await pedido('IT74B-E');
    await svc.reserve(trx, ids['w'], ids['p'], 3, ids['E']);
    expect((await ea()).apartado).toBe(3);
    await trx('commercial.orders').where({ id: ids['E'] }).update({ status: 'fulfilled' });
    expect((await ea()).apartado).toBe(0);
  });

  it('entregar valida contra el ODS (NEGATIVA: 11 > 10), escribe la venta y no resta nada en ningún lado', async () => {
    ids['D'] = await pedido('IT74B-D', 'confirmed');
    expect(await status(trx, (sp) => svc.consume(sp, ids['w'], ids['p'], 11, ids['D']))).toBe(409);
    let r: { expiredConsumed: number } | undefined;
    expect(await status(trx, async (sp) => { r = await svc.consume(sp, ids['w'], ids['p'], 10, ids['D']); })).toBe(200);
    expect(r).toEqual({ expiredConsumed: 0 }); // sin lotes, no se avisa «vendido vencido»
    expect(await movs(ids['D'])).toEqual([{ movement_type: 'sale', quantity: '10.000' }]);
    expect(await ea()).toEqual({ existencia: 10, apartado: 0 }); // la venta la descuenta Kepler, no la Suite
    expect(await copia()).toBe(0);
  });

  it('la reserva del bot cuenta mientras esté viva y deja de contar al liberarse', async () => {
    const [res] = await trx('commercial.stock_reservations')
      .insert({ tenant_id: M, folio: 'IT74B-R1', phone: '5200000000', warehouse_id: ids['w'], expires_at: trx.raw(`now() + interval '1 hour'`) })
      .returning('id');
    await svc.reserve(trx, ids['w'], ids['p'], 2, res.id, 'reservation');
    expect((await ea()).apartado).toBe(2);
    await trx('commercial.stock_reservations').where({ id: res.id }).update({ released_at: trx.fn.now() });
    expect((await ea()).apartado).toBe(0);
  });

  it('el candado es por (almacén, producto): otra conexión no lo toma mientras dura la transacción; otro producto sí', async () => {
    const llave = (p: string) => `existencia:${ids['w']}:${p}`;
    const intenta = async (p: string) => {
      const t = await otra.transaction();
      try {
        return (await t.raw('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS ok', [llave(p)])).rows[0].ok as boolean;
      } finally {
        await t.rollback();
      }
    };
    // Control: antes de tocarlos, los tres productos están libres; la llave es por producto.
    for (const k of ['pr', 'pc', 'pl']) expect(await intenta(ids[k]), k).toBe(true);
    ids['L'] = await pedido('IT74B-L', 'confirmed');
    // Cada operación toca SÓLO su producto: si una no toma el candado, su producto sigue libre.
    await svc.reserve(trx, ids['w'], ids['pr'], 1, ids['L']);
    expect(await intenta(ids['pr']), 'reserve()').toBe(false);
    await svc.consume(trx, ids['w'], ids['pc'], 1, ids['L']);
    expect(await intenta(ids['pc']), 'consume()').toBe(false);
    await svc.release(trx, ids['w'], ids['pl'], 1, ids['L']);
    expect(await intenta(ids['pl']), 'release()').toBe(false);
    expect(await intenta('00000000-0000-0000-0000-0000000074b0')).toBe(true);
  });
});
