/**
 * `[CANON.7.4c]` Prueba de INTEGRACIÓN de la migración `20261120150025_canon74c_lotes_fefo_por_evento_del_ods`: el
 * consumo FEFO de los lotes declarados pasa del disparador de la COPIA al evento del ODS (`kepler_ods.kdil`).
 *
 * Contra Postgres real, con la migración aplicada DENTRO de una transacción que se revierte. Fija:
 *  - apagado (como nace), cambiar `kdil` no toca ningún lote;
 *  - prendido, si la existencia de Kepler baja de lo declarado, consume FEFO (lo no vencido primero, caducidad
 *    ascendente) y lo escribe en la bitácora; si la existencia vuelve a subir, el lote NO revive;
 *  - un DELETE de `kdil` no consume (puede ser pasajero);
 *  - un producto sin lote declarado no se toca;
 *  - un error del consumo no frena la escritura de la ingesta: queda en `analytics.llaves_sucias_errores`;
 *  - prendido, el disparador de la copia ya no toca los lotes;
 *  - `down` deja el disparador de la copia EXACTAMENTE como estaba.
 *
 * ⛔ Sólo corre con `TP_IT_DB` apuntando a una base LOCAL que NO sea prod (se compara el `system_identifier`).
 */
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import knexFactory, { type Knex } from 'knex';

const URL = process.env.TP_IT_DB ?? '';
const PROD_SYSTEM_ID = '7688376744939610156';
const M = '00000000-0000-0000-0000-00000000d01c';
const SUC = '91';
const MIG = resolvePath(__dirname, '../../../../../database/migrations-newdb/20261120150025_canon74c_lotes_fefo_por_evento_del_ods.js');
type Mig = { up: (k: Knex) => Promise<void>; down: (k: Knex) => Promise<void> };
const mig = (): Mig => createRequire(__filename)(MIG) as Mig;

const local = /@(localhost|127\.0\.0\.1):\d+\//.test(URL);
const suite = URL && local ? describe : describe.skip;
if (!URL) console.log('[CANON.7.4c] NO MEDIDO: sin TP_IT_DB la prueba de la migración de lotes no corre.');

