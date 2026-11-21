/**
 * `[CANON.7.4c]` Prueba de INTEGRACIÓN de `lotes-declarados.ts` —lo que hace la captura de caducidades (`feedLine` /
 * `unfeedLine` de `commercial-expiry-reviews.service.ts`)— contra Postgres real, como `app_runtime`, con la existencia
 * de Kepler sembrada en `kepler_ods.kdil` y SIN renglón en la copia `commercial.stock` (el caso del CEDIS, que hoy no
 * declara nada). Fija: se declara hasta lo libre (existencia − lo declarado), nunca se toca ni se crea el `NA`, retirar
 * se niega si el lote ya no lo tiene, y el candado es el MISMO que el del disparador de `kdil`.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`).
 */
import knexFactory, { type Knex } from 'knex';
import { declararCaducidad, retirarCaducidad, saldoDeLotes } from './lotes-declarados';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const SUC = '90';
const FECHA = '2027-01-15';

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[CANON.7.4c] NO MEDIDO: sin TP_IT_DB la prueba de declarar caducidades no corre.');

/** El código HTTP de la excepción de Nest de lo que falló dentro de un SAVEPOINT; 200 si NO falló. */
async function status(trx: Knex.Transaction, fn: (sp: Knex.Transaction) => Promise<unknown>): Promise<number | string> {
  try {
    await trx.transaction(async (sp) => { await fn(sp); });
    return 200;
  } catch (e) {
    const x = e as { getStatus?: () => number; code?: string; message: string };
    return typeof x.getStatus === 'function' ? x.getStatus() : (x.code ?? x.message);
  }
}

suite('[CANON.7.4c] declarar y retirar caducidades sin la copia, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let otra: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};
  const lotes = async () =>
    Object.fromEntries(
      (await trx('commercial.stock_lots').where({ warehouse_id: ids['w'], product_id: ids['p'] }).select('lot_code', 'quantity'))
        .map((l: { lot_code: string; quantity: string }) => [l.lot_code, Number(l.quantity)]),
    );
  const declarar = (cantidad: number, t: Knex.Transaction = trx) =>
    declararCaducidad(t, { warehouseId: ids['w'], productId: ids['p'], expiryYmd: FECHA, cantidad });

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    otra = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: `IT-${SUC}`, name: 'IT 7.4c caducidades', kepler_code: SUC }).returning('id');
    ids['w'] = w.id;
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT 7.4c marca cad' }).returning('id');
    const [p] = await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre: 'IT 7.4c caducidad', sku: 'IT74CCAD' }).returning('id');
    ids['p'] = p.id;
    await trx.raw(`INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, 'IT74CCAD', 10, 0, 0, now(), now())`, [SUC, SUC]);
    // Un NA guardado que MIENTE (lo dejaba la copia): no se lee ni se toca.
    await trx('commercial.stock_lots').insert({ tenant_id: M, warehouse_id: ids['w'], product_id: ids['p'], lot_code: 'NA', expiry_date: null, quantity: 500, reserved_quantity: 0 });
    await trx.raw('SET LOCAL ROLE app_runtime');
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
    if (otra) await otra.destroy();
  });

  it('control: 10 de Kepler, nada declarado, sin renglón en la copia', async () => {
    expect(await saldoDeLotes(trx, ids['w'], ids['p'])).toEqual({ existencia: 10, declarado: 0, libre: 10 });
    expect(Number((await trx('commercial.stock').where({ warehouse_id: ids['w'], product_id: ids['p'] }).count({ n: '*' }))[0].n)).toBe(0);
  });

  it('declara aunque la copia no tenga renglón (antes: 0) y no toca el NA guardado (500, mentira)', async () => {
    expect(await declarar(6)).toBe(6);
    expect(await lotes()).toEqual({ [`EXP-${FECHA}`]: 6, NA: 500 });
    expect(await saldoDeLotes(trx, ids['w'], ids['p'])).toEqual({ existencia: 10, declarado: 6, libre: 4 });
  });

  it('NEGATIVA: no declara más de lo libre (pide 10, quedan 4) y con nada libre no declara', async () => {
    expect(await declarar(10)).toBe(4);
    expect(await declarar(5)).toBe(0);
    expect(await lotes()).toEqual({ [`EXP-${FECHA}`]: 10, NA: 500 });
  });

  it('retirar baja el lote y lo devuelve a lo libre; NEGATIVA: si el lote ya no lo tiene, 409 y no cambia nada', async () => {
    expect(await status(trx, (sp) => retirarCaducidad(sp, { warehouseId: ids['w'], productId: ids['p'], expiryYmd: FECHA, cantidad: 3 }))).toBe(200);
    expect(await lotes()).toEqual({ [`EXP-${FECHA}`]: 7, NA: 500 });
    expect((await saldoDeLotes(trx, ids['w'], ids['p'])).libre).toBe(3);
    expect(await status(trx, (sp) => retirarCaducidad(sp, { warehouseId: ids['w'], productId: ids['p'], expiryYmd: FECHA, cantidad: 100 }))).toBe(409);
    expect(await lotes()).toEqual({ [`EXP-${FECHA}`]: 7, NA: 500 });
  });

  it('el candado es el MISMO que el del disparador de kdil (consumir_lotes_por_existencia)', async () => {
    const intenta = async (llave: string) => {
      const t = await otra.transaction();
      try {
        return (await t.raw('SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0)) AS ok', [llave])).rows[0].ok as boolean;
      } finally {
        await t.rollback();
      }
    };
    // El texto de la llave de la función SQL de la migración 20261120150025: 'lotes:' || almacén || ':' || producto.
    expect(await intenta(`lotes:${ids['w']}:${ids['p']}`)).toBe(false);
    expect(await intenta(`lotes:${ids['w']}:00000000-0000-0000-0000-0000000074c0`)).toBe(true); // control
  });
});
