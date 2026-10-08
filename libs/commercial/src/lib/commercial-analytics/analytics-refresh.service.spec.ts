import type { Knex } from 'knex';
import { AnalyticsRefreshService } from './analytics-refresh.service';

/**
 * `[NP.13]` — **Algunas matvistas se refrescan con el JIT de Postgres apagado.**
 *
 * Postgres compila (JIT) una consulta cuando su costo ESTIMADO pasa de `jit_above_cost`, y en
 * `mv_new_products` las estimaciones infladas lo disparaban: medido en local, **4.8 s con JIT
 * contra 70 ms sin él**, mismo resultado. El apagado va con `SET LOCAL` dentro de una
 * transacción para que valga SÓLO para ese REFRESH: un `SET jit = off` suelto quedaría pegado a
 * la conexión del pool y apagaría el JIT de todo lo que la use después.
 *
 * ⚠️ Esto NO ejecuta SQL: comprueba qué sentencias se mandan y en qué orden. Que el REFRESH sin
 * JIT funcione dentro de una transacción (también CONCURRENTLY) se verificó contra Postgres 18
 * local; la matvista la cubre `database/tests/test-newdb-new-products.js`.
 */

/** Un knex falso que anota cada sentencia y si iba dentro de una transacción. */
function knexFalso() {
  const sentencias: string[] = [];
  let dentro = 0;
  const raw = async (sql: string) => {
    sentencias.push(`${dentro ? '[trx] ' : ''}${sql}`);
    return { rows: [] };
  };
  const k = {
    raw,
    transaction: async (fn: (trx: { raw: typeof raw }) => Promise<unknown>) => {
      dentro += 1;
      try {
        return await fn({ raw });
      } finally {
        dentro -= 1;
      }
    },
  } as unknown as Knex;
  return { k, sentencias };
}

type ConRefresco = { refrescarMv(admin: Knex, mv: string, concurrently: string): Promise<void> };

describe('[NP.13] REFRESH sin JIT', () => {
  it('mv_new_products: SET LOCAL jit = off y el REFRESH en la MISMA transacción', async () => {
    const { k, sentencias } = knexFalso();
    const svc = new AnalyticsRefreshService(k) as unknown as ConRefresco;
    await svc.refrescarMv(k, 'analytics.mv_new_products', 'CONCURRENTLY ');
    expect(sentencias).toEqual([
      '[trx] SET LOCAL jit = off',
      '[trx] REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_new_products',
    ]);
  });

  it('el primer poblado (sin CONCURRENTLY) también va sin JIT', async () => {
    const { k, sentencias } = knexFalso();
    const svc = new AnalyticsRefreshService(k) as unknown as ConRefresco;
    await svc.refrescarMv(k, 'analytics.mv_new_products', '');
    expect(sentencias).toEqual([
      '[trx] SET LOCAL jit = off',
      '[trx] REFRESH MATERIALIZED VIEW analytics.mv_new_products',
    ]);
  });

  it('[negativa] las demás matvistas se refrescan como siempre: sin transacción ni cambio de JIT', async () => {
    const { k, sentencias } = knexFalso();
    const svc = new AnalyticsRefreshService(k) as unknown as ConRefresco;
    await svc.refrescarMv(k, 'analytics.mv_kepler_sales_daily', 'CONCURRENTLY ');
    expect(sentencias).toEqual(['REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_kepler_sales_daily']);
    expect(sentencias.some((s) => /jit/i.test(s))).toBe(false);
  });
});
