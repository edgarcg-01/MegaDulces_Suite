import type { Knex } from 'knex';
import { AnalyticsRefreshService } from './analytics-refresh.service';

/**
 * `[NP.13]`/`[NP.14]` — **Algunas matvistas se refrescan con ajustes propios**, y una matvista
 * vacía no espera su cadencia.
 *
 *  · Sin JIT (`[NP.13]`): en `mv_new_products` las estimaciones infladas disparaban la compilación
 *    JIT. Medido en local, **4.8 s con JIT contra 70 ms sin él**, mismo resultado.
 *  · Con tope de tiempo (`[NP.14]`): su primer poblado en prod corrió más de 9 min con un plan
 *    cuadrático, y mientras tanto el ciclo de 15 min no refrescó ninguna otra matvista.
 *
 * Los ajustes van con `SET LOCAL` dentro de una transacción para que valgan SÓLO para ese REFRESH:
 * un `SET` suelto quedaría pegado a la conexión del pool y afectaría a todo lo que la use después.
 *
 * ⚠️ Esto NO ejecuta SQL: comprueba qué sentencias se mandan y en qué orden. Que el REFRESH con
 * esos ajustes funcione dentro de una transacción (también CONCURRENTLY) se verificó contra
 * Postgres 18 local; la matvista la cubre `database/tests/test-newdb-new-products.js`.
 */

type Fila = Record<string, unknown>;

/**
 * Un knex falso que anota cada sentencia, si iba dentro de una transacción, y responde las
 * consultas a `pg_class`. `vacias` = las matvistas que nacieron `WITH NO DATA` y nadie pobló.
 */
function knexFalso(vacias: string[] = []) {
  const sentencias: string[] = [];
  let dentro = 0;
  const raw = async (sql: string, binds?: unknown[]): Promise<{ rows: Fila[] }> => {
    sentencias.push(`${dentro ? '[trx] ' : ''}${sql}`);
    if (/FROM pg_class/.test(sql)) {
      const mv = String(binds?.[0]);
      return { rows: [{ relkind: 'm', relispopulated: !vacias.includes(mv) }] };
    }
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
  const refrescos = (): string[] => sentencias.filter((s) => s.includes('REFRESH MATERIALIZED VIEW'));
  return { k, sentencias, refrescos };
}

type ConRefresco = { refrescarMv(admin: Knex, mv: string, concurrently: string): Promise<void> };

const NUEVOS = 'analytics.mv_new_products';
/** Otra matvista de `everyMin: 30`, para comprobar que la cadencia sigue mandando sobre las pobladas. */
const OTRA_DE_30 = 'analytics.mv_rd_route_daily_200d';

describe('[NP.13][NP.14] REFRESH con ajustes propios', () => {
  it('mv_new_products: sin JIT, con tope de tiempo, y el REFRESH en la MISMA transacción', async () => {
    const { k, sentencias } = knexFalso();
    const svc = new AnalyticsRefreshService(k) as unknown as ConRefresco;
    await svc.refrescarMv(k, NUEVOS, 'CONCURRENTLY ');
    expect(sentencias).toEqual([
      '[trx] SET LOCAL jit = off',
      "[trx] SET LOCAL statement_timeout = '180s'",
      `[trx] REFRESH MATERIALIZED VIEW CONCURRENTLY ${NUEVOS}`,
    ]);
  });

  it('el primer poblado (sin CONCURRENTLY) también lleva los ajustes', async () => {
    const { k, sentencias } = knexFalso();
    const svc = new AnalyticsRefreshService(k) as unknown as ConRefresco;
    await svc.refrescarMv(k, NUEVOS, '');
    expect(sentencias).toEqual([
      '[trx] SET LOCAL jit = off',
      "[trx] SET LOCAL statement_timeout = '180s'",
      `[trx] REFRESH MATERIALIZED VIEW ${NUEVOS}`,
    ]);
  });

  it('[negativa] las demás matvistas se refrescan como siempre: sin transacción ni ajustes', async () => {
    const { k, sentencias } = knexFalso();
    const svc = new AnalyticsRefreshService(k) as unknown as ConRefresco;
    await svc.refrescarMv(k, 'analytics.mv_kepler_sales_daily', 'CONCURRENTLY ');
    expect(sentencias).toEqual(['REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_kepler_sales_daily']);
    expect(sentencias.some((s) => /jit|statement_timeout/i.test(s))).toBe(false);
  });
});

describe('[NP.14] una matvista VACÍA no espera su cadencia', () => {
  // 11:20 = fuera del turno de las de `everyMin: 30` (sólo tocan en :00-:14 y :30-:44).
  const fueraDeTurno = new Date(2026, 9, 8, 11, 20, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fueraDeTurno);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('vacía: se puebla en el tick aunque no le toque, y sin CONCURRENTLY', async () => {
    const { k, refrescos } = knexFalso([NUEVOS]);
    await new AnalyticsRefreshService(k).refreshAll('cron');
    expect(refrescos()).toContain(`[trx] REFRESH MATERIALIZED VIEW ${NUEVOS}`);
    // La cadencia sigue mandando sobre las pobladas: la otra de 30 min no se toca a las 11:20.
    expect(refrescos().some((s) => s.includes(OTRA_DE_30))).toBe(false);
  });

  it('[negativa] poblada: a las 11:20 no le toca y no se refresca', async () => {
    const { k, refrescos } = knexFalso();
    await new AnalyticsRefreshService(k).refreshAll('cron');
    expect(refrescos().some((s) => s.includes(NUEVOS))).toBe(false);
  });
});