suite('[CANON.7.4c] lotes FEFO por evento del ODS, contra Postgres real (transacción revertida)', () => {
  let knex: Knex;
  let trx: Knex.Transaction;
  const ids: Record<string, string> = {};
  let rebalanceAntes = '';

  const lotes = async (p = ids['p']) =>
    Object.fromEntries(
      (await trx('commercial.stock_lots').where({ warehouse_id: ids['w'], product_id: p }).orderBy('lot_code').select('lot_code', 'quantity'))
        .map((l: { lot_code: string; quantity: string }) => [l.lot_code, Number(l.quantity)]),
    );
  const existencia = (sku: string, qty: number) => trx.raw(`UPDATE kepler_ods.kdil SET c4 = ? WHERE sucursal = ? AND c3 = ?`, [qty, SUC, sku]);
  const prender = (on: boolean) => trx('commercial.lotes_fefo_por_evento').where({ tenant_id: M }).update({ encendida: on });
  const salidas = () => trx('commercial.stock_lot_movements').where({ warehouse_id: ids['w'], reference_type: 'kepler_existencia' })
    .orderBy('lot_code').select('lot_code', 'quantity');
  const fallas = async () => Number((await trx('analytics.llaves_sucias_errores').where('tabla', 'like', '%lotes FEFO%').count({ n: '*' }))[0].n);

  beforeAll(async () => {
    knex = knexFactory({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    const { rows } = await knex.raw('SELECT system_identifier::text AS id FROM pg_control_system()');
    if (rows[0].id === PROD_SYSTEM_ID) throw new Error('TP_IT_DB es PRODUCCIÓN. Me niego.');
    trx = await knex.transaction();
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [M]);
    rebalanceAntes = (await trx.raw(`SELECT pg_get_functiondef('commercial.fn_rebalance_stock_lots'::regproc) AS d`)).rows[0].d;
    await mig().up(trx);
    const [w] = await trx('commercial.warehouses').insert({ tenant_id: M, code: `IT-${SUC}`, name: 'IT 7.4c almacén', kepler_code: SUC }).returning('id');
    ids['w'] = w.id;
    const [b] = await trx('catalog.brands').insert({ tenant_id: M, nombre: 'IT 7.4c marca' }).returning('id');
    for (const [k, sku] of [['p', 'IT74C01'], ['q', 'IT74C02']] as const) {
      const [p] = await trx('catalog.products').insert({ tenant_id: M, brand_id: b.id, nombre: `IT 7.4c ${sku}`, sku }).returning('id');
      ids[k] = p.id;
      await trx.raw(`INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9, c6, c7) VALUES (?, ?, 0, ?, 20, 0, 0, now(), now())`, [SUC, SUC, sku]);
    }
    // Declarado: L1 vence en 30 días (4), L2 en 60 (5), L0 ya venció (3). Total 12 contra 20 de Kepler.
    await trx('commercial.stock_lots').insert([
      { tenant_id: M, warehouse_id: ids['w'], product_id: ids['p'], lot_code: 'L1', expiry_date: trx.raw(`CURRENT_DATE + 30`), quantity: 4, reserved_quantity: 0 },
      { tenant_id: M, warehouse_id: ids['w'], product_id: ids['p'], lot_code: 'L2', expiry_date: trx.raw(`CURRENT_DATE + 60`), quantity: 5, reserved_quantity: 0 },
      { tenant_id: M, warehouse_id: ids['w'], product_id: ids['p'], lot_code: 'L0', expiry_date: trx.raw(`CURRENT_DATE - 1`), quantity: 3, reserved_quantity: 0 },
    ]);
  }, 120_000);

  afterAll(async () => {
    if (trx && !trx.isCompleted()) await trx.rollback();
    if (knex) await knex.destroy();
  });

  it('nace APAGADO: bajar la existencia de Kepler no toca ningún lote', async () => {
    expect((await trx('commercial.lotes_fefo_por_evento').where({ tenant_id: M }).first()).encendida).toBe(false);
    await existencia('IT74C01', 6);
    expect(await lotes()).toEqual({ L0: 3, L1: 4, L2: 5 });
    await existencia('IT74C01', 20);
  });

  it('prendido: Kepler baja a 6 contra 12 declarados → consume 6, lo no vencido primero y por caducidad, y lo escribe', async () => {
    await prender(true);
    await existencia('IT74C01', 6);
    expect(await lotes()).toEqual({ L0: 3, L1: 0, L2: 3 });
    expect((await salidas()).map((s: { lot_code: string; quantity: string }) => [s.lot_code, Number(s.quantity)])).toEqual([['L1', 4], ['L2', 2]]);
  });

  it('NEGATIVA: si la existencia vuelve a subir, el lote consumido NO revive', async () => {
    await existencia('IT74C01', 50);
    expect(await lotes()).toEqual({ L0: 3, L1: 0, L2: 3 });
  });

  it('NEGATIVA: un DELETE de kdil (puede ser pasajero) no consume nada', async () => {
    await trx.transaction(async (sp) => {
      await sp.raw(`DELETE FROM kepler_ods.kdil WHERE sucursal = ? AND c3 = 'IT74C01'`, [SUC]);
      expect(Object.values(await (async () => Object.fromEntries((await sp('commercial.stock_lots').where({ warehouse_id: ids['w'], product_id: ids['p'] }).select('lot_code', 'quantity')).map((l: { lot_code: string; quantity: string }) => [l.lot_code, Number(l.quantity)])))()).reduce((a, b) => a + b, 0)).toBe(6);
      throw new Error('revertir');
    }).catch(() => undefined);
  });

  it('un producto sin lote declarado no se toca (ni se le crea lote)', async () => {
    await existencia('IT74C02', 0);
    expect(await lotes(ids['q'])).toEqual({});
  });

  it('un error del consumo NO frena la escritura de la ingesta: queda escrito', async () => {
    const antes = await fallas();
    await trx.transaction(async (sp) => {
      await sp.raw(`CREATE OR REPLACE FUNCTION commercial.consumir_lotes_por_existencia(p_tenant uuid, p_warehouse uuid, p_product uuid)
        RETURNS numeric LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'IT 7.4c: falla a propósito'; END $$`);
      await sp.raw(`UPDATE kepler_ods.kdil SET c4 = 1 WHERE sucursal = ? AND c3 = 'IT74C01'`, [SUC]); // no truena
      const ahora = Number((await sp('analytics.llaves_sucias_errores').where('tabla', 'like', '%lotes FEFO%').count({ n: '*' }))[0].n);
      expect(ahora).toBe(antes + 1);
      throw new Error('revertir');
    }).catch((e) => { if (!/revertir/.test(String(e))) throw e; });
    expect(await fallas()).toBe(antes);
  });

  it('prendido, el disparador de la COPIA ya no toca los lotes (ni crea el NA)', async () => {
    await trx('commercial.stock').insert({ tenant_id: M, warehouse_id: ids['w'], product_id: ids['p'], quantity: 1, reserved_quantity: 0 });
    expect(await lotes()).toEqual({ L0: 3, L1: 0, L2: 3 });
  });

  it('control: apagado, el de la copia vuelve a hacer lo de antes (con la copia en 2 contra 6 declarados, consume 4)', async () => {
    await prender(false);
    await trx('commercial.stock').where({ warehouse_id: ids['w'], product_id: ids['p'] }).update({ quantity: 2 });
    // Lo bueno primero (L2: 3), luego lo vencido (L0: 3 → 2). En esta rama el de la copia no crea el NA (sólo lo pone en 0).
    expect(await lotes()).toEqual({ L0: 2, L1: 0, L2: 0 });
  });

  it('down deja el disparador de la copia EXACTAMENTE como estaba, y up es idempotente', async () => {
    await trx.transaction(async (sp) => {
      await mig().up(sp);
      await mig().down(sp);
      const despues = (await sp.raw(`SELECT pg_get_functiondef('commercial.fn_rebalance_stock_lots'::regproc) AS d`)).rows[0].d;
      expect(despues).toBe(rebalanceAntes);
      expect((await sp.raw(`SELECT count(*)::int n FROM pg_trigger WHERE tgname LIKE 'tg_kdil_lotes_fefo%'`)).rows[0].n).toBe(0);
      expect((await sp.raw(`SELECT to_regclass('commercial.ix_stock_lots_declarados') AS r`)).rows[0].r).toBeNull();
      throw new Error('revertir');
    }).catch((e) => { if (!/revertir/.test(String(e))) throw e; });
  });
});
