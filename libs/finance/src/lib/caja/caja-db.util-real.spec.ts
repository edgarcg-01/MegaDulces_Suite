import knexFactory, { Knex } from 'knex';
import { relacionExiste } from './caja-db.util';

/**
 * `[CGP-L.6]` Por qué no se lee «a ver si existe» dentro de un `try/catch` en una transacción, y que
 * `relacionExiste` no tiene ese problema. Contra una base REAL: el aborto es de Postgres, un doble no
 * lo reproduce.
 */
const URL = process.env.CAJA_TEST_DB_URL;
if (!URL) {
  // eslint-disable-next-line no-console
  console.warn('[CGP-L.6] NO MEDIDO: sin CAJA_TEST_DB_URL no hay base contra la cual probar el aborto de la transacción.');
}

describe.skipIf(!URL)('[CGP-L.6] leer algo que puede no existir, dentro de una transacción', () => {
  let knex: Knex;
  beforeAll(() => { knex = knexFactory({ client: 'pg', connection: URL as string, pool: { min: 0, max: 2 } }); });
  afterAll(async () => { await knex?.destroy(); });

  it('⛔ [el defecto] un catch vacío deja la transacción abortada y la consulta siguiente revienta (25P02)', async () => {
    await expect(knex.transaction(async (trx) => {
      try { await trx.raw('SELECT * FROM analytics.no_existe_cgp_l6'); } catch { /* lo que hacía el código */ }
      await trx.raw('SELECT 1');
    })).rejects.toMatchObject({ code: '25P02' });
  });

  it('preguntar primero no aborta nada: la consulta siguiente funciona', async () => {
    const r = await knex.transaction(async (trx) => {
      const existe = await relacionExiste(trx, 'analytics.no_existe_cgp_l6');
      const uno = await trx.raw('SELECT 1 AS uno');
      return { existe, uno: uno.rows[0].uno };
    });
    expect(r).toEqual({ existe: false, uno: 1 });
  });

  it('y una que sí existe, existe', async () => {
    expect(await relacionExiste(knex, 'finance.cash_ledger')).toBe(true);
  });
});
